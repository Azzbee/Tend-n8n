import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TendStore, type SourceState } from "../src/engine.ts";
import { PostgresStore } from "../src/postgres-store.ts";
import { postgresTestRuntime } from "./postgres-test-runtime.ts";

const now = "2026-10-20T10:00:00.000Z";
describe.each(["sqlite", "postgres"] as const)(
  "atomic history retry %s",
  (kind) => {
    let runtime: Awaited<ReturnType<typeof postgresTestRuntime>>;
    beforeAll(async () => {
      if (kind === "postgres") runtime = await postgresTestRuntime();
    }, 90000);
    afterAll(() => {
      if (kind === "postgres") runtime?.close();
    });
    it("preserves a concurrently updated quota and changes only the matching review reason", async () => {
      const owner = "retry-owner",
        account = "owner@example.invalid";
      const principal = { owner_id: owner, user_id: "u", chat_id: "c" };
      const store =
        kind === "sqlite"
          ? new TendStore(":memory:", {
              mode: "live",
              principal,
              clock: () => new Date(now),
            })
          : await PostgresStore.open({
              connectionString: runtime.connectionString,
              principal,
              clock: () => new Date(now),
            });
      const state: SourceState = {
        owner_id: owner,
        source: "gmail",
        account_id: account,
        mode: "live",
        status: "partial",
        cursor: null,
        coverage_start: "2026-09-20T10:00:00.000Z",
        coverage_end: now,
        last_success: null,
      };
      try {
        await store.seed([], [], [state]);
        await store.beginHistoryBackfill(owner, "gmail", account, now);
        await store.claimHistoryPoll(owner, "gmail", account);
        await store.pauseHistoryBackfill(
          owner,
          "gmail",
          account,
          "oversized_requires_review",
          null,
        );
        const staleError = "oversized_requires_review";
        await store.pauseHistoryBackfill(
          owner,
          "gmail",
          account,
          "history_page_requires_review",
          null,
        );
        const quota = await store.pauseHistoryBackfill(
          owner,
          "gmail",
          account,
          "provider_429",
          "2026-10-21T10:00:00.000Z",
        );
        expect(
          await store.retryHistoryBackfill(owner, "gmail", account, staleError),
        ).toBe(false);
        expect((await store.historyBackfills(owner))[0]).toEqual(quota);
        const reviewed = await store.pauseHistoryBackfill(
          owner,
          "gmail",
          account,
          staleError,
          quota.retry_after_until,
        );
        expect(
          await store.retryHistoryBackfill(owner, "gmail", account, staleError),
        ).toBe(true);
        expect((await store.historyBackfills(owner))[0]).toEqual({
          ...reviewed,
          last_error: "owner_retry_requested",
        });
        expect(
          await store.retryHistoryBackfill(owner, "gmail", account, staleError),
        ).toBe(false);
        await store.pauseHistoryBackfill(
          owner,
          "gmail",
          account,
          "provider_429",
          quota.retry_after_until,
        );
        expect(
          await store.retryHistoryBackfill(
            owner,
            "gmail",
            account,
            "provider_429",
          ),
        ).toBe(false);
        await store.pauseHistoryBackfill(
          owner,
          "gmail",
          account,
          staleError,
          quota.retry_after_until,
        );
        for (const hold of [staleError, "provider_429"]) {
          const previous = (await store.historyBackfills(owner))[0]!;
          if (previous.last_error?.endsWith("requires_review"))
            await store.retryHistoryBackfill(
              owner,
              "gmail",
              account,
              previous.last_error,
            );
          const protectedPause = await store.pauseHistoryBackfill(
            owner,
            "gmail",
            account,
            hold,
            quota.retry_after_until,
          );
          expect(
            await store.pauseHistoryBackfill(
              owner,
              "gmail",
              account,
              "disk_floor",
              null,
              true,
            ),
          ).toEqual(protectedPause);
          expect((await store.historyBackfills(owner))[0]).toEqual(
            protectedPause,
          );
          await store.commitHistoryBackfill({
            owner_id: owner,
            source: "gmail",
            account_id: account,
            version: 1,
            watermark: now,
            expected_cursor: null,
            cursor: null,
            advance: false,
            complete: false,
            operation_hash: (hold === staleError ? "a" : "b").repeat(64),
            records: [],
            removed_record_ids: ["known-deleted"],
            withdrawals_observed_at: now,
          });
          expect((await store.historyBackfills(owner))[0]).toMatchObject({
            status: "paused",
            last_error: hold,
            retry_after_until: protectedPause.retry_after_until,
            cursor: null,
            page_count: 0,
            next_poll_lane: protectedPause.next_poll_lane,
          });
        }
        await store.revokeSource(owner, "gmail");
        expect(
          await store.retryHistoryBackfill(owner, "gmail", account, staleError),
        ).toBe(false);
        await expect(
          Promise.resolve().then(() =>
            store.retryHistoryBackfill(
              "other-owner",
              "gmail",
              account,
              staleError,
            ),
          ),
        ).rejects.toThrow();
      } finally {
        await store.close();
      }
    });
    it("blocks stale held pages and retains the later provider deadline across strong pauses", async () => {
      const owner = "combined-hold-owner",
        account = "owner@example.invalid";
      const principal = { owner_id: owner, user_id: "u", chat_id: "c" };
      const store =
        kind === "sqlite"
          ? new TendStore(":memory:", {
              mode: "live",
              principal,
              clock: () => new Date(now),
            })
          : await PostgresStore.open({
              connectionString: runtime.connectionString,
              principal,
              clock: () => new Date(now),
            });
      try {
        await store.seed(
          [],
          [],
          [
            {
              owner_id: owner,
              source: "gmail",
              account_id: account,
              mode: "live",
              status: "partial",
              cursor: null,
              coverage_start: "2026-09-20T10:00:00.000Z",
              coverage_end: now,
              last_success: null,
            },
          ],
        );
        await store.beginHistoryBackfill(owner, "gmail", account, now);
        const held = await store.pauseHistoryBackfill(
          owner,
          "gmail",
          account,
          "history_page_requires_review",
          null,
        );
        const page = {
          owner_id: owner,
          source: "gmail" as const,
          account_id: account,
          version: 1 as const,
          watermark: now,
          expected_cursor: null,
          cursor: "page2",
          complete: false,
          operation_hash: "c".repeat(64),
          records: [],
        };
        await expect(
          Promise.resolve().then(() => store.commitHistoryBackfill(page)),
        ).rejects.toThrow(/requires.review/);
        expect((await store.historyBackfills(owner))[0]).toEqual(held);
        expect(
          await store.retryHistoryBackfill(
            owner,
            "gmail",
            account,
            "history_page_requires_review",
          ),
        ).toBe(true);
        await store.commitHistoryBackfill(page);
        expect((await store.historyBackfills(owner))[0]).toMatchObject({
          cursor: "page2",
          page_count: 1,
        });
        const later = "2026-10-22T10:00:00.000Z";
        await store.pauseHistoryBackfill(
          owner,
          "gmail",
          account,
          "provider_429",
          later,
        );
        expect(
          await store.pauseHistoryBackfill(
            owner,
            "gmail",
            account,
            "history_page_requires_review",
            null,
          ),
        ).toMatchObject({
          last_error: "history_page_requires_review",
          retry_after_until: later,
        });
        expect(
          await store.pauseHistoryBackfill(
            owner,
            "gmail",
            account,
            "provider_429",
            "2026-10-21T10:00:00.000Z",
          ),
        ).toMatchObject({
          last_error: "history_page_requires_review",
          retry_after_until: later,
        });
        const latest = "2026-10-23T10:00:00.000Z";
        expect(
          await store.pauseHistoryBackfill(
            owner,
            "gmail",
            account,
            "provider_503",
            latest,
          ),
        ).toMatchObject({
          last_error: "history_page_requires_review",
          retry_after_until: latest,
        });
        expect(
          await store.retryHistoryBackfill(
            owner,
            "gmail",
            account,
            "history_page_requires_review",
          ),
        ).toBe(true);
        expect((await store.historyBackfills(owner))[0]).toMatchObject({
          last_error: "owner_retry_requested",
          retry_after_until: latest,
        });
      } finally {
        await store.close();
      }
    });
  },
);
