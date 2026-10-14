import { describe, it, expect } from "vitest";
import { createLiveServer } from "../src/live-api.ts";
import { InternalAuth, verificationHash } from "../src/internal-auth.ts";
import { TendStore } from "../src/engine.ts";
import { exampleLivePolicy } from "../src/live-policy.ts";
import { request as httpRequest, type Server } from "node:http";
const key = "FICTIONAL_ONLY_0123456789_abcdefghijklmnopqrstuvwxyz_ABCD";
async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("address");
  return a.port;
}
describe("private live API", () => {
  it("refreshes both calendars when Gmail polls between every calendar run", async () => {
    const policy = exampleLivePolicy,
      clock = () => new Date("2026-10-14T12:00:00Z");
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
    const base = `http://127.0.0.1:${await listen(server)}`,
      headers = {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      };
    async function complete(
      source: "gmail" | "calendar",
      supplied?: Record<string, unknown>,
    ): Promise<string> {
      const state =
        supplied ??
        ((await (
          await fetch(base + "/api/live/sync-state?source=" + source, {
            headers,
          })
        ).json()) as Record<string, unknown>);
      const response = await fetch(base + "/api/live/sync", {
        method: "POST",
        headers,
        body: JSON.stringify({
          source,
          account_email: policy.account_email,
          profile_account_email: policy.account_email,
          ...(source === "calendar" ? { calendar_id: state.calendar_id } : {}),
          records: [],
          previous_cursor: null,
          cursor: null,
          complete: true,
          reconcile: true,
          window_start: state.window_start,
          window_end: state.window_end,
          seen_record_ids: [],
        }),
      });
      expect(response.status).toBe(200);
      return String(state.calendar_id ?? "");
    }
    try {
      const selected: string[] = [];
      for (let i = 0; i < 6; i++) {
        await complete("gmail");
        selected.push(await complete("calendar"));
      }
      expect(new Set(selected.slice(2)).size).toBe(2);
      const failing = policy.calendar_ids.find((id) => id !== "primary")!;
      let healthyRuns = 0;
      for (let i = 0; i < 8; i++) {
        const state = (await (
          await fetch(base + "/api/live/sync-state?source=calendar", {
            headers,
          })
        ).json()) as Record<string, unknown>;
        if (state.calendar_id === failing)
          store.markLiveSyncError(
            policy.principal_id,
            "calendar",
            failing,
            false,
            null,
            404,
          );
        else {
          await complete("calendar", state);
          healthyRuns++;
        }
      }
      expect(healthyRuns).toBe(4);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });
  it("moves extraction past non-promises and failed attempts while retaining them for review", async () => {
    const policy = exampleLivePolicy,
      clock = () => new Date("2026-10-14T12:00:00Z");
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
    const base = `http://127.0.0.1:${await listen(server)}`;
    const headers = {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    };
    try {
      const state = (await (
        await fetch(base + "/api/live/sync-state?source=gmail", { headers })
      ).json()) as Record<string, unknown>;
      const records = [
        "Hello, how are you?",
        "I will send the notes by 2026-10-15.",
        "I will send the slides by 2026-10-16.",
      ].map((text, i) => ({
        id: String(i),
        threadId: "fictional-thread-" + i,
        labelIds: ["INBOX"],
        internalDate: String(Date.parse("2026-10-14T11:00:00Z")),
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "mira@example.invalid" },
            { name: "To", value: policy.account_email },
          ],
          body: { data: Buffer.from(text).toString("base64url") },
        },
      }));
      expect(
        (
          await fetch(base + "/api/live/sync", {
            method: "POST",
            headers,
            body: JSON.stringify({
              source: "gmail",
              account_email: policy.account_email,
              profile_account_email: policy.account_email,
              records,
              previous_cursor: null,
              cursor: null,
              complete: true,
              reconcile: true,
              window_start: state.window_start,
              window_end: state.window_end,
              seen_record_ids: [],
            }),
          })
        ).status,
      ).toBe(200);
      const first = (await (
        await fetch(base + "/api/live/model-input", { headers })
      ).json()) as Record<string, unknown>;
      expect(first.eligible).toBe(true);
      expect(first.record_key).toBe(
        store.interactions(policy.principal_id)[1]?.record_key,
      );
      expect(
        (
          await fetch(base + "/api/live/extraction-attempt", {
            method: "POST",
            headers,
            body: JSON.stringify({
              record_key: first.record_key,
              content_hash: "stale",
            }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(base + "/api/live/extraction-attempt", {
            method: "POST",
            headers,
            body: JSON.stringify({
              record_key: first.record_key,
              content_hash: first.content_hash,
            }),
          })
        ).status,
      ).toBe(200);
      const second = (await (
        await fetch(base + "/api/live/model-input", { headers })
      ).json()) as Record<string, unknown>;
      expect(second.eligible).toBe(true);
      expect(second.record_key).toBe(
        store.interactions(policy.principal_id)[2]?.record_key,
      );
      expect(second.record_key).not.toBe(first.record_key);
      expect((await fetch(base + "/api/live/status", { headers })).status).toBe(
        200,
      );
      const status = (await (
        await fetch(base + "/api/live/status", { headers })
      ).json()) as Record<string, unknown>;
      expect(status.extraction_review_count).toBe(1);
      expect(store.counts(policy.principal_id).interactions).toBe(3);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });
  it("continues another selected calendar while the first is in retry backoff", async () => {
    const policy = exampleLivePolicy,
      clock = () => new Date("2026-10-14T12:00:00Z");
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
    const base = `http://127.0.0.1:${await listen(server)}`;
    try {
      const deferred = store
        .sourceStatus(policy.principal_id)
        .find((s) => s.source === "calendar")!;
      store.markLiveSyncError(
        policy.principal_id,
        "calendar",
        deferred.account_id,
        false,
        "2026-10-15T12:00:00Z",
        429,
      );
      const result = (await (
        await fetch(base + "/api/live/sync-state?source=calendar", {
          headers: { Authorization: "Bearer " + key },
        })
      ).json()) as Record<string, unknown>;
      expect(result.calendar_id).not.toBe(deferred.account_id);
      expect(result.retry_after_until).toBe(null);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });
  it("blocks unauthenticated/private diagnostics and account mismatch before ingest", async () => {
    const clock = () => new Date("2026-10-14T12:00:00Z");
    const policy = exampleLivePolicy;
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
      }),
      port = await listen(server),
      base = `http://127.0.0.1:${port}`;
    try {
      for (const path of [
        "/api/live/status",
        "/api/live/model-input",
        "/api/status",
        "/api/live/sync-state?source=gmail",
      ]) {
        expect((await fetch(base + path)).status).toBe(401);
      }
      const malformed = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: "127.0.0.1",
            port,
            path: "http://[",
            headers: { Host: `127.0.0.1:${port}` },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(malformed).toBe(400);
      const stateResponse = await fetch(
        base + "/api/live/sync-state?source=gmail",
        { headers: { Authorization: "Bearer " + key } },
      );
      expect(stateResponse.status).toBe(200);
      const state = (await stateResponse.json()) as Record<string, unknown>;
      const batch = {
        source: "gmail",
        account_email: policy.account_email,
        profile_account_email: policy.account_email,
        records: [],
        cursor: null,
        previous_cursor: null,
        complete: true,
        reconcile: true,
        window_start: state.window_start,
        window_end: state.window_end,
        seen_record_ids: [],
      };
      const headers = {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      };
      expect(
        (
          await fetch(base + "/api/live/sync", {
            method: "POST",
            headers,
            body: JSON.stringify({
              ...batch,
              account_email: "foreign@example.invalid",
            }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(base + "/api/live/sync", {
            method: "POST",
            headers,
            body: JSON.stringify({ ...batch, profile_account_email: null }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(base + "/api/live/sync", {
            method: "POST",
            headers,
            body: JSON.stringify(batch),
          })
        ).status,
      ).toBe(200);
      expect(
        store
          .sourceStatus(policy.principal_id)
          .find((x) => x.source === "gmail")?.status,
      ).toBe("current");
      const replay = await fetch(base + "/api/live/sync", {
        method: "POST",
        headers,
        body: JSON.stringify(batch),
      });
      expect(replay.status).toBe(200);
      store.revokeSource(policy.principal_id, "gmail");
      expect(
        (
          await fetch(base + "/api/live/sync", {
            method: "POST",
            headers,
            body: JSON.stringify(batch),
          })
        ).status,
      ).toBe(400);
      const reset = {
        source: "gmail",
        account_email: policy.account_email,
        profile_account_email: policy.account_email,
        manual_reconnect: true,
        verified_at: clock().toISOString(),
      };
      expect(
        (
          await fetch(base + "/api/live/reconnect", {
            method: "POST",
            headers,
            body: JSON.stringify({
              ...reset,
              profile_account_email: "foreign@example.invalid",
            }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(base + "/api/live/reconnect", {
            method: "POST",
            headers,
            body: JSON.stringify({
              ...reset,
              verified_at: "2026-10-14T11:00:00Z",
            }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(base + "/api/live/reconnect", {
            method: "POST",
            headers,
            body: JSON.stringify(reset),
          })
        ).status,
      ).toBe(200);
      expect(
        store
          .sourceStatus(policy.principal_id)
          .find((x) => x.source === "gmail")?.status,
      ).toBe("partial");
      expect(
        (
          await fetch(base + "/api/live/sync", {
            method: "POST",
            headers,
            body: JSON.stringify(batch),
          })
        ).status,
      ).toBe(200);

      expect(
        (
          await fetch(base + "/api/live/status", {
            headers: {
              Authorization: "Bearer " + key,
              Origin: "https://foreign.invalid",
            },
          })
        ).status,
      ).toBe(403);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });

  it("invalidates edited quarantined evidence and resumes an anchored cursor without stale writes", async () => {
    let instant = new Date("2026-10-14T12:00:00Z");
    const clock = () => instant;
    const policy = exampleLivePolicy,
      store = new TendStore(":memory:", {
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
      }),
      port = await listen(server),
      base = `http://127.0.0.1:${port}`,
      headers = {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      };
    const request = async (path: string, body?: unknown) =>
      fetch(
        base + path,
        body === undefined
          ? { headers }
          : { method: "POST", headers, body: JSON.stringify(body) },
      );
    try {
      const state = (await (
        await request("/api/live/sync-state?source=gmail")
      ).json()) as Record<string, unknown>;
      const mail = {
        id: "realistic-fictional-message",
        threadId: "fictional-thread",
        labelIds: ["INBOX"],
        internalDate: String(Date.parse("2026-10-14T11:00:00Z")),
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "Mira <mira@example.invalid>" },
            { name: "To", value: policy.account_email },
          ],
          body: {
            data: Buffer.from("I will send the notes by 2026-10-15.").toString(
              "base64url",
            ),
          },
        },
      };
      const batch = {
        source: "gmail",
        account_email: policy.account_email,
        profile_account_email: policy.account_email,
        calendar_id: null,
        previous_cursor: null,
        cursor: null,
        records: [mail],
        complete: false,
        reconcile: false,
        window_start: state.window_start,
        window_end: state.window_end,
        seen_record_ids: [],
      };
      expect((await request("/api/live/sync", batch)).status).toBe(200);
      const record = store.interactions(policy.principal_id)[0]!;
      store.addCandidate(record, {
        quote: record.authored_spans![0]!.text,
        action: "send the notes",
        suggested_due: "2026-10-15",
      });
      expect(store.contacts(policy.principal_id)).toHaveLength(1);
      // A resumed page preserves its original clock/window instead of drifting.
      instant = new Date("2026-10-14T12:01:00Z");
      expect((await request("/api/live/sync", batch)).status).toBe(200);
      expect(store.counts(policy.principal_id)).toEqual({
        interactions: 1,
        commitments: 1,
      });
      expect(store.contacts(policy.principal_id)).toHaveLength(1);
      expect(store.interactions(policy.principal_id)[0]).toMatchObject({
        record_key: record.record_key,
        content_hash: record.content_hash,
        observed_at: instant.toISOString(),
      });
      expect(store.commitments(policy.principal_id)[0]).toMatchObject({
        status: "pending",
        evidence_valid: true,
        quote: record.authored_spans![0]!.text,
      });
      const resumed = (await (
        await request("/api/live/sync-state?source=gmail")
      ).json()) as Record<string, unknown>;
      expect(resumed.window_end).toBe(state.window_end);
      expect(
        (
          await request("/api/live/sync", {
            ...batch,
            window_end: instant.toISOString(),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request("/api/live/sync", {
            ...batch,
            records: [],
            cursor: "page-two",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await request("/api/live/sync", {
            ...batch,
            records: [],
            cursor: "page-three",
          })
        ).status,
      ).toBe(400);
      // Provider ID still exists, but unsupported new content cannot preserve old evidence.
      const excluded = { ...mail, labelIds: ["TRASH"] };
      expect(
        (
          await request("/api/live/sync", {
            ...batch,
            records: [excluded],
            previous_cursor: "page-two",
            cursor: null,
            complete: true,
            reconcile: true,
          })
        ).status,
      ).toBe(200);
      expect(store.interactions(policy.principal_id)).toHaveLength(0);
      expect(store.contacts(policy.principal_id)).toHaveLength(0);
      expect(store.commitments(policy.principal_id)[0]).toMatchObject({
        status: "invalidated",
        evidence_valid: false,
        quote: "",
        action: "",
      });
      expect(store.quarantineCount(policy.principal_id)).toBe(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });
  it("accepts quote-only mail as contact metadata without promoting quoted promises", async () => {
    const policy = exampleLivePolicy,
      clock = () => new Date("2026-10-14T12:00:00Z"),
      store = new TendStore(":memory:", {
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
      }),
      port = await listen(server),
      base = `http://127.0.0.1:${port}`,
      headers = {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      };
    try {
      const state = (await (
        await fetch(base + "/api/live/sync-state?source=gmail", { headers })
      ).json()) as Record<string, unknown>;
      const mail = {
        id: "quoted-only",
        threadId: "fictional-thread",
        labelIds: ["INBOX"],
        internalDate: String(Date.parse("2026-10-14T11:00:00Z")),
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "mira@example.invalid" },
            { name: "To", value: policy.account_email },
          ],
          body: {
            data: Buffer.from("> I will send money now.").toString("base64url"),
          },
        },
      };
      const response = await fetch(base + "/api/live/sync", {
        method: "POST",
        headers,
        body: JSON.stringify({
          source: "gmail",
          account_email: policy.account_email,
          profile_account_email: policy.account_email,
          records: [mail],
          previous_cursor: null,
          cursor: null,
          complete: true,
          reconcile: true,
          window_start: state.window_start,
          window_end: state.window_end,
          seen_record_ids: [],
        }),
      });
      expect(response.status).toBe(200);
      expect(store.interactions(policy.principal_id)[0]).toMatchObject({
        body_text: "",
        eligible_for_extraction: false,
      });
      const model = await (
        await fetch(base + "/api/live/model-input", { headers })
      ).json();
      expect(model).toEqual({ eligible: false });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });
  it("keeps one-time setup same-origin and never returns the raw key", async () => {
    const policy = exampleLivePolicy,
      clock = () => new Date("2026-10-14T12:00:00Z"),
      auth = new InternalAuth();
    const store = new TendStore(":memory:", {
      mode: "live",
      principal: {
        owner_id: policy.principal_id,
        user_id: "live-owner",
        chat_id: "live-private",
      },
      clock,
    });
    const server = createLiveServer({ policy, store, auth, clock }),
      port = await listen(server),
      base = `http://127.0.0.1:${port}`;
    try {
      expect((await fetch(base + "/setup")).status).toBe(200);
      const body = new URLSearchParams({
        nonce: auth.setupNonce,
        secret: key,
      }).toString();
      expect(
        (
          await fetch(base + "/setup", {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Origin: "https://foreign.invalid",
            },
            body,
          })
        ).status,
      ).toBe(403);
      const r = await fetch(base + "/setup", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: base,
        },
        body,
      });
      expect(r.status).toBe(200);
      expect(await r.text()).not.toContain(key);
      expect((await fetch(base + "/setup")).status).toBe(404);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });
});

it("reads one owner-bound pending reply without changing delivery state and excludes sent or revoked caches", async () => {
  const policy = exampleLivePolicy,
    clock = () => new Date("2026-10-14T12:00:00Z");
  const principal = {
    owner_id: policy.principal_id,
    user_id: "live-owner",
    chat_id: "live-private",
  };
  const store = new TendStore(":memory:", { mode: "live", principal, clock });
  const server = createLiveServer({
    policy,
    store,
    auth: new InternalAuth(undefined, verificationHash(key)),
    clock,
  });
  const base = `http://127.0.0.1:${await listen(server)}`;
  const headers = { Authorization: "Bearer " + key };
  const command = { ...principal, chat_type: "private", text: "/status" };
  try {
    store.telegramCommand(command, "recovery-control", 100);
    const route =
      base +
      "/api/live/telegram/pending-reply?channel_id=recovery-control&update_id=100";
    expect((await fetch(route)).status).toBe(401);
    const before = store.telegramDeliveryCounts();
    const response = await fetch(route, { headers });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      available: true,
      channel_id: "recovery-control",
      update_id: 100,
      reply: { outbound_sent: false },
    });
    expect(store.telegramDeliveryCounts()).toEqual(before);
    expect(() =>
      store.pendingTelegramReply("another-owner", "recovery-control", 100),
    ).toThrow();
    for (const query of [
      "channel_id=../bad&update_id=100",
      "channel_id=recovery-control&update_id=1e2",
      "channel_id=recovery-control&update_id=9007199254740992",
      "channel_id=recovery-control&update_id=100&owner_id=another-owner",
    ]) {
      expect(
        (
          await fetch(base + "/api/live/telegram/pending-reply?" + query, {
            headers,
          })
        ).status,
      ).toBe(400);
    }
    store.acknowledgeTelegramReply(command, "recovery-control", 100, 77);
    expect(await (await fetch(route, { headers })).json()).toEqual({
      available: false,
    });
    store.telegramCommand(command, "recovery-control", 101);
    store.markLiveSyncError(
      policy.principal_id,
      "gmail",
      policy.account_email,
      true,
      null,
      401,
    );
    expect(
      await (
        await fetch(route.replace("update_id=100", "update_id=101"), {
          headers,
        })
      ).json(),
    ).toEqual({ available: false });
    expect(store.telegramDeliveryCounts()).toEqual({
      reply_pending: 1,
      sent: 1,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
