import { describe, it, expect } from "vitest";
import {
  RETENTION_INTERVAL_MS,
  SLOW_REQUEST_MS,
  createLiveServer,
  incrementalPolicyOf,
  rejectionReason,
} from "../src/live-api.ts";
import { InternalAuth, verificationHash } from "../src/internal-auth.ts";
import { TendStore } from "../src/engine.ts";
import type { LiveRecord } from "../src/google-records.ts";
import {
  exampleLivePolicy,
  gmailWindow,
  type LivePolicy,
} from "../src/live-policy.ts";
import { request as httpRequest, type Server } from "node:http";
const key = "FICTIONAL_ONLY_0123456789_abcdefghijklmnopqrstuvwxyz_ABCD";
async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("address");
  return a.port;
}
describe("private live API", () => {
  it("opens the recent Gmail lane when the policy also approves social history", () => {
    const policy: LivePolicy = {
      ...exampleLivePolicy,
      history: { version: 1, mode: "all_available" },
      social: {
        window_days: 30,
        history: { version: 1, mode: "all_available" },
        accounts: [
          {
            source: "whatsapp_personal",
            provider: "unipile",
            account_id: "personal-account",
            owner_identity: "123",
            owner_verified: true,
            api_base_url: "https://api1.unipile.com",
          },
        ],
      },
    };
    const now = new Date("2026-10-22T10:45:00Z");
    // Removing only history left social.history behind, which the policy rejects.
    const naive = { ...policy };
    delete naive.history;
    expect(() => gmailWindow(naive, now)).toThrow(
      "social history exceeds live policy scope",
    );
    const recent = incrementalPolicyOf(policy);
    expect(gmailWindow(recent, now).start).toBe("2026-09-22T10:45:00.000Z");
    expect(recent.social?.accounts).toEqual(policy.social!.accounts);
    expect(policy.social!.history).toBeDefined();
  });
  it("logs only the fixed guard text of a rejection, never data", () => {
    expect(rejectionReason(new Error("account mismatch"))).toBe(
      "account mismatch",
    );
    expect(rejectionReason(new Error("history checkpoint unavailable"))).toBe(
      "history checkpoint unavailable",
    );
    for (const leak of [
      "duplicate key mira@example.invalid",
      'Mira wrote 2026-10-15 "send the demo"',
      "x".repeat(200),
      "",
    ])
      expect(rejectionReason(new Error(leak))).toBe("unlisted");
    expect(rejectionReason("not an error")).toBe("unlisted");
  });
  it("runs retention at most once a minute, shares one run and retries a failed one", async () => {
    const policy = exampleLivePolicy;
    let now = Date.parse("2026-10-22T08:00:00Z");
    const clock = () => new Date(now);
    const store = new TendStore(":memory:", {
      mode: "live",
      principal: {
        owner_id: policy.principal_id,
        user_id: "live-owner",
        chat_id: "live-private",
      },
      clock,
    });
    let runs = 0,
      failNext = false;
    const expire = store.expireLiveEvidence.bind(store);
    store.expireLiveEvidence = (...args) => {
      runs++;
      if (failNext) {
        failNext = false;
        throw new Error("storage unavailable");
      }
      return expire(...args);
    };
    const slow: { path: string; ms: number }[] = [];
    const server = createLiveServer({
      policy,
      store,
      auth: new InternalAuth(undefined, verificationHash(key)),
      clock,
      slowLog: (e) => slow.push(e),
      outreach: {
        route: async (_method, path) => {
          if (path !== "/api/live/outreach/plan") return null;
          await new Promise((r) => setTimeout(r, SLOW_REQUEST_MS + 50));
          return { status: 200, body: {} };
        },
      },
    });
    const port = await listen(server);
    const get = () =>
      fetch(`http://127.0.0.1:${port}/api/live/failure-log`, {
        headers: { Authorization: "Bearer " + key },
      });
    try {
      await Promise.all([get(), get(), get()]);
      expect(runs).toBe(1);
      now += RETENTION_INTERVAL_MS - 1;
      await get();
      expect(runs).toBe(1);
      now += 1;
      failNext = true;
      expect((await get()).status).toBe(400);
      expect(runs).toBe(2);
      expect((await get()).status).toBe(200);
      expect(runs).toBe(3);
      expect(slow).toEqual([]);
      await fetch(`http://127.0.0.1:${port}/api/live/outreach/plan`, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(slow).toHaveLength(1);
      expect(slow[0]!.path).toBe("/api/live/outreach/plan");
      expect(slow[0]!.ms).toBeGreaterThanOrEqual(SLOW_REQUEST_MS);
      expect(Object.keys(slow[0]!).sort()).toEqual(["at", "ms", "path"]);
    } finally {
      server.close();
    }
  });
  it("records only redacted private failures behind owner authentication", async () => {
    const policy = exampleLivePolicy,
      clock = () => new Date("2026-10-22T08:00:00Z");
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
    const base = `http://127.0.0.1:${await listen(server)}/api/live/failure-log`,
      headers = {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      };
    const entry = {
      workflow: "Tend 11: Read-only Gmail approved-window sync",
      node: "Read Gmail profile",
      message: "HTTP 429",
      execution_id: "4821",
    };
    try {
      expect(
        (await fetch(base, { method: "POST", body: JSON.stringify(entry) }))
          .status,
      ).toBe(401);
      expect((await fetch(base)).status).toBe(401);
      const leaked = await fetch(base, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...entry, message: "Mira Tan: F17 contract" }),
      });
      expect(leaked.status).toBe(400);
      expect(
        (
          await fetch(base, {
            method: "POST",
            headers,
            body: JSON.stringify(entry),
          })
        ).status,
      ).toBe(200);
      const listed = (await (await fetch(base, { headers })).json()) as {
        failure_log: Record<string, string>[];
      };
      expect(listed.failure_log).toEqual([
        { ...entry, execution_url: "", at: "2026-10-22T08:00:00.000Z" },
      ]);
      expect(JSON.stringify(listed)).not.toContain("Mira");
    } finally {
      server.close();
    }
  });
  it("forces a fresh retention run after every sync batch, inside the minute", async () => {
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
    let runs = 0;
    const expire = store.expireLiveEvidence.bind(store);
    store.expireLiveEvidence = (...args) => {
      runs++;
      return expire(...args);
    };
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
    try {
      const state = (await (
        await fetch(base + "/api/live/sync-state?source=gmail", { headers })
      ).json()) as Record<string, unknown>;
      expect(runs).toBe(1);
      const sync = () =>
        fetch(base + "/api/live/sync", {
          method: "POST",
          headers,
          body: JSON.stringify({
            source: "gmail",
            account_email: policy.account_email,
            profile_account_email: policy.account_email,
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
      expect((await sync()).status).toBe(200);
      // The shared run covers the request; the batch forces one more.
      expect(runs).toBe(2);
      expect((await sync()).status).toBe(200);
      expect(runs).toBe(3);
    } finally {
      server.close();
    }
  });
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

it("withdraws only local LinkedIn evidence with exact owner-authenticated confirmation", async () => {
  const account = "urn:li:person:fixture-owner";
  const policy = {
    ...exampleLivePolicy,
    social: {
      window_days: 30 as const,
      accounts: [
        {
          source: "linkedin" as const,
          provider: "linkedin" as const,
          account_id: account,
          owner_identity: account,
          owner_verified: true as const,
          profile_bindings: [],
        },
      ],
    },
  };
  const clock = () => new Date("2026-10-14T12:00:00Z"),
    principal = {
      owner_id: policy.principal_id,
      user_id: "live-owner",
      chat_id: "live-private",
    };
  const store = new TendStore(":memory:", { mode: "live", principal, clock });
  const states = [
    {
      owner_id: policy.principal_id,
      source: "linkedin" as const,
      account_id: account,
      mode: "live" as const,
      last_success: null,
      status: "partial",
      coverage_start: "2026-09-14T12:00:00.000Z",
      coverage_end: clock().toISOString(),
      cursor: null,
    },
  ];
  store.seed(
    [
      {
        owner_id: policy.principal_id,
        contact_id: "LI-F",
        name: "Fictional LinkedIn contact",
      },
      {
        owner_id: policy.principal_id,
        contact_id: "G-F",
        name: "Fictional Gmail contact",
      },
    ],
    [
      {
        owner_id: policy.principal_id,
        contact_id: "OWNER",
        identity: policy.account_email,
      },
      {
        owner_id: policy.principal_id,
        contact_id: "LI-F",
        identity: "linkedin-fixture-peer",
      },
      {
        owner_id: policy.principal_id,
        contact_id: "G-F",
        identity: "gmail-fixture-peer",
      },
    ],
    [
      ...states,
      { ...states[0]!, source: "gmail", account_id: policy.account_email },
    ],
  );
  const row = (
    source: "linkedin" | "gmail",
    id: string,
    mode: "live" | "snapshot" = "live",
  ): LiveRecord => {
    const text =
      source === "linkedin"
        ? "I will send the withdrawal fixture notes by 2026-10-15."
        : "Unrelated Gmail evidence remains.";
    return {
      owner_id: policy.principal_id,
      source,
      account_id: source === "linkedin" ? account : policy.account_email,
      source_record_id: id,
      source_thread_id: "fixture-thread-" + id,
      kind: "message",
      direction: "received",
      actor_identity:
        source === "linkedin" ? "linkedin-fixture-peer" : "gmail-fixture-peer",
      participant_identities: [policy.account_email],
      occurred_at: "2026-10-14T11:00:00Z",
      observed_at: clock().toISOString(),
      body_text: text,
      evidence_reference: `tend-source:${source}/fixture/${id}`,
      ingestion_mode: mode,
      coverage_start: states[0]!.coverage_start,
      coverage_end: states[0]!.coverage_end,
      cancelled: false,
      contact_ids: [source === "linkedin" ? "LI-F" : "G-F"],
      authored_text: text,
      authored_spans: [{ start: 0, end: text.length, text }],
      attribution: "direct",
      eligible_for_extraction: source === "linkedin",
    };
  };
  const snapshot = row("linkedin", "snapshot-one", "snapshot"),
    live = row("linkedin", "change-one"),
    gmail = row("gmail", "gmail-one");
  store.ingest(snapshot);
  store.ingest(live);
  store.ingest(gmail);
  const candidate = store.addCandidate(snapshot, {
    quote: snapshot.body_text,
    action: "send the withdrawal fixture notes",
    suggested_due: "2026-10-15",
  });
  store.telegramCommand(
    { ...principal, chat_type: "private", text: "/prep LI-F" },
    "fixture-withdraw",
    1,
  );
  expect(store.cachedReplyText(policy.principal_id)).toContain(
    "withdrawal fixture notes",
  );
  const server = createLiveServer({
    policy,
    store,
    clock,
    auth: new InternalAuth(undefined, verificationHash(key)),
  });
  const base = `http://127.0.0.1:${await listen(server)}`,
    route = base + "/api/live/linkedin-withdraw";
  const headers = {
    Authorization: "Bearer " + key,
    "Content-Type": "application/json",
  };
  const current = () => ({
    records: store.interactions(policy.principal_id),
    commitments: store.commitments(policy.principal_id),
    cache: store.cachedReplyText(policy.principal_id),
    states: store.sourceStatus(policy.principal_id),
  });
  try {
    await fetch(base + "/api/live/status", { headers });
    const before = current();
    expect(
      (
        await fetch(route, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            confirm: "REMOVE_ALL_LOCAL_LINKEDIN_EVIDENCE",
          }),
        })
      ).status,
    ).toBe(401);
    expect(current()).toEqual(before);
    for (const body of [
      {},
      { confirm: "wrong" },
      { confirm: "REMOVE_ALL_LOCAL_LINKEDIN_EVIDENCE", owner_id: "foreign" },
      { confirm: "REMOVE_ALL_LOCAL_LINKEDIN_EVIDENCE", source: "gmail" },
      { confirm: "REMOVE_ALL_LOCAL_LINKEDIN_EVIDENCE", account_id: account },
    ]) {
      expect(
        (
          await fetch(route, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(400);
      expect(current()).toEqual(before);
    }
    const pendingAI = (await (
      await fetch(
        base + "/api/live/ai/input?contact_id=LI-F&purpose=briefing",
        { headers },
      )
    ).json()) as { eligible: boolean; request_id: string };
    expect(pendingAI.eligible).toBe(true);
    const confirmed = { confirm: "REMOVE_ALL_LOCAL_LINKEDIN_EVIDENCE" };
    expect(
      (
        await fetch(route + "?owner_id=foreign", {
          method: "POST",
          headers,
          body: JSON.stringify(confirmed),
        })
      ).status,
    ).toBe(400);
    expect(current()).toEqual(before);
    const removed = await fetch(route, {
      method: "POST",
      headers,
      body: JSON.stringify(confirmed),
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({
      withdrawn: true,
      source: "linkedin",
      scope: "all_local_evidence",
      status: "revoked",
      remote_changed: false,
    });
    expect(store.interactions(policy.principal_id)).toEqual(
      before.records.filter((r) => r.source === "gmail"),
    );
    expect(
      store
        .commitments(policy.principal_id)
        .find((c) => c.commitment_id === candidate.commitment_id),
    ).toMatchObject({
      status: "invalidated",
      evidence_valid: false,
      quote: "",
      action: "",
      suggested_due: null,
    });
    expect(store.cachedReplyText(policy.principal_id)).not.toContain(
      "withdrawal fixture notes",
    );
    expect(
      store
        .sourceStatus(policy.principal_id)
        .find((s) => s.source === "linkedin")?.status,
    ).toBe("revoked");
    expect(
      (
        await fetch(base + "/api/live/ai/validate", {
          method: "POST",
          headers,
          body: JSON.stringify({
            request_id: pendingAI.request_id,
            output: {},
          }),
        })
      ).status,
    ).toBe(400);
    const after = current();
    expect(
      (
        await fetch(route, {
          method: "POST",
          headers,
          body: JSON.stringify(confirmed),
        })
      ).status,
    ).toBe(200);
    expect(current()).toEqual(after);
    const future = await fetch(
      base +
        "/api/live/social/read-input?source=linkedin&account_id=" +
        encodeURIComponent(account) +
        "&phase=identity",
      { headers },
    );
    expect(future.status).toBe(200);
    expect(await future.json()).toMatchObject({
      available: false,
      reason: "unavailable_social_account",
    });
    expect(() =>
      store.commitLiveBatch({
        owner_id: policy.principal_id,
        source: "linkedin",
        account_id: account,
        records: [live],
        seen_record_ids: [live.source_record_id],
        cursor: null,
        expected_cursor: null,
        complete: false,
        reconcile: false,
        coverage_start: states[0]!.coverage_start,
        coverage_end: states[0]!.coverage_end,
      }),
    ).toThrow("unregistered live account");
    store.reconnectLiveSource(
      policy.principal_id,
      "linkedin",
      account,
      states[0]!.coverage_start,
      states[0]!.coverage_end,
    );
    expect(
      store
        .sourceStatus(policy.principal_id)
        .find((s) => s.source === "linkedin")?.status,
    ).toBe("partial");
    expect(
      await (
        await fetch(
          base +
            "/api/live/social/read-input?source=linkedin&account_id=" +
            encodeURIComponent(account) +
            "&phase=identity",
          { headers },
        )
      ).json(),
    ).toMatchObject({ available: true });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
