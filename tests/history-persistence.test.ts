import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  beforeAll(async () => {
    runtime = await postgresTestRuntime();
    pg = await PostgresStore.open({
      connectionString: runtime.connectionString,
      principal,
      clock: () => new Date(now),
    });
    sqlite = new TendStore(":memory:", {
      mode: "live",
      principal,
      clock: () => new Date(now),
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
            cursor: null,
            complete: true,
            operation_hash: "b".repeat(64),
            removed_record_ids: [raw.source_record_id],
          });
          expect((await isolated.interactions(owner))[0]?.body_text).toBe(
            "Fresh incremental evidence",
          );
        } finally {
          await isolated.close();
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
