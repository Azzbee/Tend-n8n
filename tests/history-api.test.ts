import { describe, expect, it } from "vitest";
import { TendStore } from "../src/engine.ts";
import { exampleLivePolicy } from "../src/live-policy.ts";
import { createHistoryAPI } from "../src/history-api.ts";
const now = () => new Date("2026-10-20T10:00:00Z");
const policy = {
  ...exampleLivePolicy,
  history: { version: 1 as const, mode: "all_available" as const },
};
async function setup() {
  const store = new TendStore(":memory:", {
    clock: now,
    mode: "live",
    principal: {
      owner_id: policy.principal_id,
      user_id: "live-owner",
      chat_id: "live-private",
    },
  });
  await store.seed(
    [],
    [],
    [
      {
        owner_id: policy.principal_id,
        source: "gmail",
        account_id: policy.account_email,
        status: "partial",
        mode: "live",
        last_success: null,
        coverage_start: "2026-09-20T10:00:00Z",
        coverage_end: now().toISOString(),
        cursor: "incremental-cursor",
      },
    ],
  );
  return store;
}
describe("isolated history API lane", () => {
  it("freezes the history watermark while preserving the incremental cursor", async () => {
    const store = await setup();
    try {
      const api = createHistoryAPI({
        store,
        policy,
        clock: now,
        resources: async () => ({
          free_bytes: 3 * 1024 ** 3,
          database_bytes: 100,
          index_bytes: 0,
        }),
      });
      const first = await api.state("gmail");
      expect(first.lane).toBe("history");
      expect(first.window_start).toBe("0001-01-01T00:00:00.000Z");
      expect(first.cursor).toBe(null);
      expect((await store.sourceStatus(policy.principal_id))[0]?.cursor).toBe(
        "incremental-cursor",
      );
      expect((await api.state("gmail")).window_end).toBe(first.window_end);
    } finally {
      store.close();
    }
  });
  it("pauses before a provider read at the disk floor", async () => {
    const store = await setup();
    try {
      const api = createHistoryAPI({
        store,
        policy,
        clock: now,
        resources: async () => ({
          free_bytes: 1024 ** 3,
          database_bytes: 100,
          index_bytes: 0,
        }),
      });
      const state = await api.state("gmail");
      expect(state.request_allowed).toBe(false);
      expect(state.reason).toContain("disk");
    } finally {
      store.close();
    }
  });
  it("requires the explicit approved versioned history mode", async () => {
    const store = await setup();
    try {
      const api = createHistoryAPI({
        store,
        policy: exampleLivePolicy,
        clock: now,
        resources: async () => ({
          free_bytes: 3 * 1024 ** 3,
          database_bytes: 0,
          index_bytes: 0,
        }),
      });
      await expect(api.state("gmail")).rejects.toThrow(/approved/i);
    } finally {
      store.close();
    }
  });
});
it("does not advance a malformed history page or claim it is complete", async () => {
  const store = await setup();
  try {
    const api = createHistoryAPI({
      store,
      policy,
      clock: now,
      resources: async () => ({
        free_bytes: 3 * 1024 ** 3,
        database_bytes: 0,
        index_bytes: 0,
      }),
    });
    const state = await api.state("gmail");
    const result = await api.commit({
      ...state,
      profile_account_email: policy.account_email,
      records: [{ id: "bad", oversized: true }],
      previous_cursor: null,
      cursor: null,
      complete: true,
    });
    expect(result.paused).toBe(true);
    expect(result.complete).toBe(false);
    expect(
      (await store.historyBackfills(policy.principal_id))[0]?.page_count,
    ).toBe(0);
    expect((await store.historyBackfills(policy.principal_id))[0]?.status).toBe(
      "paused",
    );
  } finally {
    store.close();
  }
});
it("allows exact acknowledged-page retries without writing again", async () => {
  const store = await setup();
  try {
    const api = createHistoryAPI({
      store,
      policy,
      clock: now,
      resources: async () => ({
        free_bytes: 3 * 1024 ** 3,
        database_bytes: 0,
        index_bytes: 0,
      }),
    });
    const state = await api.state("gmail");
    const page = {
      ...state,
      profile_account_email: policy.account_email,
      records: [],
      previous_cursor: null,
      cursor: "next-history-page",
      complete: false,
    };
    await api.commit(page);
    expect(await api.commit(page)).toMatchObject({
      accepted: 0,
      replayed: true,
    });
    expect(
      (await store.historyBackfills(policy.principal_id))[0]?.page_count,
    ).toBe(1);
    await expect(
      api.commit({ ...page, cursor: "changed-page" }),
    ).rejects.toThrow(/stale/);
  } finally {
    store.close();
  }
});
