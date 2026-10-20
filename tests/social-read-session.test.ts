import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
} from "vitest";
import { randomUUID } from "node:crypto";
import { TendStore } from "../src/engine.ts";
import type { LiveStore } from "../src/live-store.ts";
import { PostgresStore } from "../src/postgres-store.ts";
import {
  SocialReadSessions,
  type SocialReadInput,
  type SocialReadResult,
} from "../src/social-read-session.ts";
import { parseSocialPolicy, socialWindow } from "../src/social-policy.ts";
import { postgresTestRuntime } from "./postgres-test-runtime.ts";
const personal = {
    source: "whatsapp_personal" as const,
    account_id: "personal-one",
  },
  business = {
    source: "whatsapp_business" as const,
    account_id: "business-one",
  },
  linked = { source: "linkedin" as const, account_id: "urn:li:person:owner" };
const policy = parseSocialPolicy({
  window_days: 30,
  accounts: [
    {
      ...personal,
      provider: "unipile",
      owner_identity: "owner-user",
      owner_verified: true,
      api_base_url: "https://api1.unipile.com:13111",
    },
    {
      ...business,
      provider: "unipile",
      owner_identity: "business-owner",
      owner_verified: true,
      api_base_url: "https://api1.unipile.com:13111",
    },
    {
      ...linked,
      provider: "linkedin",
      owner_identity: linked.account_id,
      owner_verified: true,
      profile_bindings: [],
    },
  ],
})!;
function request(
  value: SocialReadInput,
): Extract<SocialReadInput, { available: true }> {
  if (!value.available) throw new Error(value.reason);
  return value;
}
function proof(
  value: SocialReadResult,
): Extract<SocialReadResult, { kind: "identity" }> {
  if (value.kind !== "identity")
    throw new Error(
      value.kind === "blocked" ? value.reason : "expected identity",
    );
  return value;
}
let runtime: Awaited<ReturnType<typeof postgresTestRuntime>>;

describe.each(["sqlite", "postgres"] as const)(
  "server-bound social read sessions %s",
  (backend) => {
    beforeAll(async () => {
      if (backend === "postgres") runtime = await postgresTestRuntime();
    }, 90000);
    afterAll(() => {
      if (backend === "postgres") runtime?.close();
    });
    let store: TendStore | LiveStore,
      owner: string,
      now: Date,
      sessions: SocialReadSessions;
    beforeEach(async () => {
      owner = "read-session-" + randomUUID();
      now = new Date("2026-10-14T12:00:00.000Z");
      const principal = { owner_id: owner, user_id: "u", chat_id: "c" };
      store =
        backend === "sqlite"
          ? new TendStore(":memory:", {
              mode: "live",
              principal,
              clock: () => now,
            })
          : await PostgresStore.open({
              connectionString: runtime.connectionString,
              principal,
              clock: () => now,
            });
      const window = socialWindow(now);
      await store.seed(
        [],
        [],
        [personal, business, linked].map((a) => ({
          owner_id: owner,
          ...a,
          mode: "live",
          last_success: null,
          status: "partial",
          coverage_start: window.start,
          coverage_end: window.end,
          cursor: null,
        })),
      );
      sessions = new SocialReadSessions({
        policy,
        store,
        principal_id: owner,
        clock: () => now,
      });
    });
    afterEach(async () => {
      await store.close();
    });
    async function identity(
      account: typeof personal | typeof business = personal,
    ): Promise<string> {
      const p = request(await sessions.plan({ ...account, phase: "identity" }));
      const body = {
        object: "Account",
        type: "WHATSAPP",
        id: account.account_id,
        connection_params: {
          im: {
            phone_number:
              account.source === "whatsapp_business"
                ? "business-owner"
                : "owner-user",
          },
        },
        sources: [{ status: "OK" }],
      };
      return proof(
        await sessions.result({ request_id: p.request_id, status: 200, body }),
      ).proof_id;
    }
    async function linkedIdentity(
      consent = now.getTime() - 86400000,
    ): Promise<string> {
      const p = request(await sessions.plan({ ...linked, phase: "identity" }));
      return proof(
        await sessions.result({
          request_id: p.request_id,
          status: 200,
          body: {
            elements: [
              {
                memberComplianceAuthorizationKey: { member: linked.account_id },
                memberComplianceScopes: ["DMA"],
                regulatedAt: consent,
              },
            ],
          },
        }),
      ).proof_id;
    }
    async function completeLinkedSnapshot(proof_id: string): Promise<void> {
      let p = request(
        await sessions.plan({ ...linked, phase: "snapshot", proof_id }),
      );
      expect(
        await sessions.result({
          request_id: p.request_id,
          status: 200,
          body: {
            elements: [{ snapshotDomain: "INBOX", snapshotData: [] }],
            paging: { start: 0, count: 10, links: [] },
          },
        }),
      ).toMatchObject({ kind: "page", complete: false });
      p = request(
        await sessions.plan({ ...linked, phase: "snapshot", proof_id }),
      );
      expect(
        await sessions.result({
          request_id: p.request_id,
          status: 400,
          body: { message: "No data found for this memberId" },
        }),
      ).toMatchObject({ kind: "page", complete: true });
    }
    it("keeps historical pagination and errors separate from incremental state", async () => {
      sessions = new SocialReadSessions({
        policy: { ...policy, history: { version: 1, mode: "all_available" } },
        historyResourceGate: async () => null,
        store,
        principal_id: owner,
        clock: () => now,
      });
      const before = await store.sourceStatus(owner);
      const proof_id = await identity();
      const selected = request(
        await sessions.plan({
          ...personal,
          phase: "snapshot",
          proof_id,
          lane: "history",
        }),
      );
      expect(selected.plan.coverage_start).toBe("0001-01-01T00:00:00.000Z");
      expect(new URL(selected.plan.url).searchParams.has("after")).toBe(false);
      const historicalResult = await sessions.result({
        request_id: selected.request_id,
        status: 200,
        body: {
          object: "MessageList",
          cursor: "history-page-two",
          items: [
            {
              id: "old-message",
              account_id: personal.account_id,
              chat_id: "old-thread",
              sender_id: "friend",
              timestamp: "2020-01-01T12:00:00Z",
              is_sender: false,
              text: "Historical source",
              attendees: [
                { attendee_provider_id: "owner-user" },
                { attendee_provider_id: "friend" },
              ],
            },
          ],
        },
      });
      expect(historicalResult.kind, JSON.stringify(historicalResult)).toBe(
        "page",
      );
      expect(historicalResult).toMatchObject({
        kind: "page",
        accepted: 1,
        complete: false,
      });
      expect(await store.sourceStatus(owner)).toEqual(before);
      expect((await store.historyBackfills(owner))[0]).toMatchObject({
        cursor: "history-page-two",
        page_count: 1,
      });
      const second = request(
        await sessions.plan({
          ...personal,
          phase: "snapshot",
          proof_id,
          lane: "history",
        }),
      );
      expect(second.plan.expected_cursor).toBe("history-page-two");
      expect(
        await sessions.result({
          request_id: second.request_id,
          status: 429,
          body: {},
          headers: { "Retry-After": "120" },
        }),
      ).toMatchObject({ kind: "blocked" });
      expect(await store.sourceStatus(owner)).toEqual(before);
      expect((await store.historyBackfills(owner))[0]).toMatchObject({
        cursor: "history-page-two",
        status: "paused",
        retry_after_until: "2026-10-14T12:02:00.000Z",
      });
    });
    async function retainedHistoryEvidence(
      resourceGate: () => Promise<string | null> = async () => null,
      incrementalSeed = false,
    ) {
      sessions = new SocialReadSessions({
        policy: { ...policy, history: { version: 1, mode: "all_available" } },
        historyResourceGate: resourceGate,
        store,
        principal_id: owner,
        clock: () => now,
      });
      const proof_id = await identity();
      const raw = {
        id: "retained-history",
        account_id: personal.account_id,
        chat_id: "retained-thread",
        sender_id: "friend",
        timestamp: "2026-10-13T12:00:00.000Z",
        is_sender: false,
        text: "Original retained source",
        attendees: [
          { attendee_provider_id: "owner-user" },
          { attendee_provider_id: "friend" },
        ],
      };
      const first = request(
        await sessions.plan({
          ...personal,
          phase: "snapshot",
          proof_id,
          ...(incrementalSeed ? {} : { lane: "history" }),
        }),
      );
      expect(
        await sessions.result({
          request_id: first.request_id,
          status: 200,
          body: {
            object: "MessageList",
            cursor: "retained-next",
            items: [raw],
          },
        }),
      ).toMatchObject({ kind: "page", accepted: 1 });
      const record = (await store.interactions(owner))[0]!;
      const prepared = {
        reply: {
          outbound_sent: false as const,
          normal_message: "Original retained source",
        },
        record_guards: [
          { record_key: record.record_key, content_hash: record.content_hash },
        ],
      };
      const auth = {
        owner_id: owner,
        user_id: "u",
        chat_id: "c",
        chat_type: "private",
        text: "Retained test briefing",
      };
      expect(await store.validatePreparedRead(auth, prepared)).toEqual(
        prepared.reply,
      );
      now = new Date(now.getTime() + 30000);
      await store.ingest({
        ...record,
        observed_at: now.toISOString(),
      } as import("../src/google-records.ts").LiveRecord);
      now = new Date(now.getTime() + 30000);
      return { proof_id, raw, prepared, auth };
    }
    it.each([
      ["provider deletion", { deleted: true }],
      ["provider hiding", { hidden: true }],
      ["edited content unavailable", { edited: true, text: null }],
    ])(
      "withdraws retained real-route test output after a confirmed %s",
      async (_label, mutation) => {
        const { proof_id, raw, prepared, auth } =
          await retainedHistoryEvidence();
        const before = await store.sourceStatus(owner);
        const planned = request(
          await sessions.plan({
            ...personal,
            phase: "snapshot",
            proof_id,
            lane: "history",
          }),
        );
        expect(
          await sessions.result({
            request_id: planned.request_id,
            status: 200,
            body: {
              object: "MessageList",
              cursor: null,
              items: [{ ...raw, ...mutation }],
            },
          }),
        ).toMatchObject({ kind: "page", removed: 1, complete: true });
        expect(
          (await store.interactions(owner)).some(
            (r) => r.source_record_id === raw.id,
          ),
        ).toBe(false);
        expect(await store.validatePreparedRead(auth, prepared)).not.toEqual(
          prepared.reply,
        );
        expect(
          JSON.stringify(await store.validatePreparedRead(auth, prepared)),
        ).not.toContain("Original retained source");
        expect(await store.sourceStatus(owner)).toEqual(before);
      },
    );
    it("accepts a freshly observed history edit while preserving the original message time", async () => {
      const { proof_id, raw, prepared, auth } = await retainedHistoryEvidence();
      const planned = request(
        await sessions.plan({
          ...personal,
          phase: "snapshot",
          proof_id,
          lane: "history",
        }),
      );
      expect(
        await sessions.result({
          request_id: planned.request_id,
          status: 200,
          body: {
            object: "MessageList",
            cursor: null,
            items: [
              {
                ...raw,
                edited: true,
                timestamp: now.toISOString(),
                text: "Changed provider source",
              },
            ],
          },
        }),
      ).toMatchObject({
        kind: "page",
        accepted: 1,
        removed: 0,
        complete: true,
      });
      const record = (await store.interactions(owner))[0]!;
      expect(record.body_text).toBe("Changed provider source");
      expect(record.occurred_at).toBe(raw.timestamp);
      expect(record.observed_at).toBe(now.toISOString());
      expect(await store.validatePreparedRead(auth, prepared)).not.toEqual(
        prepared.reply,
      );
    });
    it("applies confirmed withdrawals on a quarantined page without advancing or ingesting unrelated records", async () => {
      const { proof_id, raw, prepared, auth } = await retainedHistoryEvidence();
      const planned = request(
        await sessions.plan({
          ...personal,
          phase: "snapshot",
          proof_id,
          lane: "history",
        }),
      );
      expect(
        await sessions.result({
          request_id: planned.request_id,
          status: 200,
          body: {
            object: "MessageList",
            cursor: null,
            items: [
              { ...raw, deleted: true },
              {
                ...raw,
                id: "unrelated-new",
                text: "Do not ingest this partial page",
              },
              { ...raw, id: "unknown-attachment", text: null },
            ],
          },
        }),
      ).toMatchObject({
        kind: "blocked",
        reason: "history_page_requires_review",
      });
      expect(await store.interactions(owner)).toHaveLength(0);
      expect(await store.validatePreparedRead(auth, prepared)).not.toEqual(
        prepared.reply,
      );
      expect((await store.historyBackfills(owner))[0]).toMatchObject({
        cursor: "retained-next",
        page_count: 1,
        status: "paused",
        last_error: "history_page_requires_review",
      });
    });
    it.each([false, true])(
      "withdraws only confirmed invalid IDs when the result resource gate fails (quarantine %s)",
      async (quarantined) => {
        let checks = 0;
        const { proof_id, raw, prepared, auth } = await retainedHistoryEvidence(
          async () => (++checks === 1 ? null : "disk_floor"),
          true,
        );
        const before = await store.sourceStatus(owner);
        const planned = request(
          await sessions.plan({
            ...personal,
            phase: "snapshot",
            proof_id,
            lane: "history",
          }),
        );
        expect((await store.historyBackfills(owner))[0]).toMatchObject({
          cursor: null,
          page_count: 0,
        });
        expect(
          await sessions.result({
            request_id: planned.request_id,
            status: 200,
            body: {
              object: "MessageList",
              cursor: "not-advanced",
              items: [
                { ...raw, deleted: true },
                {
                  ...raw,
                  id: "other-valid",
                  text: "Must not ingest under resource floor",
                },
                ...(quarantined ? [{ ...raw, id: "unknown", text: null }] : []),
              ],
            },
          }),
        ).toMatchObject({ kind: "blocked", reason: "disk_floor" });
        expect(await store.interactions(owner)).toHaveLength(0);
        expect(await store.validatePreparedRead(auth, prepared)).not.toEqual(
          prepared.reply,
        );
        expect((await store.historyBackfills(owner))[0]).toMatchObject({
          cursor: null,
          page_count: 0,
          status: "paused",
          last_error: "disk_floor",
        });
        expect(await store.sourceStatus(owner)).toEqual(before);
        expect(
          await sessions.plan({
            ...personal,
            phase: "snapshot",
            proof_id,
            lane: "history",
          }),
        ).toMatchObject({ available: false, reason: "disk_floor" });
      },
    );
    it("requires a history resource measurement and rechecks it before committing a page", async () => {
      const approved = {
        ...policy,
        history: { version: 1, mode: "all_available" } as const,
      };
      sessions = new SocialReadSessions({
        policy: approved,
        store,
        principal_id: owner,
        clock: () => now,
      });
      let proof_id = await identity();
      expect(
        await sessions.plan({
          ...personal,
          phase: "snapshot",
          proof_id,
          lane: "history",
        }),
      ).toEqual({ available: false, reason: "history_resource_gate_required" });
      let checks = 0;
      sessions = new SocialReadSessions({
        policy: approved,
        store,
        principal_id: owner,
        clock: () => now,
        historyResourceGate: async () => (++checks === 1 ? null : "disk_floor"),
      });
      proof_id = await identity();
      const selected = request(
        await sessions.plan({
          ...personal,
          phase: "snapshot",
          proof_id,
          lane: "history",
        }),
      );
      expect(
        await sessions.result({
          request_id: selected.request_id,
          status: 200,
          body: { object: "MessageList", cursor: null, items: [] },
        }),
      ).toEqual({ kind: "blocked", reason: "disk_floor" });
      expect(checks).toBe(2);
      expect((await store.historyBackfills(owner))[0]).toMatchObject({
        status: "paused",
        last_error: "disk_floor",
        cursor: null,
        page_count: 0,
      });
    });
    it("rejects history lanes without approval or with changelog operations", async () => {
      expect(
        await sessions.plan({
          ...personal,
          phase: "identity",
          lane: "history",
        }),
      ).toMatchObject({ available: false });
      sessions = new SocialReadSessions({
        policy: { ...policy, history: { version: 1, mode: "all_available" } },
        historyResourceGate: async () => null,
        store,
        principal_id: owner,
        clock: () => now,
      });
      const proof_id = await linkedIdentity();
      expect(
        await sessions.plan({
          ...linked,
          phase: "changes",
          proof_id,
          lane: "history",
        }),
      ).toMatchObject({ available: false });
      expect(await store.historyBackfills(owner)).toEqual([]);
    });
    it.each(["wrong_phone", "wrong_account"] as const)(
      "rejects Business identity %s without issuing a proof",
      async (invalid) => {
        const planned = request(
          await sessions.plan({ ...business, phase: "identity" }),
        );
        expect(
          await sessions.result({
            request_id: planned.request_id,
            status: 200,
            body: {
              object: "Account",
              type: "WHATSAPP",
              id:
                invalid === "wrong_account"
                  ? personal.account_id
                  : business.account_id,
              connection_params: {
                im: {
                  phone_number:
                    invalid === "wrong_phone" ? "owner-user" : "business-owner",
                },
              },
              sources: [{ status: "OK" }],
            },
          }),
        ).toEqual({ kind: "blocked", reason: "unverified_provider_owner" });
        expect((await store.counts(owner)).interactions).toBe(0);
      },
    );
    it("binds Personal and Business proofs independently in both directions", async () => {
      const personalProof = await identity(),
        businessProof = await identity(business);
      for (const [account, proof_id] of [
        [business, personalProof],
        [personal, businessProof],
      ] as const) {
        expect(
          await sessions.plan({ ...account, phase: "snapshot", proof_id }),
        ).toEqual({
          available: false,
          reason: "fresh_identity_proof_required",
        });
      }
      const selected = request(
        await sessions.plan({
          ...business,
          phase: "snapshot",
          proof_id: businessProof,
        }),
      );
      expect(selected.plan.source).toBe("whatsapp_business");
      expect(selected.plan.account_id).toBe(business.account_id);
      expect(selected.plan.expected_owner_identity).toBe("business-owner");
      expect(
        await sessions.result({
          request_id: selected.request_id,
          status: 200,
          body: {
            object: "MessageList",
            cursor: null,
            items: [
              {
                id: "business-message",
                account_id: business.account_id,
                chat_id: "business-thread",
                sender_id: "business-friend",
                timestamp: "2026-10-13T12:00:00Z",
                is_sender: false,
                text: "Business fictional text",
                attendees: [
                  { attendee_provider_id: "business-owner" },
                  { attendee_provider_id: "business-friend" },
                ],
              },
            ],
          },
        }),
      ).toMatchObject({ kind: "page", accepted: 1, complete: true });
      expect((await store.interactions(owner))[0]?.source).toBe(
        "whatsapp_business",
      );
      expect(
        (await store.sourceStatus(owner)).find(
          (value) => value.source === "whatsapp_personal",
        )?.last_success,
      ).toBeNull();
      expect(
        await sessions.result({
          request_id: selected.request_id,
          status: 200,
          body: {},
        }),
      ).toEqual({
        kind: "blocked",
        reason: "social_request_expired_or_consumed",
      });
    });
    it("expires Business pending reads and proof sessions without transferable recovery", async () => {
      const pending = request(
        await sessions.plan({ ...business, phase: "identity" }),
      );
      now = new Date(now.getTime() + 120000);
      expect(
        await sessions.result({
          request_id: pending.request_id,
          status: 200,
          body: {},
        }),
      ).toEqual({
        kind: "blocked",
        reason: "social_request_expired_or_consumed",
      });
      const proof_id = await identity(business);
      const restarted = new SocialReadSessions({
        policy,
        store,
        principal_id: owner,
        clock: () => now,
      });
      expect(
        await restarted.plan({ ...business, phase: "snapshot", proof_id }),
      ).toEqual({ available: false, reason: "fresh_identity_proof_required" });
      now = new Date(now.getTime() + 300000);
      expect(
        await sessions.plan({ ...business, phase: "snapshot", proof_id }),
      ).toEqual({ available: false, reason: "fresh_identity_proof_required" });
      expect((await store.counts(owner)).interactions).toBe(0);
    });
    it("requires fresh exact-account identity proof before planning approved history", async () => {
      sessions = new SocialReadSessions({
        policy: { ...policy, history: { version: 1, mode: "all_available" } },
        store,
        principal_id: owner,
        clock: () => now,
        historyResourceGate: async () => null,
      });
      const denied = {
        available: false,
        reason: "fresh_identity_proof_required",
      };
      expect(
        await sessions.plan({
          ...personal,
          phase: "snapshot",
          lane: "history",
        }),
      ).toEqual(denied);
      const wrongProof = await identity(business);
      expect(
        await sessions.plan({
          ...personal,
          phase: "snapshot",
          lane: "history",
          proof_id: wrongProof,
        }),
      ).toEqual(denied);
      expect(await store.historyBackfills(owner)).toEqual([]);
      const proof_id = await identity(personal);
      expect(
        await sessions.plan({
          ...personal,
          phase: "snapshot",
          lane: "history",
          proof_id,
        }),
      ).toMatchObject({ available: true });
      const before = await store.historyBackfills(owner);
      now = new Date(now.getTime() + 300001);
      expect(
        await sessions.plan({
          ...personal,
          phase: "snapshot",
          lane: "history",
          proof_id,
        }),
      ).toEqual(denied);
      expect(await store.historyBackfills(owner)).toEqual(before);
    });
    it("requires server-issued exact owner proof and never accepts caller plans", async () => {
      expect(
        await sessions.plan({
          ...personal,
          phase: "snapshot",
          proof_id: "made-up",
        }),
      ).toEqual({ available: false, reason: "fresh_identity_proof_required" });
      expect(
        await sessions.plan({
          ...personal,
          phase: "identity",
          plan: { url: "https://evil.invalid" },
        }),
      ).toEqual({ available: false, reason: "unknown_social_session_field" });
      const p = request(
        await sessions.plan({ ...personal, phase: "identity" }),
      );
      p.plan.expected_owner_identity = "forged";
      p.plan.url = "https://evil.invalid";
      expect(
        await sessions.result({
          request_id: p.request_id,
          status: 200,
          body: {
            object: "Account",
            type: "WHATSAPP",
            id: personal.account_id,
            connection_params: { im: { phone_number: "forged" } },
            sources: [{ status: "OK" }],
          },
        }),
      ).toEqual({ kind: "blocked", reason: "unverified_provider_owner" });
      expect(
        await sessions.result({
          request_id: p.request_id,
          status: 200,
          body: {},
        }),
      ).toEqual({
        kind: "blocked",
        reason: "social_request_expired_or_consumed",
      });
      expect((await store.counts(owner)).interactions).toBe(0);
    });
    it("expires pending reads at120seconds and exact-account proofs at5minutes", async () => {
      const pending = request(
        await sessions.plan({ ...personal, phase: "identity" }),
      );
      now = new Date(now.getTime() + 120000);
      expect(
        await sessions.result({
          request_id: pending.request_id,
          status: 200,
          body: {},
        }),
      ).toMatchObject({
        kind: "blocked",
        reason: "social_request_expired_or_consumed",
      });
      const proof_id = await identity();
      expect(
        await sessions.plan({ ...linked, phase: "snapshot", proof_id }),
      ).toMatchObject({
        available: false,
        reason: "fresh_identity_proof_required",
      });
      now = new Date(now.getTime() + 300000);
      expect(
        await sessions.plan({ ...personal, phase: "snapshot", proof_id }),
      ).toMatchObject({
        available: false,
        reason: "fresh_identity_proof_required",
      });
    });
    it("bounds concurrent pending plans and identity proofs to32without eviction", async () => {
      const plans = await Promise.all(
        Array.from({ length: 40 }, () =>
          sessions.plan({ ...personal, phase: "identity" }),
        ),
      );
      expect(plans.filter((x) => x.available)).toHaveLength(32);
      expect(plans.filter((x) => !x.available)).toHaveLength(8);
      for (const p of plans)
        if (p.available)
          expect(
            (
              await sessions.result({
                request_id: p.request_id,
                status: 200,
                body: {
                  object: "Account",
                  type: "WHATSAPP",
                  id: personal.account_id,
                  connection_params: { im: { phone_number: "owner-user" } },
                  sources: [{ status: "OK" }],
                },
              })
            ).kind,
          ).toBe("identity");
      const p = request(
        await sessions.plan({ ...personal, phase: "identity" }),
      );
      expect(
        await sessions.result({
          request_id: p.request_id,
          status: 200,
          body: {
            object: "Account",
            type: "WHATSAPP",
            id: personal.account_id,
            connection_params: { im: { phone_number: "owner-user" } },
            sources: [{ status: "OK" }],
          },
        }),
      ).toMatchObject({
        kind: "blocked",
        reason: "identity_proof_capacity_reached",
      });
    });
    it("consumes failed responses without advancing cursors or persisting provider text", async () => {
      const proof_id = await identity(),
        p = request(
          await sessions.plan({ ...personal, phase: "snapshot", proof_id }),
        );
      expect(p.plan.method).toBe("GET");
      expect(p.plan.follow_redirects).toBe(false);
      expect(p.plan.url).toContain("api1.unipile.com:13111/api/v1/messages");
      expect(
        await sessions.result({
          request_id: p.request_id,
          status: 429,
          body: { message: "PRIVATE PROVIDER DETAIL" },
        }),
      ).toEqual({ kind: "blocked", reason: "provider_read_failed" });
      expect(
        (await store.sourceStatus(owner)).find(
          (s) => s.source === personal.source,
        )!.cursor,
      ).toBeNull();
      expect((await store.counts(owner)).interactions).toBe(0);
    });

    it("revokes401andambiguous403 and requires reconnect before any further reads", async () => {
      const proof_id = await identity();
      let p = request(
        await sessions.plan({ ...personal, phase: "snapshot", proof_id }),
      );
      expect(
        await sessions.result({
          request_id: p.request_id,
          status: 200,
          body: {
            object: "MessageList",
            cursor: null,
            items: [
              {
                id: "auth-record",
                account_id: personal.account_id,
                chat_id: "auth-thread",
                sender_id: "other-user",
                timestamp: "2026-10-13T12:00:00Z",
                is_sender: false,
                text: "I'll send it.",
                attendees: [
                  { attendee_provider_id: "owner-user" },
                  { attendee_provider_id: "other-user" },
                ],
              },
            ],
          },
        }),
      ).toMatchObject({ kind: "page", accepted: 1 });
      const record = (await store.interactions(owner))[0]!,
        candidate = await store.addCandidate(record, {
          quote: "I'll send it.",
          action: "send it.",
          suggested_due: null,
        }),
        auth = {
          owner_id: owner,
          user_id: "u",
          chat_id: "c",
          chat_type: "private",
          text: `/confirm ${candidate.commitment_id} 2026-10-15`,
        };
      await store.command(auth);
      await store.telegramCommand({ ...auth, text: "/status" }, "auth-test", 1);
      p = request(
        await sessions.plan({ ...personal, phase: "snapshot", proof_id }),
      );
      expect(
        await sessions.result({
          request_id: p.request_id,
          status: 401,
          body: { message: "PRIVATE AUTH ERROR" },
        }),
      ).toEqual({ kind: "blocked", reason: "provider_read_failed" });
      expect(
        (await store.sourceStatus(owner)).find(
          (s) => s.source === personal.source,
        )!.status,
      ).toBe("revoked");
      expect(await sessions.plan({ ...personal, phase: "identity" })).toEqual({
        available: false,
        reason: "unavailable_social_account",
      });
      expect((await store.counts(owner)).interactions).toBe(0);
      expect((await store.commitments(owner))[0]).toMatchObject({
        status: "confirmed",
        due_date: "2026-10-15",
        evidence_valid: false,
        quote: "",
        action: "",
      });
      expect(
        await store.pendingTelegramReply(owner, "auth-test", 1),
      ).toBeNull();
      p = request(await sessions.plan({ ...linked, phase: "identity" }));
      expect(
        await sessions.result({
          request_id: p.request_id,
          status: 403,
          body: {},
        }),
      ).toMatchObject({ kind: "blocked" });
      expect(
        (await store.sourceStatus(owner)).find((s) => s.source === "linkedin")!
          .status,
      ).toBe("revoked");
    });
    it("preserves chat rate-limit reasons, bounded backoff and the page cursor", async () => {
      const proof_id = await identity();
      const p = request(
        await sessions.plan({ ...personal, phase: "snapshot", proof_id }),
      );
      expect(
        await sessions.result({
          request_id: p.request_id,
          status: 429,
          body: { error: "whatsapp_chat_rate_limited" },
          headers: { "Retry-After": "999999" },
        }),
      ).toEqual({ kind: "blocked", reason: "whatsapp_chat_rate_limited" });
      expect(
        (await store.sourceStatus(owner)).find(
          (s) => s.source === personal.source,
        ),
      ).toMatchObject({
        cursor: null,
        last_error: 429,
        retry_after_until: new Date(now.getTime() + 86400000).toISOString(),
      });
      expect(
        await sessions.plan({ ...personal, phase: "snapshot", proof_id }),
      ).toEqual({ available: false, reason: "provider_retry_not_due" });
    });
    it("records bounded provider backoff and malformed200 without changing cursor", async () => {
      const proof_id = await identity();
      let p = request(
        await sessions.plan({ ...personal, phase: "snapshot", proof_id }),
      );
      await sessions.result({
        request_id: p.request_id,
        status: 429,
        body: {},
        headers: { "Retry-After": "60" },
      });
      let state = (await store.sourceStatus(owner)).find(
        (s) => s.source === personal.source,
      )!;
      expect(state).toMatchObject({
        status: "stale",
        cursor: null,
        last_error: 429,
        retry_after_until: new Date(now.getTime() + 60000).toISOString(),
      });
      expect(
        await sessions.plan({ ...personal, phase: "snapshot", proof_id }),
      ).toEqual({ available: false, reason: "provider_retry_not_due" });
      now = new Date(now.getTime() + 60000);
      p = request(
        await sessions.plan({ ...personal, phase: "snapshot", proof_id }),
      );
      expect(
        await sessions.result({
          request_id: p.request_id,
          status: 200,
          body: { not: "a provider page" },
        }),
      ).toMatchObject({ kind: "blocked" });
      state = (await store.sourceStatus(owner)).find(
        (s) => s.source === personal.source,
      )!;
      expect(state).toMatchObject({
        status: "stale",
        cursor: null,
        last_error: 599,
        attempt_count: 2,
      });
      p = request(await sessions.plan({ ...linked, phase: "identity" }));
      expect(
        await sessions.result({
          request_id: p.request_id,
          status: 503,
          body: {},
          headers: { Authorization: "must never be accepted" },
        }),
      ).toEqual({ kind: "blocked", reason: "invalid_retry_header" });
    });
    it("commits only a mapped provider page and returns scalar evidence receipts", async () => {
      const proof_id = await identity(),
        p = request(
          await sessions.plan({ ...personal, phase: "snapshot", proof_id }),
        );
      const result = await sessions.result({
        request_id: p.request_id,
        status: 200,
        body: {
          object: "MessageList",
          cursor: null,
          items: [
            {
              id: "message-1",
              account_id: personal.account_id,
              chat_id: "thread-1",
              sender_id: "other-user",
              timestamp: "2026-10-13T12:00:00Z",
              is_sender: false,
              text: "PRIVATE FICTIONAL BODY",
              attendees: [
                { attendee_provider_id: "owner-user" },
                { attendee_provider_id: "other-user" },
              ],
            },
          ],
        },
      });
      expect(result).toMatchObject({
        kind: "page",
        accepted: 1,
        complete: true,
        gap_free: false,
      });
      expect(JSON.stringify(result)).not.toContain("PRIVATE FICTIONAL BODY");
      expect((await store.counts(owner)).interactions).toBe(1);
      expect(
        await sessions.result({
          request_id: p.request_id,
          status: 200,
          body: {},
        }),
      ).toEqual({
        kind: "blocked",
        reason: "social_request_expired_or_consumed",
      });
    });
    it("hands terminal partial LinkedIn snapshots to changes without erasing historical gaps", async () => {
      const proof_id = await linkedIdentity();
      let p = request(
        await sessions.plan({ ...linked, phase: "snapshot", proof_id }),
      );
      expect(
        await sessions.result({
          request_id: p.request_id,
          status: 200,
          body: {
            elements: [
              {
                snapshotDomain: "INBOX",
                snapshotData: [
                  {
                    "CONVERSATION ID": "unattributed",
                    DATE: "2026-10-13T12:00:00Z",
                    FROM: "Unknown",
                    TO: "Owner",
                    CONTENT: "Unattributed historical evidence",
                  },
                ],
              },
            ],
            paging: { start: 0, count: 10, links: [] },
          },
        }),
      ).toMatchObject({ kind: "page", accepted: 0, quarantined: 1 });
      p = request(
        await sessions.plan({ ...linked, phase: "snapshot", proof_id }),
      );
      await sessions.result({
        request_id: p.request_id,
        status: 404,
        body: {
          status: 404,
          message: "No data found for this domain and memberId.",
        },
      });
      const before = (await store.sourceStatus(owner)).find(
        (x) => x.source === "linkedin",
      )!;
      expect(before).toMatchObject({
        status: "partial",
        cursor: null,
        pagination_complete: true,
        evidence_incomplete: true,
        last_success: null,
      });
      const changes = request(
        await sessions.plan({ ...linked, phase: "changes", proof_id }),
      );
      const baseline = `li-change:${now.getTime() - 86400000}`;
      expect(changes.plan.expected_cursor).toBe(baseline);
      expect(
        (await store.sourceStatus(owner)).find((x) => x.source === "linkedin"),
      ).toMatchObject({
        status: "partial",
        cursor: baseline,
        pagination_complete: false,
        evidence_incomplete: true,
        last_success: null,
      });
      expect(
        await sessions.result({
          request_id: changes.request_id,
          status: 200,
          body: { elements: [] },
        }),
      ).toMatchObject({ kind: "page", complete: false, gap_free: false });
      expect(
        (await store.sourceStatus(owner)).find((x) => x.source === "linkedin"),
      ).toMatchObject({
        status: "partial",
        cursor: baseline,
        evidence_incomplete: true,
        last_success: null,
      });
      expect(
        await sessions.result({
          request_id: changes.request_id,
          status: 200,
          body: { elements: [] },
        }),
      ).toEqual({
        kind: "blocked",
        reason: "social_request_expired_or_consumed",
      });
      now = new Date(now.getTime() + 60000);
      expect(
        request(await sessions.plan({ ...linked, phase: "changes", proof_id }))
          .plan.expected_cursor,
      ).toBe(baseline);
      expect(await store.quarantineCount(owner)).toBe(1);
    });
    it("rejects an unproven or revoked snapshot handoff in the store transaction", async () => {
      const base = (await store.sourceStatus(owner)).find(
        (x) => x.source === "linkedin",
      )!;
      let index = 0;
      for (const patch of [
        { status: "partial", cursor: null },
        { status: "partial", cursor: null, pagination_complete: false },
        {
          status: "partial",
          cursor: "li-snapshot:1",
          pagination_complete: true,
        },
        { status: "stale", cursor: null, pagination_complete: true },
        { status: "revoked", cursor: null, pagination_complete: true },
      ]) {
        const account_id = `urn:li:person:negative-${index++}`;
        const next = { ...base, account_id, ...patch };
        await store.seed([], [], [next]);
        await expect(
          Promise.resolve().then(() =>
            store.prepareLiveSnapshot(
              owner,
              "linkedin",
              account_id,
              base.coverage_start,
              base.coverage_end,
              `li-change:${now.getTime() - 86400000}`,
            ),
          ),
        ).rejects.toThrow();
        expect(
          (await store.sourceStatus(owner)).find(
            (x) => x.account_id === account_id,
          ),
        ).toEqual(next);
      }
    });
    it("rejects a stale terminal snapshot despite a still-fresh identity proof", async () => {
      const proof_id = await linkedIdentity();
      await completeLinkedSnapshot(proof_id);
      await store.markLiveSyncError(
        owner,
        "linkedin",
        linked.account_id,
        false,
        null,
        500,
      );
      const before = (await store.sourceStatus(owner)).find(
        (s) => s.source === "linkedin",
      )!;
      expect(before).toMatchObject({
        status: "stale",
        cursor: null,
        pagination_complete: true,
      });
      expect(
        await sessions.plan({ ...linked, phase: "changes", proof_id }),
      ).toEqual({
        available: false,
        reason: "completed_snapshot_required_before_changes",
      });
      expect(
        (await store.sourceStatus(owner)).find((s) => s.source === "linkedin"),
      ).toEqual(before);
    });
    it("requires completed LinkedIn snapshot then preserves changelog watermark across fresh windows", async () => {
      const proof_id = await linkedIdentity();
      expect(
        await sessions.plan({ ...linked, phase: "changes", proof_id }),
      ).toEqual({
        available: false,
        reason: "completed_snapshot_required_before_changes",
      });
      await completeLinkedSnapshot(proof_id);
      let p = request(
        await sessions.plan({ ...linked, phase: "changes", proof_id }),
      );
      const baseline = p.plan.expected_cursor;
      expect(baseline).toMatch(/^li-change:/);
      const progressed = now.getTime() - 1000;
      expect(
        await sessions.result({
          request_id: p.request_id,
          status: 200,
          body: {
            elements: [
              {
                owner: linked.account_id,
                processedAt: progressed,
                resourceName: "connections",
                activityStatus: "SUCCESS",
              },
            ],
          },
        }),
      ).toMatchObject({ kind: "page", complete: false, gap_free: false });
      now = new Date(now.getTime() + 60000);
      p = request(
        await sessions.plan({ ...linked, phase: "changes", proof_id }),
      );
      expect(p.plan.expected_cursor).toBe(`li-change:${progressed}`);
      expect(p.plan.coverage_end).toBe(now.toISOString());
      expect(p.plan.coverage_start).toBe(socialWindow(now).start);
      await expect(
        Promise.resolve().then(() =>
          store.prepareLiveSnapshot(
            owner,
            "linkedin",
            linked.account_id,
            p.plan.coverage_start,
            p.plan.coverage_end,
            baseline!,
          ),
        ),
      ).rejects.toThrow("stale");
      expect(
        await sessions.plan({ ...linked, phase: "snapshot", proof_id }),
      ).toEqual({
        available: false,
        reason: "changelog_cannot_reset_to_snapshot",
      });
    });

    it("keeps connection previews transient, bounded and separate from the durable changelog cursor", async () => {
      const proof_id = await linkedIdentity();
      await completeLinkedSnapshot(proof_id);
      const changes = request(
        await sessions.plan({ ...linked, phase: "changes", proof_id }),
      );
      await sessions.result({
        request_id: changes.request_id,
        status: 200,
        body: { elements: [] },
      });
      const before = (await store.sourceStatus(owner)).find(
        (s) => s.source === "linkedin",
      )!;
      expect(before.cursor).toMatch(/^li-change:/);
      const first = request(
          await sessions.plan({ ...linked, phase: "connections", proof_id }),
        ),
        racing = request(
          await sessions.plan({ ...linked, phase: "connections", proof_id }),
        );
      expect(first.plan.url).toContain("domain=CONNECTIONS");
      const body = {
        elements: [
          {
            snapshotDomain: "CONNECTIONS",
            snapshotData: Array.from({ length: 25 }, () => ({
              "First Name": "字".repeat(300),
              "Last Name": "Friend",
              URL: "https://evil.invalid",
              "Email Address": "private@example.com",
            })),
          },
        ],
        paging: { start: 0, count: 10, links: [] },
      };
      const result = await sessions.result({
        request_id: first.request_id,
        status: 200,
        body,
      });
      expect(result).toMatchObject({
        kind: "connections",
        transient: true,
        schema_verified: false,
        identity_bindings_verified: false,
        requires_owner_review: true,
        omitted_row_count: 5,
      });
      if (result.kind !== "connections") throw new Error("preview");
      expect(result.rows).toHaveLength(20);
      expect(result.unknown_field_count).toBeGreaterThan(0);
      for (const row of result.rows) {
        expect(Object.keys(row).sort()).toEqual(["First Name", "Last Name"]);
        for (const value of Object.values(row))
          expect(Buffer.byteLength(value)).toBeLessThanOrEqual(512);
      }
      expect(JSON.stringify(result)).not.toContain("private@example.com");
      expect(JSON.stringify(result)).not.toContain("evil.invalid");
      expect(
        await sessions.result({
          request_id: racing.request_id,
          status: 200,
          body,
        }),
      ).toEqual({
        kind: "blocked",
        reason: "stale_connections_preview_cursor",
      });
      const next = request(
        await sessions.plan({ ...linked, phase: "connections", proof_id }),
      );
      expect(next.plan.expected_cursor).toBe("li-connections:1");
      expect(
        await sessions.result({
          request_id: next.request_id,
          status: 404,
          body: { message: "No data found for this memberId" },
        }),
      ).toMatchObject({ kind: "connections", complete: true });
      expect(
        (await store.sourceStatus(owner)).find((s) => s.source === "linkedin"),
      ).toEqual(before);
      expect(await store.contacts(owner)).toEqual([]);
      expect((await store.counts(owner)).interactions).toBe(0);
      expect(
        await sessions.plan({ ...linked, phase: "connections", proof_id }),
      ).toEqual({ available: false, reason: "connections_preview_complete" });
      now = new Date(now.getTime() + 300000);
      expect(
        await sessions.plan({ ...linked, phase: "connections", proof_id }),
      ).toMatchObject({
        available: false,
        reason: "fresh_identity_proof_required",
      });
    });
    it("refuses old consent gaps and invalidates proofs when a source is revoked", async () => {
      const proof_id = await linkedIdentity(now.getTime() - 29 * 86400000);
      await completeLinkedSnapshot(proof_id);
      expect(
        await sessions.plan({ ...linked, phase: "changes", proof_id }),
      ).toEqual({ available: false, reason: "changelog_retention_gap" });
      expect(
        (await store.sourceStatus(owner)).find((s) => s.source === "linkedin")!
          .status,
      ).toBe("current");
      const pp = await identity(),
        p = request(
          await sessions.plan({ ...personal, phase: "snapshot", proof_id: pp }),
        );
      await store.revokeSource(owner, "whatsapp_personal");
      expect(
        await sessions.result({
          request_id: p.request_id,
          status: 200,
          body: { object: "MessageList", items: [], cursor: null },
        }),
      ).toEqual({ kind: "blocked", reason: "unavailable_social_account" });
    });
  },
);
