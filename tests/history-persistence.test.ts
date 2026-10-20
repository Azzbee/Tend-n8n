import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { TendStore, type SourceState } from "../src/engine.ts";
import { PostgresStore } from "../src/postgres-store.ts";
import { postgresTestRuntime } from "./postgres-test-runtime.ts";
import type { HistoryPageCommit } from "../src/live-store.ts";
import {
  DailyBriefingService,
  type DailyBriefingRow,
} from "../src/daily-briefing.ts";
import { exampleLivePolicy, type LivePolicy } from "../src/live-policy.ts";
const principal = {
  owner_id: "history-owner",
  user_id: "1234",
  chat_id: "1234",
};
const now = "2026-10-20T10:00:00.000Z";
const state: SourceState = {
  owner_id: principal.owner_id,
  source: "gmail",
  account_id: "owner@example.invalid",
  status: "partial",
  mode: "live",
  cursor: "incremental-kept",
  coverage_start: "2026-09-20T10:00:00.000Z",
  coverage_end: now,
  last_success: null,
};
const page = (): HistoryPageCommit => ({
  owner_id: principal.owner_id,
  source: "gmail",
  account_id: state.account_id,
  version: 1,
  watermark: now,
  expected_cursor: null,
  cursor: "history-next",
  operation_hash: "a".repeat(64),
  complete: false,
  contacts: [
    { owner_id: principal.owner_id, contact_id: "peer", name: "Peer" },
  ],
  identities: [
    {
      owner_id: principal.owner_id,
      contact_id: "peer",
      identity: "peer@example.invalid",
    },
  ],
  records: [
    {
      owner_id: principal.owner_id,
      source: "gmail",
      account_id: state.account_id,
      source_record_id: "older",
      source_thread_id: "thread",
      kind: "message",
      direction: "received",
      actor_identity: "peer@example.invalid",
      participant_identities: [state.account_id],
      occurred_at: "2024-01-01T10:00:00.000Z",
      observed_at: now,
      body_text: "Historical evidence",
      evidence_reference: "tend-source:fixture/older",
      ingestion_mode: "live",
      coverage_start: "0001-01-01T00:00:00.000Z",
      coverage_end: now,
      cancelled: false,
      contact_ids: ["peer"],
      authored_text: "Historical evidence",
      authored_spans: [],
      attribution: "direct",
      eligible_for_extraction: false,
    },
  ],
});
const daily = (): DailyBriefingRow => ({
  owner_id: principal.owner_id,
  paris_date: "2026-10-20",
  delivery_id: "00000000-0000-4000-8000-000000000001",
  revision: 0,
  scheduled_at: "2026-10-20T07:00:00.000Z",
  updated_at: now,
  state: "pending",
  attempts: 0,
  prepared: null,
  prepared_at: null,
  telegram_message_id: null,
  failure: null,
});
describe("separate history and daily ledgers", () => {
  let runtime: Awaited<ReturnType<typeof postgresTestRuntime>>;
  let pg: PostgresStore;
  let sqlite: TendStore;
  const clocks = { sqlite: now, postgres: now };
  beforeAll(async () => {
    runtime = await postgresTestRuntime();
    pg = await PostgresStore.open({
      connectionString: runtime.connectionString,
      principal,
      clock: () => new Date(clocks.postgres),
    });
    sqlite = new TendStore(":memory:", {
      mode: "live",
      principal,
      clock: () => new Date(clocks.sqlite),
    });
    for (const store of [pg, sqlite])
      await store.seed(
        [{ owner_id: principal.owner_id, contact_id: "OWNER", name: "Owner" }],
        [
          {
            owner_id: principal.owner_id,
            identity: state.account_id,
            contact_id: "OWNER",
          },
        ],
        [state],
      );
  }, 60000);
  afterAll(async () => {
    await pg?.close();
    sqlite?.close();
    runtime?.close();
  });
  for (const kind of ["sqlite", "postgres"] as const) {
    const store = () => (kind === "sqlite" ? sqlite : pg);
    it(
      kind + " freezes a separate watermark and preserves incremental cursor",
      async () => {
        const first = await store().beginHistoryBackfill(
          principal.owner_id,
          "gmail",
          state.account_id,
          now,
        );
        expect(first).toMatchObject({
          version: 1,
          watermark: now,
          cursor: null,
          page_count: 0,
          status: "pending",
        });
        expect(
          await store().beginHistoryBackfill(
            principal.owner_id,
            "gmail",
            state.account_id,
            "2026-10-19T10:00:00.000Z",
          ),
        ).toEqual(first);
        expect(
          (await store().sourceStatus(principal.owner_id))[0]?.cursor,
        ).toBe("incremental-kept");
      },
    );
    it(
      kind +
        " commits historical evidence and checkpoint atomically and idempotently",
      async () => {
        expect(await store().commitHistoryBackfill(page())).toHaveLength(1);
        expect(await store().commitHistoryBackfill(page())).toEqual([]);
        expect(
          (await store().historyBackfills(principal.owner_id))[0],
        ).toMatchObject({
          page_count: 1,
          record_count: 1,
          oldest_at: page().records[0]!.occurred_at,
          cursor: "history-next",
        });
        expect((await store().sourceStatus(principal.owner_id))[0]).toEqual(
          state,
        );
        const stale = { ...page(), operation_hash: "b".repeat(64) };
        await expect(
          Promise.resolve().then(() => store().commitHistoryBackfill(stale)),
        ).rejects.toThrow(/cursor/);
        expect((await store().counts()).interactions).toBe(1);
      },
    );
    it(
      kind + " rolls back a partially invalid page and rejects future evidence",
      async () => {
        const valid = {
          ...page().records[0]!,
          source_record_id: "rollback-first",
        };
        const invalid = {
          ...valid,
          source_record_id: "rollback-second",
          actor_identity: "unknown@example.invalid",
        };
        const input = {
          ...page(),
          expected_cursor: "history-next",
          cursor: "after-invalid",
          operation_hash: "d".repeat(64),
          records: [valid, invalid],
        };
        await expect(
          Promise.resolve().then(() => store().commitHistoryBackfill(input)),
        ).rejects.toThrow(/identity/);
        expect((await store().counts()).interactions).toBe(1);
        expect(
          (await store().historyBackfills(principal.owner_id))[0]?.cursor,
        ).toBe("history-next");
        await expect(
          Promise.resolve().then(() =>
            store().commitHistoryBackfill({
              ...input,
              records: [{ ...valid, occurred_at: "2026-10-21T10:00:00.000Z" }],
            }),
          ),
        ).rejects.toThrow(/timestamp/);
      },
    );
    it(
      kind +
        " validates old retained evidence only under approved history policy",
      async () => {
        const record = (await store().interactions(principal.owner_id))[0]!;
        const prepared = {
          reply: {
            outbound_sent: false as const,
            warning: "Historical evidence",
          },
          record_guards: [
            {
              record_key: record.record_key,
              content_hash: record.content_hash,
            },
          ],
        };
        const auth = { ...principal, chat_type: "private", text: "history" };
        expect(await store().validatePreparedRead(auth, prepared)).not.toEqual(
          prepared.reply,
        );
        const policy: LivePolicy = {
          ...exampleLivePolicy,
          history: { version: 1, mode: "all_available" },
        };
        expect(
          await store().validatePreparedRead(auth, prepared, policy),
        ).toEqual(prepared.reply);
        expect(
          await store().validatePreparedRead(auth, prepared, {
            ...policy,
            account_email: "removed@example.invalid",
            verified_owner_emails: ["removed@example.invalid"],
          }),
        ).not.toEqual(prepared.reply);
      },
    );
    it(
      kind + " preserves progress while paused and requires quota wait",
      async () => {
        await store().pauseHistoryBackfill(
          principal.owner_id,
          "gmail",
          state.account_id,
          "provider_quota",
          "2026-10-20T11:00:00.000Z",
        );
        expect(
          (await store().historyBackfills(principal.owner_id))[0],
        ).toMatchObject({
          status: "paused",
          page_count: 1,
          cursor: "history-next",
        });
        await expect(
          Promise.resolve().then(() =>
            store().commitHistoryBackfill({
              ...page(),
              expected_cursor: "history-next",
              operation_hash: "c".repeat(64),
              cursor: null,
              complete: true,
            }),
          ),
        ).rejects.toThrow(/wait/);
      },
    );
    it(kind + " rejects unknown and cross-owner history accounts", async () => {
      await expect(
        Promise.resolve().then(() =>
          store().beginHistoryBackfill("other", "gmail", state.account_id, now),
        ),
      ).rejects.toThrow(/owner/);
      await expect(
        Promise.resolve().then(() =>
          store().beginHistoryBackfill(
            principal.owner_id,
            "gmail",
            "other@example.invalid",
            now,
          ),
        ),
      ).rejects.toThrow(/source|account/);
    });
    it(
      kind +
        " completes once, counts overlapping records once and applies explicit deletion",
      async () => {
        clocks[kind] = "2026-10-20T11:00:00.000Z";
        await store().pauseHistoryBackfill(
          principal.owner_id,
          "gmail",
          state.account_id,
          "operator_resume",
        );
        await store().commitHistoryBackfill({
          ...page(),
          expected_cursor: "history-next",
          cursor: "terminal",
          operation_hash: "e".repeat(64),
        });
        expect(
          (await store().historyBackfills(principal.owner_id))[0],
        ).toMatchObject({ page_count: 2, record_count: 1 });
        const final = {
          ...page(),
          records: [],
          contacts: [],
          identities: [],
          expected_cursor: "terminal",
          cursor: null,
          complete: true,
          operation_hash: "f".repeat(64),
          removed_record_ids: ["older"],
        };
        expect(await store().commitHistoryBackfill(final)).toEqual([]);
        expect(await store().commitHistoryBackfill(final)).toEqual([]);
        expect(
          (await store().historyBackfills(principal.owner_id))[0],
        ).toMatchObject({
          page_count: 3,
          record_count: 0,
          status: "complete",
          oldest_at: null,
          newest_at: null,
        });
        expect((await store().counts()).interactions).toBe(0);
        clocks[kind] = now;
        expect(
          (await store().sourceStatus(principal.owner_id))[0]?.cursor,
        ).toBe("incremental-kept");
      },
    );
    it(
      kind + " includes past Calendar only in an explicit history range",
      async () => {
        const calendarState = {
          ...state,
          source: "calendar" as const,
          account_id: "primary",
        };
        await store().seed([], [], [calendarState]);
        await store().ingest({
          ...page().records[0]!,
          source: "calendar",
          account_id: "primary",
          source_record_id: "past-meeting",
          kind: "meeting",
          direction: "event",
          actor_identity: state.account_id,
          participant_identities: ["peer@example.invalid"],
          end_at: "2024-01-01T11:00:00.000Z",
        });
        const query = {
          contact_ids: ["peer"],
          accounts: [{ source: "calendar", account_id: "primary" }],
          now,
          message_start: "0001-01-01T00:00:00.000Z",
          calendar_end: "2026-10-27T10:00:00.000Z",
          limit: 50,
        };
        expect(
          (await store().privateHistory(principal.owner_id, query)).total,
        ).toBe(0);
        expect(
          (
            await store().privateHistory(principal.owner_id, {
              ...query,
              calendar_start: "0001-01-01T00:00:00.000Z",
            })
          ).total,
        ).toBe(1);
        expect(
          (await store().historyResourceUsage(principal.owner_id)).db_bytes,
        ).toBeGreaterThan(0);
      },
    );
    it(
      kind + " enforces daily uniqueness, CAS and no resend after uncertain",
      async () => {
        const row = daily();
        expect(await store().dailyBriefingInsert(row)).toBe(true);
        expect(await store().dailyBriefingInsert(row)).toBe(false);
        const sending: DailyBriefingRow = {
          ...row,
          revision: 1,
          state: "sending",
          attempts: 1,
        };
        expect(await store().dailyBriefingReplace(0, sending)).toBe(true);
        expect(await store().dailyBriefingReplace(0, sending)).toBe(false);
        const uncertain: DailyBriefingRow = {
          ...sending,
          revision: 2,
          state: "uncertain",
          failure: "delivery_uncertain",
        };
        expect(await store().dailyBriefingReplace(1, uncertain)).toBe(true);
        await expect(
          Promise.resolve().then(() =>
            store().dailyBriefingReplace(2, {
              ...uncertain,
              revision: 3,
              state: "sending",
            }),
          ),
        ).rejects.toThrow(/transition/);
        expect(
          await store().dailyBriefingReplace(2, {
            ...uncertain,
            revision: 3,
            state: "sent",
            telegram_message_id: 123,
            failure: null,
          }),
        ).toBe(true);
        expect(
          (await store().dailyBriefingGet(principal.owner_id, row.paris_date))
            ?.telegram_message_id,
        ).toBe(123);
        expect(
          (await store().dailyBriefingLatest(principal.owner_id, true))
            ?.telegram_message_id,
        ).toBe(123);
        await expect(
          Promise.resolve().then(() =>
            store().dailyBriefingGet("other", row.paris_date),
          ),
        ).rejects.toThrow(/owner/);
      },
    );
    it(
      kind +
        " rejects false daily acknowledgements and immutable identity changes",
      async () => {
        const row = {
          ...daily(),
          paris_date: "2026-10-21",
          scheduled_at: "2026-10-21T07:00:00.000Z",
        };
        expect(await store().dailyBriefingInsert(row)).toBe(true);
        await expect(
          Promise.resolve().then(() =>
            store().dailyBriefingReplace(0, {
              ...row,
              revision: 1,
              state: "sent",
            }),
          ),
        ).rejects.toThrow();
        await expect(
          Promise.resolve().then(() =>
            store().dailyBriefingReplace(0, {
              ...row,
              revision: 1,
              delivery_id: "00000000-0000-4000-8000-000000000002",
            }),
          ),
        ).rejects.toThrow(/identity/);
      },
    );
    it(
      kind +
        " never lets a frozen history page replace or delete a newer incremental version",
      async () => {
        const owner = "newer-" + kind;
        const principal2 = { ...principal, owner_id: owner };
        const clock = () => new Date("2026-10-20T10:10:00.000Z");
        const isolated =
          kind === "sqlite"
            ? new TendStore(":memory:", {
                mode: "live",
                principal: principal2,
                clock,
              })
            : await PostgresStore.open({
                connectionString: runtime.connectionString,
                principal: principal2,
                clock,
              });
        try {
          const raw = { ...page().records[0]!, owner_id: owner };
          await isolated.seed(
            [
              { owner_id: owner, contact_id: "OWNER", name: "Owner" },
              { owner_id: owner, contact_id: "peer", name: "Peer" },
            ],
            [
              {
                owner_id: owner,
                identity: state.account_id,
                contact_id: "OWNER",
              },
              {
                owner_id: owner,
                identity: "peer@example.invalid",
                contact_id: "peer",
              },
            ],
            [{ ...state, owner_id: owner }],
          );
          await isolated.ingest({
            ...raw,
            body_text: "Fresh incremental evidence",
            authored_text: "Fresh incremental evidence",
            observed_at: "2026-10-20T10:05:00.000Z",
          });
          await isolated.beginHistoryBackfill(
            owner,
            "gmail",
            state.account_id,
            now,
          );
          const input = {
            ...page(),
            owner_id: owner,
            records: [raw],
            contacts: [],
            identities: [],
          };
          await isolated.commitHistoryBackfill(input);
          expect((await isolated.interactions(owner))[0]?.body_text).toBe(
            "Fresh incremental evidence",
          );
          await isolated.commitHistoryBackfill({
            ...input,
            records: [],
            expected_cursor: "history-next",
            cursor: "fresh-delete",
            complete: false,
            operation_hash: "b".repeat(64),
            removed_record_ids: [raw.source_record_id],
          });
          expect((await isolated.interactions(owner))[0]?.body_text).toBe(
            "Fresh incremental evidence",
          );
          const fresh = {
            ...input,
            records: [],
            expected_cursor: "fresh-delete",
            cursor: null,
            complete: true,
            operation_hash: "c".repeat(64),
            removed_record_ids: [raw.source_record_id],
            withdrawals_observed_at: clock().toISOString(),
          };
          for (const invalid of [
            "2026-10-20T09:59:00.000Z",
            "2026-10-20T10:11:00.000Z",
            "invalid",
          ])
            await expect(
              Promise.resolve().then(() =>
                isolated.commitHistoryBackfill({
                  ...fresh,
                  withdrawals_observed_at: invalid,
                }),
              ),
            ).rejects.toThrow(/history/);
          expect((await isolated.interactions(owner))[0]?.body_text).toBe(
            "Fresh incremental evidence",
          );
          await isolated.commitHistoryBackfill(fresh);
          expect(await isolated.interactions(owner)).toHaveLength(0);
        } finally {
          await isolated.close();
        }
      },
    );
    it.each(["gmail", "whatsapp_personal", "calendar"] as const)(
      kind + " reconciles only the incremental coverage window for %s",
      async (source) => {
        const owner = "reconcile-" + kind + "-" + source;
        const account =
          source === "gmail"
            ? state.account_id
            : source === "calendar"
              ? "primary"
              : "personal-account";
        const principal2 = { ...principal, owner_id: owner };
        const isolated =
          kind === "sqlite"
            ? new TendStore(":memory:", {
                mode: "live",
                principal: principal2,
                clock: () => new Date(now),
              })
            : await PostgresStore.open({
                connectionString: runtime.connectionString,
                principal: principal2,
                clock: () => new Date(now),
              });
        try {
          const coverage_start =
            source === "calendar" ? now : state.coverage_start;
          const coverage_end =
            source === "calendar" ? "2026-10-27T10:00:00.000Z" : now;
          await isolated.seed(
            [
              { owner_id: owner, contact_id: "OWNER", name: "Owner" },
              { owner_id: owner, contact_id: "peer", name: "Peer" },
            ],
            [
              {
                owner_id: owner,
                identity: state.account_id,
                contact_id: "OWNER",
              },
              {
                owner_id: owner,
                identity: "peer@example.invalid",
                contact_id: "peer",
              },
            ],
            [
              {
                ...state,
                owner_id: owner,
                source,
                account_id: account,
                coverage_start,
                coverage_end,
              },
            ],
          );
          const old = {
            ...page().records[0]!,
            owner_id: owner,
            source,
            account_id: account,
            ...(source === "calendar"
              ? {
                  kind: "meeting",
                  direction: "event" as const,
                  actor_identity: state.account_id,
                  participant_identities: ["peer@example.invalid"],
                  end_at: "2024-01-01T11:00:00.000Z",
                }
              : {}),
          };
          const recent = {
            ...old,
            source_record_id: "missing-in-window",
            occurred_at:
              source === "calendar"
                ? "2026-10-19T23:00:00.000Z"
                : "2026-10-19T10:00:00.000Z",
            body_text: "Missing source inside coverage",
            authored_text: "Missing source inside coverage",
            ...(source === "calendar"
              ? { end_at: "2026-10-20T11:00:00.000Z" }
              : {}),
          };
          await isolated.beginHistoryBackfill(owner, source, account, now);
          await isolated.commitHistoryBackfill({
            ...page(),
            owner_id: owner,
            source,
            account_id: account,
            records: [old],
            contacts: [],
            identities: [],
          });
          await isolated.ingest(recent);
          const before = await isolated.interactions(owner);
          const prepared = (id: string) => {
            const record = before.find((r) => r.source_record_id === id)!;
            return {
              reply: {
                outbound_sent: false as const,
                normal_message: record.body_text,
              },
              record_guards: [
                {
                  record_key: record.record_key,
                  content_hash: record.content_hash,
                },
              ],
            };
          };
          const oldView = prepared(old.source_record_id),
            recentView = prepared(recent.source_record_id);
          const policy: LivePolicy = {
            ...exampleLivePolicy,
            principal_id: owner,
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
          const auth = {
            ...principal2,
            chat_type: "private",
            text: "Retained evidence test",
          };
          expect(
            await isolated.validatePreparedRead(auth, oldView, policy),
          ).toEqual(oldView.reply);
          expect(
            await isolated.validatePreparedRead(auth, recentView, policy),
          ).toEqual(recentView.reply);
          await isolated.commitLiveBatch({
            owner_id: owner,
            source,
            account_id: account,
            records: [],
            cursor: null,
            expected_cursor: "incremental-kept",
            complete: true,
            reconcile: true,
            coverage_start,
            coverage_end,
            seen_record_ids: [],
          });
          expect(
            (await isolated.interactions(owner)).map((r) => r.source_record_id),
          ).toEqual([old.source_record_id]);
          expect(
            await isolated.validatePreparedRead(auth, oldView, policy),
          ).toEqual(oldView.reply);
          expect(
            await isolated.validatePreparedRead(auth, recentView, policy),
          ).not.toEqual(recentView.reply);
        } finally {
          await isolated.close();
        }
      },
    );
    it(
      kind +
        " alternates durable per-account polling lanes without changing history progress",
      async () => {
        const owner = "poll-lane-" + kind,
          principal2 = { ...principal, owner_id: owner };
        const dir = mkdtempSync(join(tmpdir(), "tend-lanes-")),
          path = join(dir, "test.sqlite");
        const open = () =>
          kind === "sqlite"
            ? new TendStore(path, {
                mode: "live",
                principal: principal2,
                clock: () => new Date(now),
              })
            : PostgresStore.open({
                connectionString: runtime.connectionString,
                principal: principal2,
                clock: () => new Date(now),
              });
        let isolated = await open();
        try {
          const accounts = [state.account_id, "second@example.invalid"];
          await isolated.seed(
            [],
            [],
            accounts.map((account_id) => ({
              ...state,
              owner_id: owner,
              account_id,
            })),
          );
          for (const account of accounts)
            await isolated.beginHistoryBackfill(owner, "gmail", account, now);
          const baseline = (await isolated.historyBackfills(owner)).find(
            (c) => c.account_id === state.account_id,
          )!;
          expect(
            await isolated.claimHistoryPoll(owner, "gmail", state.account_id),
          ).toBe("incremental");
          const after = (await isolated.historyBackfills(owner)).find(
            (c) => c.account_id === state.account_id,
          )!;
          const { next_poll_lane: _oldLane, ...oldProgress } = baseline;
          const { next_poll_lane: _newLane, ...newProgress } = after;
          void _oldLane;
          void _newLane;
          expect(newProgress).toEqual(oldProgress);
          expect(after.next_poll_lane).toBe("history");
          expect(
            await isolated.claimHistoryPoll(owner, "gmail", accounts[1]!),
          ).toBe("incremental");
          await isolated.close();
          isolated = await open();
          expect(
            await isolated.claimHistoryPoll(owner, "gmail", state.account_id),
          ).toBe("history");
          const racing = await Promise.all([
            Promise.resolve().then(() =>
              isolated.claimHistoryPoll(owner, "gmail", state.account_id),
            ),
            Promise.resolve().then(() =>
              isolated.claimHistoryPoll(owner, "gmail", state.account_id),
            ),
          ]);
          expect(racing.sort()).toEqual(["history", "incremental"]);
          await isolated.close();
          if (kind === "sqlite") {
            const db = new DatabaseSync(path);
            try {
              db.prepare(
                "UPDATE live_history_backfills SET data=json_remove(data,'$.next_poll_lane') WHERE owner_id=? AND account_id=?",
              ).run(owner, state.account_id);
            } finally {
              db.close();
            }
          } else {
            const pool = new Pool({
              connectionString: runtime.connectionString,
            });
            try {
              await pool.query(
                "UPDATE live_history_backfills SET data=data-'next_poll_lane' WHERE owner_id=$1 AND account_id=$2",
                [owner, state.account_id],
              );
            } finally {
              await pool.end();
            }
          }
          isolated = await open();
          expect(
            await isolated.claimHistoryPoll(owner, "gmail", state.account_id),
          ).toBe("incremental");
          await expect(
            Promise.resolve().then(() =>
              isolated.claimHistoryPoll("foreign", "gmail", state.account_id),
            ),
          ).rejects.toThrow(/owner/);
          await expect(
            Promise.resolve().then(() =>
              isolated.claimHistoryPoll(owner, "gmail", "foreign-account"),
            ),
          ).rejects.toThrow(/source|account|checkpoint/);
          await isolated.revokeSource(owner, "gmail");
          await expect(
            Promise.resolve().then(() =>
              isolated.claimHistoryPoll(owner, "gmail", state.account_id),
            ),
          ).rejects.toThrow(/source|revoked/);
        } finally {
          await isolated.close();
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
    it(
      kind + " keeps social history bounded when only Google history expands",
      async () => {
        await store().seed(
          [],
          [],
          [
            {
              ...state,
              source: "whatsapp_personal",
              account_id: "personal-account",
            },
          ],
        );
        await store().ingest({
          ...page().records[0]!,
          source: "whatsapp_personal",
          account_id: "personal-account",
          source_record_id: "old-wa",
        });
        const query = {
          contact_ids: ["peer"],
          accounts: [
            { source: "gmail", account_id: state.account_id },
            { source: "whatsapp_personal", account_id: "personal-account" },
          ],
          now,
          message_start: "0001-01-01T00:00:00.000Z",
          calendar_end: "2026-10-27T10:00:00.000Z",
          limit: 50,
        };
        expect(
          (await store().privateHistory(principal.owner_id, query)).total,
        ).toBe(1);
        expect(
          (
            await store().privateHistory(principal.owner_id, {
              ...query,
              social_start: "2026-09-20T10:00:00.000Z",
            })
          ).total,
        ).toBe(0);
      },
    );
    it(
      kind +
        " expires legacy social evidence independently of all-history mail",
      async () => {
        await store().expireLiveEvidence(
          principal.owner_id,
          "0001-01-01T00:00:00.000Z",
          "0001-01-01T00:00:00.000Z",
          "2026-10-27T10:00:00.000Z",
          "2026-09-20T10:00:00.000Z",
        );
        expect(
          (await store().interactions(principal.owner_id)).filter(
            (r) => r.source === "whatsapp_personal",
          ),
        ).toHaveLength(0);
        expect(
          (await store().interactions(principal.owner_id)).filter(
            (r) => r.source === "calendar",
          ),
        ).toHaveLength(1);
      },
    );
    it(
      kind +
        " resumes bounded chunks without advancing an incomplete provider page",
      async () => {
        const owner = "chunks-" + kind;
        const principal2 = { ...principal, owner_id: owner };
        const isolated =
          kind === "sqlite"
            ? new TendStore(":memory:", {
                mode: "live",
                principal: principal2,
                clock: () => new Date(now),
              })
            : await PostgresStore.open({
                connectionString: runtime.connectionString,
                principal: principal2,
                clock: () => new Date(now),
              });
        try {
          await isolated.seed(
            [
              { owner_id: owner, contact_id: "OWNER", name: "Owner" },
              { owner_id: owner, contact_id: "peer", name: "Peer" },
            ],
            [
              {
                owner_id: owner,
                identity: state.account_id,
                contact_id: "OWNER",
              },
              {
                owner_id: owner,
                identity: "peer@example.invalid",
                contact_id: "peer",
              },
            ],
            [{ ...state, owner_id: owner }],
          );
          await isolated.beginHistoryBackfill(
            owner,
            "gmail",
            state.account_id,
            now,
          );
          const first = {
            ...page(),
            owner_id: owner,
            advance: false,
            expected_cursor: null,
            cursor: null,
            records: [{ ...page().records[0]!, owner_id: owner }],
            contacts: [],
            identities: [],
          };
          expect(await isolated.commitHistoryBackfill(first)).toHaveLength(1);
          expect((await isolated.historyBackfills(owner))[0]).toMatchObject({
            page_count: 0,
            record_count: 1,
            cursor: null,
            status: "running",
          });
          await expect(
            Promise.resolve().then(() =>
              isolated.commitHistoryBackfill({
                ...first,
                records: [
                  {
                    ...first.records[0]!,
                    source_record_id: "bad",
                    actor_identity: "unknown@example.invalid",
                  },
                ],
                operation_hash: "c".repeat(64),
              }),
            ),
          ).rejects.toThrow(/identity/);
          expect((await isolated.historyBackfills(owner))[0]).toMatchObject({
            page_count: 0,
            record_count: 1,
            cursor: null,
          });
          expect(await isolated.commitHistoryBackfill(first)).toEqual([]);
          await isolated.commitHistoryBackfill({
            ...first,
            records: [{ ...first.records[0]!, source_record_id: "second" }],
            operation_hash: "d".repeat(64),
          });
          await isolated.commitHistoryBackfill({
            ...first,
            advance: true,
            records: [],
            cursor: null,
            complete: true,
            operation_hash: "e".repeat(64),
          });
          expect((await isolated.historyBackfills(owner))[0]).toMatchObject({
            page_count: 1,
            record_count: 2,
            cursor: null,
            status: "complete",
          });
          expect((await isolated.sourceStatus(owner))[0]?.cursor).toBe(
            "incremental-kept",
          );
        } finally {
          await isolated.close();
        }
      },
    );
    it(
      kind +
        " backs the real daily service with one durable claim and late acknowledgement",
      async () => {
        const service = new DailyBriefingService({
          owner: principal,
          clock: () => new Date("2026-10-22T07:00:00.000Z"),
          ledger: {
            get: async (owner, day) => store().dailyBriefingGet(owner, day),
            latest: async (owner, sentOnly) =>
              store().dailyBriefingLatest(owner, sentOnly),
            insert: async (row) => store().dailyBriefingInsert(row),
            replace: async (revision, row) =>
              store().dailyBriefingReplace(revision, row),
          },
          prepare: async () => ({
            reply: {
              outbound_sent: false,
              normal_message: "Current priorities",
            },
            record_guards: [],
          }),
          validateAndFormat: async () => "Current priorities with coverage",
        });
        const selection = await service.prepare();
        expect(selection.state).toBe("pending");
        const claims = await Promise.all([
          service.claim(selection.paris_date, selection.delivery_id!),
          service.claim(selection.paris_date, selection.delivery_id!),
        ]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        expect((await service.prepare()).state).toBe("uncertain");
        expect(
          await service.claim(selection.paris_date, selection.delivery_id!),
        ).toBeNull();
        expect(
          await service.acknowledge(
            selection.paris_date,
            selection.delivery_id!,
            {
              ok: true,
              result: {
                message_id: 321,
                chat: { type: "private", id: Number(principal.chat_id) },
              },
            },
          ),
        ).toBe(true);
        expect(
          (await store().dailyBriefingLatest(principal.owner_id, true))
            ?.telegram_message_id,
        ).toBe(321);
      },
    );
  }
  it("reopening the additive PostgreSQL schema preserves all ledger state", async () => {
    const reopened = await PostgresStore.open({
      connectionString: runtime.connectionString,
      principal,
      clock: () => new Date(now),
    });
    try {
      expect(
        (await reopened.historyBackfills(principal.owner_id)).find(
          (r) => r.source === "gmail",
        )?.page_count,
      ).toBe(3);
      expect(
        (await reopened.sourceStatus(principal.owner_id)).find(
          (s) => s.source === "gmail",
        )?.cursor,
      ).toBe("incremental-kept");
      expect(
        (await reopened.dailyBriefingLatest(principal.owner_id, true))
          ?.telegram_message_id,
      ).toBe(321);
    } finally {
      await reopened.close();
    }
  });
});
