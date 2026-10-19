import { describe, expect, it } from "vitest";
import { createLiveServer } from "../src/live-api.ts";
import { InternalAuth, verificationHash } from "../src/internal-auth.ts";
import { TendStore } from "../src/engine.ts";
import {
  exampleLivePolicy as policy,
  parseLivePolicy,
  type LivePolicy,
} from "../src/live-policy.ts";
import type { LiveRecord } from "../src/google-records.ts";
import { normalizeUnipileMessage } from "../src/messaging-records.ts";

const key = "FICTIONAL_ONLY_0123456789_abcdefghijklmnopqrstuvwxyz_ABCD";
const clock = () => new Date("2026-10-14T12:00:00Z");
async function setup(inputPolicy: LivePolicy = policy) {
  const store = new TendStore(":memory:", {
    mode: "live",
    principal: {
      owner_id: inputPolicy.principal_id,
      user_id: "live-owner",
      chat_id: "live-private",
    },
    clock,
  });
  const server = createLiveServer({
    policy: inputPolicy,
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
        owner_id: inputPolicy.principal_id,
        contact_id: "P1",
        name: "Fictional Person",
      },
    ],
    [
      {
        owner_id: inputPolicy.principal_id,
        contact_id: "P1",
        identity: "person@example.invalid",
      },
    ],
    [],
  );
  const text = "I'll send the notes by 2026-10-15.";
  const record: LiveRecord = {
    owner_id: inputPolicy.principal_id,
    source: "gmail",
    account_id: inputPolicy.account_email,
    source_record_id: "fictional-mail-1",
    source_thread_id: "fictional-thread",
    kind: "message",
    direction: "received",
    actor_identity: "person@example.invalid",
    participant_identities: [inputPolicy.account_email],
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
    base,
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
  it("drops all pending draft memory during LinkedIn withdrawal", async () => {
    const x = await setup();
    try {
      const input = (await (
        await x.get("/api/live/ai/input?contact_id=P1&purpose=draft")
      ).json()) as { request_id: string };
      const response = await x.post("/api/live/linkedin-withdraw", {
        confirm: "REMOVE_ALL_LOCAL_LINKEDIN_EVIDENCE",
      });
      expect(response.status).toBe(200);
      expect(
        (
          await x.post("/api/live/ai/validate", {
            request_id: input.request_id,
            output: {},
          })
        ).status,
      ).toBe(400);
      expect(x.store.interactions(policy.principal_id)).toHaveLength(1);
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

function groupPolicy() {
  return parseLivePolicy({
    ...policy,
    social: {
      window_days: 30,
      accounts: [
        {
          source: "whatsapp_personal",
          provider: "unipile",
          account_id: "wa-one",
          owner_identity: "15550000001",
          owner_verified: true,
          api_base_url: "https://api1.unipile.com:13111",
        },
      ],
    },
    verified_contact_groups: [
      {
        id: "group:fictional",
        name: "Fictional Person",
        verified_at: "2026-10-14T10:00:00.000Z",
        proof_kind: "owner_confirmed",
        proof_reference: "owner-confirmation:fictional-message",
        members: [
          {
            contact_id: "P1",
            source: "gmail",
            account_id: policy.account_email,
            identity: "person@example.invalid",
          },
          {
            contact_id: "M1",
            source: "whatsapp_personal",
            account_id: "wa-one",
            identity: "unipile:wa-one:999999999@lid",
          },
        ],
      },
    ],
  });
}
async function setupGroup(p: LivePolicy) {
  const normalized = normalizeUnipileMessage(
    {
      id: "wa-message",
      account_id: "wa-one",
      chat_id: "fictional-chat",
      sender_id: "999999999@lid",
      is_sender: 0,
      attendees: [
        { attendee_provider_id: "15550000001" },
        {
          attendee_provider_id: "999999999@lid",
          attendee_name: "Fictional Person",
        },
      ],
      timestamp: "2026-10-14T08:00:00Z",
      text: "The WhatsApp notes are ready.",
    },
    {
      principal_id: p.principal_id,
      account_id: "wa-one",
      owner_identity: "15550000001",
      now: clock(),
      authenticated: { provider: "unipile", account_id: "wa-one" },
    },
    "whatsapp_personal",
  );
  if (normalized.kind !== "accepted")
    throw new Error("Fictional normalization failed");
  const member = p.verified_contact_groups![0]!.members[1]!;
  if (member.contact_id === "M1")
    member.contact_id = normalized.contacts[0]!.contact_id;
  const x = await setup(p);
  x.store.seed(normalized.contacts, normalized.identities, []);
  const wa = x.store.ingest(normalized.record);
  return { ...x, wa };
}
describe("protected verified group AI API", () => {
  it("combines exact owned channel evidence without changing contact IDs, hashes or candidates", async () => {
    const p = groupPolicy(),
      x = await setupGroup(p);
    try {
      expect(x.wa.actor_identity).toBe("unipile:wa-one:999999999@lid");
      expect(x.wa.contact_ids?.[0]).toMatch(/^M[a-f0-9]{64}$/);
      expect(p.verified_contact_groups?.[0]?.members[1]).toMatchObject({
        identity: x.wa.actor_identity,
        contact_id: x.wa.contact_ids?.[0],
      });
      const before = {
        records: x.store.interactions(p.principal_id),
        contacts: x.store.contacts(p.principal_id),
        commitments: x.store.commitments(p.principal_id),
      };
      expect(
        (
          await fetch(
            x.base +
              "/api/live/ai/input?contact_id=group:fictional&purpose=briefing",
          )
        ).status,
      ).toBe(401);
      const input = (await (
        await x.get(
          "/api/live/ai/input?contact_id=group:fictional&purpose=draft",
        )
      ).json()) as {
        eligible: boolean;
        request_id: string;
        evidence_count: number;
      };
      expect(input).toMatchObject({ eligible: true, evidence_count: 2 });
      const response = await x.post("/api/live/ai/validate", {
        request_id: input.request_id,
        output: {
          draft: {
            text: "Hi, what would be the best next step for the notes?",
          },
          items: [x.normalized, x.wa].map((r, i) => ({
            evidence_id: `E${i + 1}`,
            quote: r.body_text,
          })),
        },
      });
      expect(await response.json()).toMatchObject({
        status: "validated",
        items: [{ source: "gmail" }, { source: "whatsapp_personal" }],
        draft: { pending_review: true },
        outbound_sent: false,
      });
      expect({
        records: x.store.interactions(p.principal_id),
        contacts: x.store.contacts(p.principal_id),
        commitments: x.store.commitments(p.principal_id),
      }).toEqual(before);
    } finally {
      await x.close();
    }
  });
  it.each([
    "proof",
    "withdraw",
    "revoke",
    "identity",
    "future",
    "principal",
    "rename",
  ])("withdraws pending excerpts after %s changes", async (change) => {
    const p = groupPolicy(),
      x = await setupGroup(p);
    try {
      const input = (await (
        await x.get(
          "/api/live/ai/input?contact_id=group:fictional&purpose=draft",
        )
      ).json()) as { request_id: string };
      if (change === "proof")
        p.verified_contact_groups![0]!.proof_reference =
          "owner-confirmation:replacement";
      if (change === "withdraw") delete p.verified_contact_groups;
      if (change === "principal") p.principal_id = "changed-owner";
      if (change === "rename") {
        const contacts = x.store.contacts.bind(x.store);
        x.store.contacts = (owner, query) =>
          contacts(owner, query).map((contact) => ({
            ...contact,
            name: contact.name + " renamed",
          }));
      }
      if (change === "revoke")
        x.store.revokeSource(p.principal_id, "whatsapp_personal");
      if (change === "future")
        p.verified_contact_groups![0]!.verified_at = "2099-10-14T10:00:00.000Z";
      if (change === "identity") {
        const contacts = x.store.contacts.bind(x.store);
        x.store.contacts = (owner, query) =>
          contacts(owner, query).map((contact) =>
            contact.contact_id === x.wa.contact_ids?.[0]
              ? { ...contact, emails: [] }
              : contact,
          );
      }
      const response = await x.post("/api/live/ai/validate", {
        request_id: input.request_id,
        output: {
          items: [
            {
              record_key: x.wa.record_key,
              content_hash: x.wa.content_hash,
              quote: x.wa.body_text,
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
    } finally {
      await x.close();
    }
  });
  it("rejects unresolved or different exact identity bindings and client-supplied scopes", async () => {
    const p = groupPolicy();
    p.verified_contact_groups![0]!.members[1]!.contact_id = "P1";
    const x = await setupGroup(p);
    try {
      expect(
        (
          await x.get(
            "/api/live/ai/input?contact_id=group:fictional&purpose=briefing",
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await x.get(
            "/api/live/ai/input?contact_id=group:fictional&purpose=briefing&members=M1",
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await x.get(
            "/api/live/ai/input?contact_id=Fictional%20Person&purpose=briefing",
          )
        ).status,
      ).toBe(400);
    } finally {
      await x.close();
    }
  });
});
