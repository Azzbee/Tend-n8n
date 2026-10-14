import { describe, expect, it } from "vitest";
import { createLiveServer } from "../src/live-api.ts";
import { InternalAuth, verificationHash } from "../src/internal-auth.ts";
import { TendStore } from "../src/engine.ts";
import { exampleLivePolicy as policy } from "../src/live-policy.ts";
import type { LiveRecord } from "../src/google-records.ts";

const key = "FICTIONAL_ONLY_0123456789_abcdefghijklmnopqrstuvwxyz_ABCD";
const clock = () => new Date("2026-10-14T12:00:00Z");
async function setup() {
  const store = new TendStore(":memory:", {
    mode: "live",
    principal: {
      owner_id: policy.principal_id,
      user_id: "live-owner",
      chat_id: "live-private",
    },
    clock,
  });
  const server = createLiveServer({
    policy,
    store,
    auth: new InternalAuth(undefined, verificationHash(key)),
    clock,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = {
    Authorization: "Bearer " + key,
    "Content-Type": "application/json",
  };
  await fetch(base + "/api/live/status", { headers });
  store.seed(
    [
      {
        owner_id: policy.principal_id,
        contact_id: "P1",
        name: "Fictional Person",
      },
    ],
    [
      {
        owner_id: policy.principal_id,
        contact_id: "P1",
        identity: "person@example.invalid",
      },
    ],
    [],
  );
  const text = "I'll send the notes by 2026-10-15.";
  const record: LiveRecord = {
    owner_id: policy.principal_id,
    source: "gmail",
    account_id: policy.account_email,
    source_record_id: "fictional-mail-1",
    source_thread_id: "fictional-thread",
    kind: "message",
    direction: "received",
    actor_identity: "person@example.invalid",
    participant_identities: [policy.account_email],
    occurred_at: "2026-10-14T08:00:00Z",
    observed_at: clock().toISOString(),
    body_text: text,
    authored_text: text,
    authored_spans: [{ start: 0, end: text.length, text }],
    contact_ids: ["P1"],
    attribution: "direct",
    eligible_for_extraction: true,
    evidence_reference: "https://example.invalid/mail/1",
    ingestion_mode: "live",
    coverage_start: "2026-09-14T12:00:00Z",
    coverage_end: clock().toISOString(),
    cancelled: false,
  };
  const normalized = store.ingest(record);
  const get = (path: string) => fetch(base + path, { headers });
  const post = (path: string, value: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers,
      body: JSON.stringify(value),
    });
  return {
    store,
    record,
    normalized,
    get,
    post,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      store.close();
    },
  };
}
describe("private AI evidence API", () => {
  it("binds one-time AI requests to exact current evidence", async () => {
    const x = await setup();
    try {
      const input = (await (
        await x.get("/api/live/ai/input?contact_id=P1&purpose=briefing")
      ).json()) as { request_id: string; eligible: boolean };
      expect(input.eligible).toBe(true);
      const output = {
        items: [
          {
            record_key: x.normalized.record_key,
            content_hash: x.normalized.content_hash,
            quote: x.record.body_text,
          },
        ],
      };
      const response = await x.post("/api/live/ai/validate", {
        request_id: input.request_id,
        output,
      });
      expect(await response.json()).toMatchObject({
        status: "validated",
        outbound_sent: false,
      });
      expect(
        (
          await x.post("/api/live/ai/validate", {
            request_id: input.request_id,
            output,
          })
        ).status,
      ).toBe(400);
    } finally {
      await x.close();
    }
  });
  it("does not retain a generated claim after a source edit and rejects stale promises", async () => {
    const x = await setup();
    try {
      const input = (await (
        await x.get("/api/live/ai/input?contact_id=P1&purpose=draft")
      ).json()) as { request_id: string };
      const text = "The notes are delayed.";
      x.store.ingest({
        ...x.record,
        body_text: text,
        authored_text: text,
        authored_spans: [{ start: 0, end: text.length, text }],
      });
      const response = await x.post("/api/live/ai/validate", {
        request_id: input.request_id,
        output: {
          items: [
            {
              record_key: x.normalized.record_key,
              content_hash: x.normalized.content_hash,
              quote: x.record.body_text,
            },
          ],
        },
      });
      expect(await response.json()).toMatchObject({
        status: "fallback",
        items: [],
        draft: null,
        outbound_sent: false,
      });
      expect(
        (
          await x.post("/api/live/candidates", {
            record_key: x.normalized.record_key,
            content_hash: x.normalized.content_hash,
            candidate: {
              quote: x.record.body_text,
              action: "send the notes",
              suggested_due: "2026-10-15",
            },
          })
        ).status,
      ).toBe(400);
    } finally {
      await x.close();
    }
  });
  it("selects contracted promises and requires expected content hash", async () => {
    const x = await setup();
    try {
      expect(await (await x.get("/api/live/model-input")).json()).toMatchObject(
        { eligible: true, content_hash: x.normalized.content_hash },
      );
      const candidate = {
        quote: x.record.body_text,
        action: "send the notes",
        suggested_due: "2026-10-15",
      };
      expect(
        (
          await x.post("/api/live/candidates", {
            record_key: x.normalized.record_key,
            candidate,
          })
        ).status,
      ).toBe(400);
      expect(
        await (
          await x.post("/api/live/candidates", {
            record_key: x.normalized.record_key,
            content_hash: x.normalized.content_hash,
            candidate,
          })
        ).json(),
      ).toMatchObject({ candidate: { status: "pending" } });
    } finally {
      await x.close();
    }
  });
});
