import { describe, expect, it } from "vitest";
import { createLiveServer } from "../src/live-api.ts";
import { TendStore } from "../src/engine.ts";
import { InternalAuth, verificationHash } from "../src/internal-auth.ts";
import { exampleLivePolicy } from "../src/live-policy.ts";
const key = "FICTIONAL_ONLY_0123456789_abcdefghijklmnopqrstuvwxyz_ABCD";
const clock = () => new Date("2026-10-20T10:00:00Z");
const policy = {
  ...exampleLivePolicy,
  history: { version: 1 as const, mode: "all_available" as const },
};
async function setup() {
  const store = new TendStore(":memory:", {
    mode: "live",
    clock,
    principal: {
      owner_id: policy.principal_id,
      user_id: "live-owner",
      chat_id: "live-private",
    },
  });
  const server = createLiveServer({
    store,
    policy,
    clock,
    auth: new InternalAuth(undefined, verificationHash(key)),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  const read = async (source = "gmail") =>
    (await (
      await fetch(
        `http://127.0.0.1:${address.port}/api/live/sync-state?source=${source}&lane=auto`,
        { headers: { Authorization: "Bearer " + key } },
      )
    ).json()) as Record<string, unknown>;
  const close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  };
  return { store, read, close };
}
describe("automatic history routing", () => {
  it("alternates fresh and historical reads even when every poll lands in an even minute", async () => {
    const x = await setup();
    try {
      expect((await x.read()).lane).toBeUndefined();
      expect((await x.read()).lane).toBe("history");
      expect((await x.read()).lane).toBeUndefined();
    } finally {
      await x.close();
    }
  });
  it("falls back to fresh reads when a historical page needs owner review", async () => {
    const x = await setup();
    try {
      await x.read();
      await x.store.pauseHistoryBackfill(
        policy.principal_id,
        "gmail",
        policy.account_email,
        "oversized_requires_review",
        null,
      );
      const next = await x.read();
      expect(next.lane).toBeUndefined();
      expect(next.budget).toBeDefined();
      expect(
        (await x.store.historyBackfills(policy.principal_id))[0]?.last_error,
      ).toBe("oversized_requires_review");
    } finally {
      await x.close();
    }
  });
  it("keeps independent fresh/history turns for each calendar", async () => {
    const x = await setup();
    try {
      const results = await Promise.all([
        x.read("calendar"),
        x.read("calendar"),
      ]);
      expect(new Set(results.map((r) => r.calendar_id)).size).toBe(2);
      expect(results.every((r) => r.lane === undefined)).toBe(true);
      const histories = [await x.read("calendar"), await x.read("calendar")];
      expect(histories.every((r) => r.lane === "history")).toBe(true);
      expect(new Set(histories.map((r) => r.calendar_id)).size).toBe(2);
    } finally {
      await x.close();
    }
  });
});
