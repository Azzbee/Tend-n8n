import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { exampleLivePolicy } from "../src/live-policy.ts";
import { randomUUID } from "node:crypto";
import { TendStore } from "../src/engine.ts";
import { PostgresStore } from "../src/postgres-store.ts";
import { postgresTestRuntime } from "./postgres-test-runtime.ts";
import type { HistoryPageCommit } from "../src/live-store.ts";
import type { LiveRecord } from "../src/google-records.ts";
const now = "2026-10-20T18:00:00.000Z",
  watermark = "2026-10-20T17:00:00.000Z";
describe.each(["sqlite", "postgres"] as const)(
  "historical record review %s",
  (kind) => {
    let runtime: Awaited<ReturnType<typeof postgresTestRuntime>>;
    beforeAll(async () => {
      if (kind === "postgres") runtime = await postgresTestRuntime();
    }, 90000);
    afterAll(() => {
      if (kind === "postgres") runtime?.close();
    });
    async function fixture(path = ":memory:") {
      const owner = "quarantine-" + randomUUID(),
        account = "owner@example.invalid";
      const principal = { owner_id: owner, user_id: "u", chat_id: "c" };
      const store =
        kind === "sqlite"
          ? new TendStore(path, {
              mode: "live",
              principal,
              clock: () => new Date(now),
            })
          : await PostgresStore.open({
              connectionString: runtime.connectionString,
              principal,
              clock: () => new Date(now),
            });
      await store.seed(
        [
          { owner_id: owner, contact_id: "OWNER", name: "Owner" },
          { owner_id: owner, contact_id: "peer", name: "Peer" },
        ],
        [
          { owner_id: owner, contact_id: "OWNER", identity: account },
          {
            owner_id: owner,
            contact_id: "peer",
            identity: "peer@example.invalid",
          },
        ],
        [
          {
            owner_id: owner,
            source: "gmail",
            account_id: account,
            mode: "live",
            status: "partial",
            cursor: null,
            coverage_start: "2026-09-20T17:00:00.000Z",
            coverage_end: watermark,
            last_success: null,
          },
        ],
      );
      await store.beginHistoryBackfill(owner, "gmail", account, watermark);
      const record = (id = "readable", observed_at = now): LiveRecord => ({
        owner_id: owner,
        source: "gmail",
        account_id: account,
        source_record_id: id,
        source_thread_id: "thread",
        kind: "message",
        direction: "received",
        actor_identity: "peer@example.invalid",
        participant_identities: [account],
        occurred_at: "2024-01-01T00:00:00.000Z",
        observed_at,
        body_text: "Readable fictional evidence",
        evidence_reference: "tend-source:fixture/record",
        ingestion_mode: "live",
        coverage_start: "0001-01-01T00:00:00.000Z",
        coverage_end: watermark,
        cancelled: false,
        contact_ids: ["peer"],
        authored_text: "Readable fictional evidence",
        authored_spans: [],
        attribution: "direct",
        eligible_for_extraction: false,
      });
      const quarantine = (id = "unreadable", observed_at = now) => ({
        source_record_id: id,
        reason: "provider_text_unavailable",
        original_reference: `tend-source:gmail/${encodeURIComponent(account)}/${encodeURIComponent(id)}`,
        observed_at,
      });
      const page = (): HistoryPageCommit => ({
        owner_id: owner,
        source: "gmail",
        account_id: account,
        version: 1,
        watermark,
        expected_cursor: null,
        cursor: "next",
        operation_hash: "a".repeat(64),
        complete: false,
        records: [record()],
        quarantines: [quarantine()],
      });
      const reopen = () =>
        kind === "sqlite"
          ? new TendStore(path, {
              mode: "live",
              principal,
              clock: () => new Date(now),
            })
          : PostgresStore.open({
              connectionString: runtime.connectionString,
              principal,
              clock: () => new Date(now),
            });
      return {
        store,
        owner,
        account,
        principal,
        record,
        quarantine,
        page,
        reopen,
      };
    }
    it("commits readable records and unavailable metadata atomically and replays once", async () => {
      const f = await fixture();
      try {
        const page = f.page();
        await f.store.commitHistoryBackfill(page);
        expect((await f.store.historyBackfills(f.owner))[0]).toMatchObject({
          page_count: 1,
          record_count: 1,
          quarantined_count: 1,
          cursor: "next",
        });
        expect(
          await f.store.historyQuarantines(f.owner, "gmail", f.account),
        ).toMatchObject({
          total: 1,
          reason_counts: [{ reason: "provider_text_unavailable", count: 1 }],
          items: [f.quarantine()],
        });
        expect(await f.store.commitHistoryBackfill(page)).toEqual([]);
        expect(await f.store.quarantineCount(f.owner)).toBe(1);
        await f.store.commitHistoryBackfill({
          ...page,
          operation_hash: "b".repeat(64),
          expected_cursor: "next",
          cursor: null,
          complete: true,
        });
        expect((await f.store.historyBackfills(f.owner))[0]).toMatchObject({
          status: "complete",
          page_count: 2,
          record_count: 1,
          quarantined_count: 1,
        });
        await expect(
          Promise.resolve().then(() =>
            f.store.historyQuarantines("other", "gmail", f.account),
          ),
        ).rejects.toThrow();
        await expect(
          Promise.resolve().then(() =>
            f.store.historyQuarantines(f.owner, "gmail", f.account, 101),
          ),
        ).rejects.toThrow();
      } finally {
        await f.store.close();
      }
    });
    it.each([
      "unknown_id",
      "wrong_account_reference",
      "future_observation",
      "overlap",
      "invalid_record",
      "synthetic_id",
      "duplicate_id",
      "foreign_batch_account",
    ])("rolls back the complete page for %s", async (problem) => {
      const f = await fixture();
      try {
        const page = f.page();
        if (problem === "unknown_id")
          page.quarantines![0]!.source_record_id = "";
        if (problem === "wrong_account_reference")
          page.quarantines![0]!.original_reference =
            "tend-source:gmail/other/unreadable";
        if (problem === "future_observation")
          page.quarantines![0]!.observed_at = "2026-10-21T18:00:00.000Z";
        if (problem === "overlap")
          page.quarantines = [f.quarantine("readable")];
        if (problem === "invalid_record") page.records[0]!.actor_identity = "";
        if (problem === "synthetic_id")
          page.quarantines = [f.quarantine("invalid-record:0")];
        if (problem === "duplicate_id") page.quarantines!.push(f.quarantine());
        if (problem === "foreign_batch_account")
          page.account_id = "other@example.invalid";
        const before = await f.store.historyBackfills(f.owner);
        await expect(
          Promise.resolve().then(() => f.store.commitHistoryBackfill(page)),
        ).rejects.toThrow();
        expect(await f.store.historyBackfills(f.owner)).toEqual(before);
        expect(await f.store.interactions(f.owner)).toHaveLength(0);
        expect(await f.store.quarantineCount(f.owner)).toBe(0);
      } finally {
        await f.store.close();
      }
    });
    it("withdraws newly unreadable canonical evidence, preserves newer observations and recovers explicitly", async () => {
      const f = await fixture();
      try {
        await f.store.ingest(f.record("unreadable", watermark));
        const old = (await f.store.interactions(f.owner))[0]!;
        const prepared = {
          reply: {
            outbound_sent: false as const,
            warning: "Retained fictional output",
          },
          record_guards: [
            { record_key: old.record_key, content_hash: old.content_hash },
          ],
        };
        const livePolicy = {
          ...exampleLivePolicy,
          principal_id: f.owner,
          account_email: f.account,
          verified_owner_emails: [f.account],
          history: { version: 1 as const, mode: "all_available" as const },
        };
        const auth = { ...f.principal, chat_type: "private", text: "history" };
        expect(
          await f.store.validatePreparedRead(auth, prepared, livePolicy),
        ).toEqual(prepared.reply);
        await f.store.commitHistoryBackfill({ ...f.page(), records: [] });
        expect(await f.store.interactions(f.owner)).toHaveLength(0);
        expect(
          await f.store.validatePreparedRead(
            { ...f.principal, chat_type: "private", text: "history" },
            prepared,
            livePolicy,
          ),
        ).not.toEqual(prepared.reply);
        await f.store.commitHistoryBackfill({
          ...f.page(),
          expected_cursor: "next",
          cursor: "next2",
          operation_hash: "b".repeat(64),
          records: [f.record("unreadable", watermark)],
          quarantines: [],
        });
        expect(await f.store.interactions(f.owner)).toHaveLength(0);
        expect(
          (await f.store.historyBackfills(f.owner))[0]?.quarantined_count,
        ).toBe(1);
        await f.store.commitHistoryBackfill({
          ...f.page(),
          expected_cursor: "next2",
          cursor: "next3",
          operation_hash: "c".repeat(64),
          records: [f.record("unreadable")],
          quarantines: [],
        });
        expect(await f.store.interactions(f.owner)).toHaveLength(1);
        expect(
          (await f.store.historyBackfills(f.owner))[0]?.quarantined_count,
        ).toBe(0);
        await f.store.commitHistoryBackfill({
          ...f.page(),
          expected_cursor: "next3",
          cursor: null,
          complete: true,
          operation_hash: "d".repeat(64),
          records: [],
          quarantines: [f.quarantine("unreadable", watermark)],
        });
        expect(await f.store.interactions(f.owner)).toHaveLength(1);
        expect(await f.store.quarantineCount(f.owner)).toBe(0);
      } finally {
        await f.store.close();
      }
    });
    it("keeps review and quota protections for pages carrying unavailable entries", async () => {
      const f = await fixture();
      try {
        await f.store.pauseHistoryBackfill(
          f.owner,
          "gmail",
          f.account,
          "history_page_requires_review",
          null,
        );
        const held = await f.store.historyBackfills(f.owner);
        await expect(
          Promise.resolve().then(() => f.store.commitHistoryBackfill(f.page())),
        ).rejects.toThrow(/requires.review/);
        expect(await f.store.historyBackfills(f.owner)).toEqual(held);
        expect(await f.store.quarantineCount(f.owner)).toBe(0);
        await f.store.retryHistoryBackfill(
          f.owner,
          "gmail",
          f.account,
          "history_page_requires_review",
        );
        await f.store.pauseHistoryBackfill(
          f.owner,
          "gmail",
          f.account,
          "provider_429",
          "2026-10-21T18:00:00.000Z",
        );
        const waiting = await f.store.historyBackfills(f.owner);
        await expect(
          Promise.resolve().then(() =>
            f.store.commitHistoryBackfill({
              ...f.page(),
              advance: false,
              cursor: null,
              records: [],
              removed_record_ids: ["known-invalid"],
              withdrawals_observed_at: now,
            }),
          ),
        ).rejects.toThrow(/wait/);
        expect(await f.store.historyBackfills(f.owner)).toEqual(waiting);
        expect(await f.store.quarantineCount(f.owner)).toBe(0);
        await f.store.commitHistoryBackfill({
          ...f.page(),
          advance: false,
          cursor: null,
          records: [],
          quarantines: [],
          removed_record_ids: ["known-invalid"],
          withdrawals_observed_at: now,
        });
        expect((await f.store.historyBackfills(f.owner))[0]).toMatchObject({
          status: "paused",
          last_error: "provider_429",
          retry_after_until: "2026-10-21T18:00:00.000Z",
          page_count: 0,
        });
      } finally {
        await f.store.close();
      }
    });
    it("keeps bounded review samples and distinct reason totals across reopen", async () => {
      const dir = mkdtempSync(join(tmpdir(), "history-review-"));
      const f = await fixture(join(dir, "store.sqlite"));
      try {
        const page = {
          ...f.page(),
          records: [],
          quarantines: Array.from({ length: 60 }, (_, i) => ({
            ...f.quarantine(`unavailable-${i}`),
            reason: `reason_${i}`,
          })),
        };
        await f.store.commitHistoryBackfill(page);
        await f.store.close();
        f.store = await f.reopen();
        const report = await f.store.historyQuarantines(
          f.owner,
          "gmail",
          f.account,
          3,
        );
        expect(report.total).toBe(60);
        expect(report.items).toHaveLength(3);
        expect(report.reason_counts).toHaveLength(50);
        expect(report.reason_counts_truncated).toBe(true);
        expect(
          report.items.every((q) =>
            q.original_reference?.startsWith("tend-source:gmail/"),
          ),
        ).toBe(true);
        expect(
          (await f.store.historyBackfills(f.owner))[0]?.quarantined_count,
        ).toBe(60);
      } finally {
        await f.store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
    it("rolls back canonical withdrawal and quarantine writes when the final checkpoint update fails", async () => {
      const dir = mkdtempSync(join(tmpdir(), "history-rollback-"));
      const path = join(dir, "store.sqlite"),
        f = await fixture(path);
      try {
        await f.store.ingest(f.record("unreadable", watermark));
        const before = await f.store.historyBackfills(f.owner);
        if (kind === "sqlite") {
          const db = new DatabaseSync(path);
          try {
            db.exec(
              "CREATE TRIGGER fail_history_checkpoint BEFORE UPDATE ON live_history_backfills BEGIN SELECT RAISE(ABORT,'fixture checkpoint failure'); END",
            );
          } finally {
            db.close();
          }
        } else {
          const pool = new Pool({ connectionString: runtime.connectionString });
          try {
            await pool.query(
              "CREATE OR REPLACE FUNCTION fixture_checkpoint_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture checkpoint failure'; END $$",
            );
            await pool.query(
              "CREATE TRIGGER fail_history_checkpoint BEFORE UPDATE ON live_history_backfills FOR EACH ROW EXECUTE FUNCTION fixture_checkpoint_failure()",
            );
          } finally {
            await pool.end();
          }
        }
        await expect(
          Promise.resolve().then(() => f.store.commitHistoryBackfill(f.page())),
        ).rejects.toThrow(/fixture checkpoint failure/);
        expect(await f.store.historyBackfills(f.owner)).toEqual(before);
        expect(
          (await f.store.interactions(f.owner)).map((r) => r.source_record_id),
        ).toEqual(["unreadable"]);
        expect(await f.store.quarantineCount(f.owner)).toBe(0);
      } finally {
        if (kind === "postgres") {
          const pool = new Pool({ connectionString: runtime.connectionString });
          try {
            await pool.query(
              "DROP TRIGGER IF EXISTS fail_history_checkpoint ON live_history_backfills",
            );
          } finally {
            await pool.end();
          }
        }
        await f.store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
