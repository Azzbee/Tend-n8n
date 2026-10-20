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
  },
);
