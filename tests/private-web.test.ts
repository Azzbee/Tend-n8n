import { describe, it, expect, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { TendStore, type AuthCommand } from "../src/engine.ts";
import {
  createPrivateWebHandler,
  samePrivateReply,
} from "../src/private-web.ts";
import { exampleLivePolicy, type LivePolicy } from "../src/live-policy.ts";
import type { LiveRecord } from "../src/google-records.ts";
const policy = exampleLivePolicy,
  owner = policy.principal_id,
  clock = () => new Date("2026-10-20T12:00:00Z");
function fixture(): TendStore {
  const store = new TendStore(":memory:", {
    mode: "live",
    clock,
    principal: {
      owner_id: owner,
      user_id: "live-owner",
      chat_id: "live-private",
    },
  });
  store.seed(
    [
      { owner_id: owner, contact_id: "OWNER", name: "Owner" },
      { owner_id: owner, contact_id: "peer", name: "Peer" },
      { owner_id: owner, contact_id: "other", name: "Peer" },
    ],
    [
      { owner_id: owner, contact_id: "OWNER", identity: policy.account_email },
      { owner_id: owner, contact_id: "peer", identity: "peer@example.invalid" },
    ],
    [
      {
        owner_id: owner,
        source: "gmail",
        account_id: policy.account_email,
        mode: "live",
        last_success: clock().toISOString(),
        status: "partial",
        coverage_start: "2026-09-20T00:00:00Z",
        coverage_end: clock().toISOString(),
        cursor: "partial",
      },
    ],
  );
  return store;
}
function record(id: string): LiveRecord {
  return {
    owner_id: owner,
    source: "gmail",
    account_id: policy.account_email,
    source_record_id: id,
    source_thread_id: "thread",
    kind: "message",
    direction: "received",
    actor_identity: "peer@example.invalid",
    participant_identities: [policy.account_email],
    occurred_at: "2026-10-20T10:00:00Z",
    observed_at: clock().toISOString(),
    body_text: "Literal message " + id,
    evidence_reference: "tend-source:gmail/" + id,
    ingestion_mode: "live",
    coverage_start: "2026-09-20T00:00:00Z",
    coverage_end: clock().toISOString(),
    cancelled: false,
    contact_ids: ["peer"],
    authored_text: "Literal message " + id,
    authored_spans: [],
    attribution: "direct",
    eligible_for_extraction: false,
  };
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("address");
  return "http://127.0.0.1:" + addr.port;
}
describe("private web boundary and bounded storage", () => {
  it("paginates same-time records deterministically, separates same names and observes source withdrawal", () => {
    const store = fixture();
    try {
      for (let i = 0; i < 54; i++)
        store.ingest(record("id" + String(i).padStart(2, "0")));
      const query = {
        contact_ids: ["peer"],
        accounts: [{ source: "gmail", account_id: policy.account_email }],
        now: clock().toISOString(),
        message_start: "2026-09-20T12:00:00Z",
        calendar_end: "2026-10-27T12:00:00Z",
        limit: 50,
      };
      const first = store.privateHistory(owner, query);
      expect(first.records).toHaveLength(50);
      expect(first.total).toBe(54);
      const last = first.records.at(-1)!;
      const second = store.privateHistory(owner, {
        ...query,
        after: { occurred_at: last.occurred_at, record_key: last.record_key },
      });
      expect(second.records).toHaveLength(4);
      expect(
        new Set([...first.records, ...second.records].map((r) => r.record_key))
          .size,
      ).toBe(54);
      expect(
        store.privateHistory(owner, { ...query, contact_ids: ["other"] }).total,
      ).toBe(0);
      expect(store.privateContacts(owner, "Peer", "", 51)).toHaveLength(2);
      expect(() => store.privateHistory("other-owner", query)).toThrow();
      store.revokeSource(owner, "gmail");
      expect(store.privateHistory(owner, query).total).toBe(0);
    } finally {
      store.close();
    }
  });
  it("binds verified member tuples and permits only explicitly approved snapshot events", () => {
    const store = fixture();
    try {
      store.seed(
        [],
        [
          {
            owner_id: owner,
            contact_id: "other",
            identity: "other@example.invalid",
          },
        ],
        [
          {
            owner_id: owner,
            source: "calendar",
            account_id: "snapshot",
            mode: "snapshot",
            last_success: clock().toISOString(),
            status: "partial",
            coverage_start: "2026-10-20T00:00:00Z",
            coverage_end: "2026-10-27T00:00:00Z",
            cursor: null,
          },
        ],
      );
      store.ingest(record("right"));
      store.ingest({
        ...record("wrong"),
        actor_identity: "other@example.invalid",
        contact_ids: ["other"],
      });
      for (const id of ["approved", "unapproved"])
        store.ingest({
          ...record(id),
          source: "calendar",
          account_id: "snapshot",
          kind: "meeting",
          direction: "event",
          actor_identity: policy.account_email,
          participant_identities: [
            policy.account_email,
            "peer@example.invalid",
          ],
          occurred_at: "2026-10-21T10:00:00Z",
          end_at: "2026-10-21T11:00:00Z",
          ingestion_mode: "snapshot",
        });
      const query = {
        contact_ids: ["peer", "other"],
        accounts: [{ source: "gmail", account_id: policy.account_email }],
        members: [
          {
            source: "gmail",
            account_id: policy.account_email,
            contact_id: "peer",
          },
          { source: "linkedin", account_id: "different", contact_id: "other" },
        ],
        now: clock().toISOString(),
        message_start: "2026-09-20T12:00:00Z",
        calendar_end: "2026-10-27T12:00:00Z",
        limit: 50,
      };
      expect(
        store
          .privateHistory(owner, query)
          .records.map((r) => r.source_record_id),
      ).toEqual(["right"]);
      store.ingest({ ...record("old"), occurred_at: "2025-10-20T10:00:00Z" });
      const aggregate = store.privateHistory(owner, {
        ...query,
        contact_ids: [],
        members: query.members,
        activity_for: [
          { selector: "peer", contact_ids: ["peer"] },
          {
            selector: "group",
            contact_ids: ["peer", "other"],
            members: query.members,
          },
        ],
      }).activity;
      expect(aggregate?.peer?.count).toBe(1);
      expect(aggregate?.peer?.last_at).toBe("2026-10-20T10:00:00Z");
      expect(aggregate?.peer?.sources).toEqual(["gmail"]);
      expect(aggregate?.group?.count).toBe(1);
      store.revokeSource(owner, "gmail");
      expect(
        store.privateHistory(owner, {
          ...query,
          activity_for: [{ selector: "peer", contact_ids: ["peer"] }],
        }).activity?.peer?.count,
      ).toBe(0);

      const snapshots = {
        ...query,
        members: [
          { source: "calendar", account_id: "snapshot", contact_id: "peer" },
        ],
        snapshots: [{ calendar_id: "snapshot", event_id: "approved" }],
      };
      expect(
        store
          .privateHistory(owner, snapshots)
          .records.map((r) => r.source_record_id),
      ).toEqual(["approved"]);
      expect(
        store
          .privateHistory(owner, { ...snapshots, terms: ["Literal"] })
          .records.map((r) => r.source_record_id),
      ).toEqual(["approved"]);
    } finally {
      store.close();
    }
  });
  it("validates a prepared read atomically without Telegram ledger writes", () => {
    const store = fixture();
    try {
      const rec = store.ingest(record("one"));
      const auth: AuthCommand = {
        owner_id: owner,
        user_id: "live-owner",
        chat_id: "live-private",
        chat_type: "private",
        text: "briefing",
      };
      const prepared = {
        reply: { outbound_sent: false as const, normal_message: "Literal" },
        record_guards: [
          { record_key: rec.record_key, content_hash: rec.content_hash },
        ],
      };
      expect(store.validatePreparedRead(auth, prepared)).toEqual(
        prepared.reply,
      );
      expect(store.telegramDeliveryCounts()).toEqual({
        reply_pending: 0,
        sent: 0,
      });
      store.revokeSource(owner, "gmail");
      expect(store.validatePreparedRead(auth, prepared)).not.toEqual(
        prepared.reply,
      );
    } finally {
      store.close();
    }
  });
  it("requires explicit same-origin unlock, CSRF and absolute session expiry", async () => {
    const store = fixture();
    let now = clock();
    const handler = createPrivateWebHandler({
      store,
      policy,
      clock: () => now,
    });
    const server = createServer((req, res) => {
      void handler(req, res);
    });
    const base = await listen(server);
    try {
      expect((await fetch(base + "/private/api/contacts")).status).toBe(401);
      const page = await fetch(base + "/private");
      const html = await page.text();
      expect(page.status).toBe(200);
      const cookie = page.headers.get("set-cookie")!.split(";")[0]!;
      const nonce = html.match(/name="nonce"[^>]*value="([^"]+)"/)?.[1];
      expect(nonce).toBeTruthy();
      const denied = await fetch(base + "/private/unlock", {
        method: "POST",
        redirect: "manual",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://evil.invalid",
        },
        body: "nonce=" + nonce,
      });
      expect(denied.status).toBe(403);
      const unlock = await fetch(base + "/private/unlock", {
        method: "POST",
        redirect: "manual",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: base,
        },
        body: "nonce=" + nonce,
      });
      expect(unlock.status).toBe(303);
      const sessionCookie = unlock.headers.get("set-cookie")!.split(";")[0]!;
      expect(unlock.headers.get("set-cookie")).toContain("HttpOnly");
      expect(unlock.headers.get("set-cookie")).toContain("SameSite=Strict");
      const headers = { Cookie: sessionCookie };
      expect(
        (await fetch(base + "/private/api/contacts", { headers })).status,
      ).toBe(200);
      const session = (await (
        await fetch(base + "/private/api/session", { headers })
      ).json()) as { csrf: string };
      expect(
        (
          await fetch(base + "/private/api/draft", {
            method: "POST",
            headers: {
              ...headers,
              Origin: base,
              "Content-Type": "application/json",
            },
            body: "{}",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(base + "/private/api/ingest", {
            method: "POST",
            headers: {
              ...headers,
              Origin: base,
              "Content-Type": "application/json",
              "X-Tend-CSRF": session.csrf,
            },
            body: "{}",
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(base + "/private/api/contacts", {
            headers: { ...headers, "Sec-Fetch-Site": "cross-site" },
          })
        ).status,
      ).toBe(403);
      now = new Date(now.getTime() + 30 * 60000);
      expect(
        (await fetch(base + "/private/api/contacts", { headers })).status,
      ).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  });
});

describe("private held view comparison", () => {
  it("keeps valid scoped output through unrelated coverage progress", () => {
    const before = {
      outbound_sent: false as const,
      ai: { preview: "Held text" },
      coverage: [{ cursor: "before" }],
    };
    const after = { ...before, coverage: [{ cursor: "after" }] };
    expect(samePrivateReply(before, after, true)).toBe(true);
    expect(samePrivateReply(before, after, false)).toBe(false);
    expect(
      samePrivateReply(before, { ...after, ai: { preview: "Changed" } }, true),
    ).toBe(false);
  });
});

async function unlockPrivate(base: string): Promise<Record<string, string>> {
  const page = await fetch(base + "/private"),
    html = await page.text(),
    nonce = html.match(/name="nonce"[^>]*value="([^"]+)"/)?.[1];
  const unlock = await fetch(base + "/private/unlock", {
    method: "POST",
    redirect: "manual",
    headers: {
      Cookie: page.headers.get("set-cookie")!.split(";")[0]!,
      Origin: base,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "nonce=" + nonce,
  });
  const Cookie = unlock.headers.get("set-cookie")!.split(";")[0]!;
  const session = (await (
    await fetch(base + "/private/api/session", { headers: { Cookie } })
  ).json()) as { csrf: string };
  return {
    Cookie,
    Origin: base,
    "Content-Type": "application/json",
    "X-Tend-CSRF": session.csrf,
  };
}
it.each(["briefing", "draft"] as const)(
  "serves a held %s for the exact recipient and withdraws a real fixture edit",
  async (kind) => {
    const store = fixture();
    store.ingest(record("proof"));
    let calls = 0;
    const handler = createPrivateWebHandler({
      store,
      policy,
      clock,
      normalModel: async (request) =>
        (++calls, request.messages[0]!.content.startsWith("Classify"))
          ? {
              intent: "contacts",
              query: "wrong /no_think",
            }
          : {
              items: [{ evidence_id: "E1", quote: "Literal message proof" }],
              ...(kind === "draft"
                ? {
                    draft: {
                      text: "Hi Peer, thanks for your message. Could you share a quick update when you have a moment?",
                    },
                  }
                : {}),
            },
    });
    const server = createServer((req, res) => {
        void handler(req, res);
      }),
      base = await listen(server);
    try {
      const headers = await unlockPrivate(base),
        response = await fetch(base + "/private/api/" + kind, {
          method: "POST",
          headers,
          body: JSON.stringify({ selector: "peer" }),
        });
      expect(response.status).toBe(200);
      const view = (await response.json()) as {
        view_id: string;
        reply: { ai: { status: string } };
      };
      expect(view.reply.ai.status).toBe("validated");
      expect(calls).toBe(1);
      const original = store.sourceStatus(owner);
      const spy = vi.spyOn(store, "sourceStatus").mockReturnValue(
        original.map((state) => ({
          ...state,
          cursor: "sync-progress",
          last_success: "2026-10-20T12:00:01Z",
        })),
      );
      const valid = (await (
        await fetch(base + "/private/api/revalidate", {
          method: "POST",
          headers,
          body: JSON.stringify({ view_id: view.view_id }),
        })
      ).json()) as { valid: boolean };
      expect(valid.valid).toBe(true);
      spy.mockRestore();
      store.ingest({
        ...record("proof"),
        body_text: "The original source changed.",
        authored_text: "The original source changed.",
      });
      const stale = (await (
        await fetch(base + "/private/api/revalidate", {
          method: "POST",
          headers,
          body: JSON.stringify({ view_id: view.view_id }),
        })
      ).json()) as { valid: boolean };
      expect(stale.valid).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  },
);
it("rejects an unknown exact contact before any model inference", async () => {
  const store = fixture(),
    handler = createPrivateWebHandler({
      store,
      policy,
      clock,
      normalModel: async () => ({ intent: "help" }),
    }),
    server = createServer((req, res) => {
      void handler(req, res);
    }),
    base = await listen(server);
  try {
    const headers = await unlockPrivate(base);
    const response = await fetch(base + "/private/api/briefing", {
      method: "POST",
      headers,
      body: JSON.stringify({ selector: "not-a-contact" }),
    });
    expect(response.status).toBe(400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

it("labels verified groups from an exact stored member without joining names", async () => {
  const store = fixture();
  const group = {
    id: "group:verified-phone-pair",
    name: "Trusted project contact",
    verified_at: clock().toISOString(),
    proof_kind: "owner_confirmed" as const,
    proof_reference: "owner-confirmation:fixture",
    members: [
      {
        source: "calendar" as const,
        account_id: policy.calendar_ids[0]!,
        contact_id: "other",
        identity: "other@example.invalid",
      },
      {
        source: "gmail" as const,
        account_id: policy.account_email,
        contact_id: "peer",
        identity: "peer@example.invalid",
      },
    ],
  };
  const handler = createPrivateWebHandler({
    store,
    policy: { ...policy, verified_contact_groups: [group] },
    clock,
    resolveGroup: async (id) => (id === group.id ? group : undefined),
  });
  const server = createServer((req, res) => {
      void handler(req, res);
    }),
    base = await listen(server);
  try {
    const headers = await unlockPrivate(base);
    const response = await fetch(base + "/private/api/contacts", { headers });
    const result = (await response.json()) as {
      contacts: { contact_id: string; name: string }[];
    };
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(
      result.contacts.find((contact) => contact.contact_id === group.id)?.name,
    ).toBe("Peer");
    for (const query of ["Trusted project", "Peer", group.id]) {
      const filtered = await fetch(
        base + "/private/api/contacts?q=" + encodeURIComponent(query),
        { headers },
      );
      const page = (await filtered.json()) as {
        contacts: { contact_id: string }[];
      };
      expect(
        page.contacts.some((contact) => contact.contact_id === group.id),
      ).toBe(true);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

describe("owner-only held history retry", () => {
  async function setup(
    options: {
      history?: boolean;
      held?: boolean;
      revoked?: boolean;
      socialHistory?: boolean;
    } = {},
  ) {
    const store = fixture();
    store.beginHistoryBackfill(
      owner,
      "gmail",
      policy.account_email,
      clock().toISOString(),
    );
    store.pauseHistoryBackfill(
      owner,
      "gmail",
      policy.account_email,
      options.held === false ? "provider_429" : "history_page_requires_review",
      "2026-10-21T12:00:00.000Z",
    );
    if (options.revoked) store.revokeSource(owner, "gmail");
    const selectedPolicy: LivePolicy =
      options.history === false
        ? { ...policy }
        : { ...policy, history: { version: 1, mode: "all_available" } };
    if (options.socialHistory !== undefined) {
      selectedPolicy.social = {
        window_days: 30,
        accounts: [
          {
            source: "whatsapp_personal",
            provider: "unipile",
            account_id: "wa-fixture",
            owner_identity: "wa-owner",
            owner_verified: true,
            api_base_url: "https://api1.unipile.com",
          },
        ],
        ...(options.socialHistory
          ? { history: { version: 1 as const, mode: "all_available" as const } }
          : {}),
      };
      store.seed(
        [],
        [],
        [
          {
            owner_id: owner,
            source: "whatsapp_personal",
            account_id: "wa-fixture",
            status: "partial",
            mode: "live",
            cursor: "incremental-wa",
            last_success: null,
            coverage_start: "2026-09-20T12:00:00Z",
            coverage_end: clock().toISOString(),
          },
        ],
      );
      store.beginHistoryBackfill(
        owner,
        "whatsapp_personal",
        "wa-fixture",
        clock().toISOString(),
      );
      store.pauseHistoryBackfill(
        owner,
        "whatsapp_personal",
        "wa-fixture",
        "history_page_requires_review",
        null,
      );
    }
    const handler = createPrivateWebHandler({
      store,
      clock,
      policy: selectedPolicy,
    });
    const server = createServer((req, res) => {
      void handler(req, res);
    });
    const base = await listen(server);
    return {
      store,
      base,
      close: async () => {
        await new Promise<void>((ok) => server.close(() => ok()));
        store.close();
      },
    };
  }
  const request = {
    source: "gmail",
    account_id: policy.account_email,
    confirm: "RETRY_HELD_HISTORY_PAGE",
  };
  it("retries only the same held page without changing counts, cursor or provider wait", async () => {
    const x = await setup();
    try {
      const before = x.store.historyBackfills(owner)[0]!;
      const headers = await unlockPrivate(x.base);
      const response = await fetch(x.base + "/private/api/history-retry", {
        method: "POST",
        headers,
        body: JSON.stringify(request),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        retry_requested: true,
        provider_called: false,
        skipped_records: 0,
      });
      const after = x.store.historyBackfills(owner)[0]!;
      expect(after).toEqual({ ...before, last_error: "owner_retry_requested" });
      expect(x.store.sourceStatus(owner)[0]!.cursor).toBe("partial");
      expect(
        (
          await fetch(x.base + "/private/api/history-retry", {
            method: "POST",
            headers,
            body: JSON.stringify(request),
          })
        ).status,
      ).toBe(400);
    } finally {
      await x.close();
    }
  });
  it.each([
    { ...request, source: "unapproved" },
    { ...request, account_id: "foreign@example.invalid" },
    { ...request, confirm: "skip" },
    { ...request, cursor: "replace" },
  ])("rejects an unapproved or non-exact request %#", async (input) => {
    const x = await setup();
    try {
      const before = x.store.historyBackfills(owner);
      const headers = await unlockPrivate(x.base);
      expect(
        (
          await fetch(x.base + "/private/api/history-retry", {
            method: "POST",
            headers,
            body: JSON.stringify(input),
          })
        ).status,
      ).toBe(400);
      expect(x.store.historyBackfills(owner)).toEqual(before);
    } finally {
      await x.close();
    }
  });
  it.each([{ history: false }, { held: false }, { revoked: true }])(
    "rejects a non-approved or no-longer-held source %#",
    async (options) => {
      const x = await setup(options);
      try {
        const headers = await unlockPrivate(x.base);
        expect(
          (
            await fetch(x.base + "/private/api/history-retry", {
              method: "POST",
              headers,
              body: JSON.stringify(request),
            })
          ).status,
        ).toBe(400);
      } finally {
        await x.close();
      }
    },
  );
  it("preserves a concurrent provider wait when explicitly retrying the same held page", async () => {
    const x = await setup();
    try {
      const headers = await unlockPrivate(x.base);
      const read = x.store.historyBackfills.bind(x.store);
      vi.spyOn(x.store, "historyBackfills").mockImplementationOnce((id) => {
        const stale = read(id);
        x.store.pauseHistoryBackfill(
          owner,
          "gmail",
          policy.account_email,
          "provider_429",
          "2026-10-22T12:00:00.000Z",
        );
        return stale;
      });
      const response = await fetch(x.base + "/private/api/history-retry", {
        method: "POST",
        headers,
        body: JSON.stringify(request),
      });
      expect(response.status).toBe(200);
      expect(read(owner)[0]).toMatchObject({
        last_error: "owner_retry_requested",
        retry_after_until: "2026-10-22T12:00:00.000Z",
        cursor: null,
        page_count: 0,
      });
    } finally {
      await x.close();
    }
  });
  it("preserves a newer quota deadline even if the review hold remains the same", async () => {
    const x = await setup();
    try {
      const headers = await unlockPrivate(x.base);
      const read = x.store.historyBackfills.bind(x.store);
      vi.spyOn(x.store, "historyBackfills").mockImplementationOnce((id) => {
        const stale = read(id);
        x.store.pauseHistoryBackfill(
          owner,
          "gmail",
          policy.account_email,
          "history_page_requires_review",
          "2026-10-22T12:00:00.000Z",
        );
        return stale;
      });
      const response = await fetch(x.base + "/private/api/history-retry", {
        method: "POST",
        headers,
        body: JSON.stringify(request),
      });
      expect(response.status).toBe(200);
      expect(read(owner)[0]).toMatchObject({
        last_error: "owner_retry_requested",
        retry_after_until: "2026-10-22T12:00:00.000Z",
        cursor: null,
        page_count: 0,
      });
    } finally {
      await x.close();
    }
  });
  it.each([false, true])(
    "honours the separate social history approval (%s)",
    async (socialHistory) => {
      const x = await setup({ socialHistory });
      try {
        const headers = await unlockPrivate(x.base);
        const response = await fetch(x.base + "/private/api/history-retry", {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...request,
            source: "whatsapp_personal",
            account_id: "wa-fixture",
          }),
        });
        expect(response.status).toBe(socialHistory ? 200 : 400);
        const checkpoint = x.store
          .historyBackfills(owner)
          .find((entry) => entry.source === "whatsapp_personal");
        expect(checkpoint?.last_error).toBe(
          socialHistory
            ? "owner_retry_requested"
            : "history_page_requires_review",
        );
      } finally {
        await x.close();
      }
    },
  );
  it("requires an unlocked session and exact CSRF proof", async () => {
    const x = await setup();
    try {
      expect(
        (
          await fetch(x.base + "/private/api/history-retry", {
            method: "POST",
            headers: { Origin: x.base, "Content-Type": "application/json" },
            body: JSON.stringify(request),
          })
        ).status,
      ).toBe(401);
      const headers = await unlockPrivate(x.base);
      headers["X-Tend-CSRF"] = "wrong";
      expect(
        (
          await fetch(x.base + "/private/api/history-retry", {
            method: "POST",
            headers,
            body: JSON.stringify(request),
          })
        ).status,
      ).toBe(403);
      expect(x.store.historyBackfills(owner)[0]!.last_error).toBe(
        "history_page_requires_review",
      );
    } finally {
      await x.close();
    }
  });
});
