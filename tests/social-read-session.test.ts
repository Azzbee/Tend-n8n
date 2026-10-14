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
        [personal, linked].map((a) => ({
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
    async function identity(account = personal): Promise<string> {
      const p = request(await sessions.plan({ ...account, phase: "identity" }));
      const body =
        account.source === "whatsapp_personal"
          ? {
              object: "Account",
              type: "WHATSAPP",
              id: account.account_id,
              connection_params: { im: { phone_number: "owner-user" } },
              sources: [{ status: "OK" }],
            }
          : {
              elements: [
                {
                  memberComplianceAuthorizationKey: {
                    member: account.account_id,
                  },
                  memberComplianceScopes: ["DMA"],
                  regulatedAt: now.getTime() - 86400000,
                },
              ],
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
