import { describe, expect, it, vi } from "vitest";
import { createLiveServer } from "../src/live-api.ts";
import { TendStore } from "../src/engine.ts";
import { exampleLivePolicy } from "../src/live-policy.ts";
import { InternalAuth, verificationHash } from "../src/internal-auth.ts";
import type { HistoryCheckpoint } from "../src/live-store.ts";

describe("private historical review metadata", () => {
  it.each(["revoked", "race", "primary"] as const)(
    "keeps healthy progress scoped when another source is unavailable (%s)",
    async (mode) => {
      const policy = exampleLivePolicy;
      const clock = () => new Date("2026-10-20T12:00:00Z");
      const store = new TendStore(":memory:", {
        mode: "live",
        clock,
        principal: {
          owner_id: policy.principal_id,
          user_id: "live-owner",
          chat_id: "live-private",
        },
      });
      const checkpoint: HistoryCheckpoint = {
        owner_id: policy.principal_id,
        source: "gmail",
        account_id: policy.account_email,
        version: 1,
        watermark: clock().toISOString(),
        cursor: null,
        page_count: 1,
        record_count: 2,
        quarantined_count: 1,
        oldest_at: null,
        newest_at: null,
        status: "complete",
        retry_after_until: null,
        last_error: null,
        last_operation_hash: null,
        last_request_hash: null,
        updated_at: clock().toISOString(),
      };
      const reads = vi
        .spyOn(store, "historyBackfills")
        .mockReturnValue([
          checkpoint,
          { ...checkpoint, account_id: "unapproved@example.invalid" },
          { ...checkpoint, source: "calendar", account_id: "primary" },
        ]);
      const report = {
        total: 1,
        reason_counts: [{ reason: "body_size_limit", count: 1 }],
        reason_counts_truncated: false,
        items: [
          {
            source_record_id: "message#fragment",
            reason: "body_size_limit",
            observed_at: clock().toISOString(),
            original_reference: `tend-source:gmail/${encodeURIComponent(policy.account_email)}/message%23fragment`,
          },
          {
            source_record_id: "legacy-unattributed",
            reason: "invalid_provider_string",
            observed_at: clock().toISOString(),
            original_reference: null,
          },
        ],
      };
      const reviews = vi
        .spyOn(store, "historyQuarantines")
        .mockImplementation((...args) => {
          if (args[2] === "primary") {
            if (mode !== "primary")
              throw new Error("Source changed during review lookup");
            return {
              ...report,
              items: report.items.map((entry) => ({
                ...entry,
                original_reference: entry.original_reference
                  ? `tend-source:calendar/primary/${encodeURIComponent(entry.source_record_id)}`
                  : null,
              })),
            };
          }
          return report;
        });
      const server = createLiveServer({
        store,
        policy,
        clock,
        auth: new InternalAuth(
          undefined,
          verificationHash(
            "FICTIONAL_ONLY_0123456789_abcdefghijklmnopqrstuvwxyz_ABCD",
          ),
        ),
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      vi.spyOn(store, "sourceStatus").mockReturnValue(
        store
          .sourceStatus(policy.principal_id)
          .map((state) =>
            mode === "revoked" &&
            state.source === "calendar" &&
            state.account_id === "primary"
              ? { ...state, status: "revoked" }
              : state,
          ),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Local address missing");
      const base = `http://127.0.0.1:${address.port}`;
      try {
        expect((await fetch(base + "/private/api/progress")).status).toBe(401);
        expect(reads).not.toHaveBeenCalled();
        expect(reviews).not.toHaveBeenCalled();
        const page = await fetch(base + "/private");
        const nonce = (await page.text()).match(
          /name="nonce"[^>]*value="([^"]+)"/,
        )?.[1];
        if (!nonce) throw new Error("Local unlock nonce missing");
        const unlock = await fetch(base + "/private/unlock", {
          method: "POST",
          redirect: "manual",
          headers: {
            Origin: base,
            Cookie: page.headers.get("set-cookie")!.split(";")[0]!,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ nonce }),
        });
        expect(unlock.status).toBe(303);
        const result = await fetch(base + "/private/api/progress", {
          headers: { Cookie: unlock.headers.get("set-cookie")!.split(";")[0]! },
        });
        expect(result.status).toBe(200);
        expect(reviews).toHaveBeenCalledTimes(mode === "revoked" ? 1 : 2);
        expect(reviews).toHaveBeenCalledWith(
          policy.principal_id,
          "gmail",
          policy.account_email,
          25,
        );
        const data = (await result.json()) as {
          history: {
            last_error?: string;
            review: { total: number; items: { original_url: string }[] };
          }[];
        };
        expect(data.history).toHaveLength(2);
        if (mode === "primary") {
          expect(data.history[1]!.last_error).toBeNull();
          expect(
            data.history[1]!.review.items[0]!.original_url,
          ).toBeUndefined();
        } else {
          expect(data.history[1]!.last_error).toBe(
            mode === "revoked"
              ? "source_revoked"
              : "review_metadata_unavailable",
          );
          expect(data.history[1]!.review).toBeNull();
        }
        expect(data.history[0]!.review.total).toBe(1);
        expect(data.history[0]!.review.items[0]!.original_url).toBe(
          `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(policy.account_email)}#all/message%23fragment`,
        );
        expect(data.history[0]!.review.items[1]!.original_url).toBeUndefined();
        expect(JSON.stringify(data)).not.toContain(
          "unapproved@example.invalid",
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        store.close();
        vi.restoreAllMocks();
      }
    },
  );
});
