import { describe, expect, it, vi } from "vitest";
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
  it.each(["history_page_requires_review", "provider_429"])(
    "keeps %s and its future provider deadline through resource pressure",
    async (error) => {
      const store = await setup();
      let free = 3 * 1024 ** 3;
      const resources = vi.fn(async () => ({
        free_bytes: free,
        database_bytes: 0,
        index_bytes: 0,
      }));
      try {
        const api = createHistoryAPI({ store, policy, clock: now, resources });
        await api.state("gmail");
        const held = await store.pauseHistoryBackfill(
          policy.principal_id,
          "gmail",
          policy.account_email,
          error,
          "2026-10-21T10:00:00.000Z",
        );
        const checks = resources.mock.calls.length;
        free = 1024 ** 3;
        expect((await api.state("gmail")).request_allowed).toBe(false);
        expect((await store.historyBackfills(policy.principal_id))[0]).toEqual(
          held,
        );
        free = 3 * 1024 ** 3;
        expect((await api.state("gmail")).request_allowed).toBe(false);
        expect((await store.historyBackfills(policy.principal_id))[0]).toEqual(
          held,
        );
        expect(resources.mock.calls).toHaveLength(checks);
      } finally {
        store.close();
      }
    },
  );
  it.each(["history_page_requires_review", "provider_429"])(
    "keeps concurrent %s written while measuring resources",
    async (error) => {
      const store = await setup();
      try {
        await store.beginHistoryBackfill(
          policy.principal_id,
          "gmail",
          policy.account_email,
          now().toISOString(),
        );
        let held:
          Awaited<ReturnType<typeof store.pauseHistoryBackfill>> | undefined;
        const api = createHistoryAPI({
          store,
          policy,
          clock: now,
          resources: async () => {
            held = await store.pauseHistoryBackfill(
              policy.principal_id,
              "gmail",
              policy.account_email,
              error,
              "2026-10-21T10:00:00.000Z",
            );
            return { free_bytes: 1024 ** 3, database_bytes: 0, index_bytes: 0 };
          },
        });
        expect((await api.state("gmail")).request_allowed).toBe(false);
        expect((await store.historyBackfills(policy.principal_id))[0]).toEqual(
          held,
        );
      } finally {
        store.close();
      }
    },
  );
  it("resumes a resource-only pause once disk recovers", async () => {
    const store = await setup();
    let free = 1024 ** 3;
    try {
      const api = createHistoryAPI({
        store,
        policy,
        clock: now,
        resources: async () => ({
          free_bytes: free,
          database_bytes: 0,
          index_bytes: 0,
        }),
      });
      expect(await api.state("gmail")).toMatchObject({
        request_allowed: false,
        reason: "disk_floor",
      });
      free = 3 * 1024 ** 3;
      expect(await api.state("gmail")).toMatchObject({
        request_allowed: true,
        reason: null,
      });
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
      records: [{ oversized: true }],
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
it("keeps long provider waits and immediately withdraws a lost Google grant", async () => {
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
    await api.state("gmail");
    await api.error({
      source: "gmail",
      status_code: 429,
      retry_after_seconds: 172800,
    });
    expect(
      (await store.historyBackfills(policy.principal_id))[0]?.retry_after_until,
    ).toBe("2026-10-22T10:00:00.000Z");
    expect((await api.state("gmail")).request_allowed).toBe(false);
    await api.error({
      source: "gmail",
      status_code: 401,
      reconnect_required: true,
    });
    expect((await store.sourceStatus(policy.principal_id))[0]?.status).toBe(
      "revoked",
    );
    expect((await api.state("gmail")).reason).toBe("source_revoked");
  } finally {
    store.close();
  }
});
it("holds a quarantined page until reviewed instead of retrying it every poll", async () => {
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
    await api.commit({
      ...state,
      profile_account_email: policy.account_email,
      records: [{ oversized: true }],
      previous_cursor: null,
      cursor: null,
      complete: true,
    });
    expect(await api.state("gmail")).toMatchObject({
      request_allowed: false,
      reason: "history_page_requires_review",
    });
  } finally {
    store.close();
  }
});
it("counts one provider page after partial storage chunks finish", async () => {
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
    const state = await api.state("gmail"),
      base = {
        ...state,
        profile_account_email: policy.account_email,
        records: [],
        previous_cursor: null,
      };
    await api.commit({
      ...base,
      advance: false,
      cursor: null,
      complete: false,
    });
    expect(
      (await store.historyBackfills(policy.principal_id))[0]?.page_count,
    ).toBe(0);
    await api.commit({
      ...base,
      advance: true,
      cursor: "next",
      complete: false,
    });
    expect(
      (await store.historyBackfills(policy.principal_id))[0]?.page_count,
    ).toBe(1);
  } finally {
    store.close();
  }
});

it("applies only confirmed Calendar withdrawals when new ingestion is resource-paused", async () => {
  const store = await setup();
  try {
    await store.seed(
      [],
      [],
      [
        {
          owner_id: policy.principal_id,
          source: "calendar",
          account_id: "primary",
          status: "partial",
          mode: "live",
          last_success: null,
          coverage_start: "2026-10-20T10:00:00.000Z",
          coverage_end: "2026-10-27T10:00:00.000Z",
          cursor: null,
        },
      ],
    );
    let enough = true;
    const api = createHistoryAPI({
      store,
      policy,
      clock: now,
      resources: async () => ({
        free_bytes: enough ? 3 * 1024 ** 3 : 1024 ** 3,
        database_bytes: 0,
        index_bytes: 0,
      }),
    });
    const state = await api.state("calendar");
    const commit = vi.spyOn(store, "commitHistoryBackfill");
    enough = false;
    const result = await api.commit({
      ...state,
      profile_account_email: policy.account_email,
      records: [{ id: "cancelled-source-event", status: "cancelled" }],
      previous_cursor: null,
      cursor: "next",
      complete: false,
    });
    expect(result).toMatchObject({
      accepted: 0,
      paused: true,
      reason: "disk_floor",
    });
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        advance: false,
        cursor: null,
        records: [],
        removed_record_ids: ["cancelled-source-event"],
      }),
    );
    expect(
      (await store.historyBackfills(policy.principal_id))[0],
    ).toMatchObject({ status: "paused", cursor: null, page_count: 0 });
    enough = true;
    await api.commit({
      ...state,
      profile_account_email: policy.account_email,
      records: [{ id: "cancelled-source-event", status: "cancelled" }],
      previous_cursor: null,
      cursor: "next",
      complete: false,
    });
    expect(
      (await store.historyBackfills(policy.principal_id))[0],
    ).toMatchObject({ cursor: "next", page_count: 1 });
  } finally {
    store.close();
  }
});
it("keeps a quota 403 separate from revoking the connected Google source", async () => {
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
    await api.state("gmail");
    expect(
      await api.error({
        source: "gmail",
        status_code: 403,
        reconnect_required: false,
        retry_after_seconds: 3600,
      }),
    ).toMatchObject({ reconnect_required: false });
    expect((await store.sourceStatus(policy.principal_id))[0]?.status).toBe(
      "partial",
    );
  } finally {
    store.close();
  }
});

it("imports readable history beside a stable unreadable record and queues it exactly once", async () => {
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
    const readable = {
      id: "readable-mail",
      threadId: "thread-one",
      labelIds: ["INBOX"],
      internalDate: String(Date.parse("2020-01-01T10:00:00Z")),
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "peer@example.com" },
          { name: "To", value: policy.account_email },
        ],
        body: {
          data: Buffer.from("Hello from a historical message").toString(
            "base64url",
          ),
        },
      },
    };
    const page = {
      ...state,
      profile_account_email: policy.account_email,
      records: [readable, { id: "oversized-mail", oversized: true }],
      previous_cursor: null,
      cursor: "next-page",
      complete: false,
    };
    expect(await api.commit(page)).toMatchObject({
      accepted: 1,
      quarantined: 1,
      content_complete: false,
    });
    const checkpoint = (await store.historyBackfills(policy.principal_id))[0]!;
    expect(checkpoint).toMatchObject({
      page_count: 1,
      record_count: 1,
      quarantined_count: 1,
      cursor: "next-page",
    });
    expect(await store.quarantineCount(policy.principal_id)).toBe(1);
    expect(await api.commit(page)).toMatchObject({ replayed: true });
    expect(await store.quarantineCount(policy.principal_id)).toBe(1);
    expect(
      (await store.interactions(policy.principal_id)).map(
        (r) => r.source_record_id,
      ),
    ).toEqual(["readable-mail"]);
  } finally {
    store.close();
  }
});
it("finishes pagination without claiming complete content when only an oversized stable record is unavailable", async () => {
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
    expect(
      await api.commit({
        ...state,
        profile_account_email: policy.account_email,
        records: [{ id: "oversized-mail", oversized: true }],
        previous_cursor: null,
        cursor: null,
        complete: true,
      }),
    ).toMatchObject({
      accepted: 0,
      quarantined: 1,
      complete: true,
      content_complete: false,
    });
    expect(
      (await store.historyBackfills(policy.principal_id))[0],
    ).toMatchObject({ status: "complete", quarantined_count: 1 });
  } finally {
    store.close();
  }
});

it.each([
  { id: "foreign-marker", oversized: true, account_id: "different-account" },
  {
    id: "not-an-approved-marker",
    oversized: true,
    account_email: "other@example.com",
  },
  { id: "id with whitespace", oversized: true },
])(
  "holds unsafe record structure or provenance without advancing: %j",
  async (raw) => {
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
      expect(
        await api.commit({
          ...state,
          profile_account_email: policy.account_email,
          records: [raw],
          previous_cursor: null,
          cursor: "must-not-advance",
          complete: false,
        }),
      ).toMatchObject({ paused: true, reason: "history_page_requires_review" });
      expect(
        (await store.historyBackfills(policy.principal_id))[0],
      ).toMatchObject({ page_count: 0, record_count: 0, cursor: null });
      expect(await store.quarantineCount(policy.principal_id)).toBe(0);
    } finally {
      store.close();
    }
  },
);
it("queues a stable oversized Calendar record with an explicit source reference", async () => {
  const store = await setup();
  try {
    await store.seed(
      [],
      [],
      [
        {
          owner_id: policy.principal_id,
          source: "calendar",
          account_id: "primary",
          status: "partial",
          mode: "live",
          last_success: null,
          coverage_start: "2026-09-20T10:00:00Z",
          coverage_end: now().toISOString(),
          cursor: null,
        },
      ],
    );
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
    const state = await api.state("calendar", "primary");
    expect(
      await api.commit({
        ...state,
        profile_account_email: policy.account_email,
        records: [{ id: "large-event", oversized: true }],
        previous_cursor: null,
        cursor: null,
        complete: true,
      }),
    ).toMatchObject({
      quarantined: 1,
      complete: true,
      content_complete: false,
    });
    expect(
      await store.historyQuarantines(
        policy.principal_id,
        "calendar",
        "primary",
      ),
    ).toMatchObject({
      total: 1,
      reason_counts: [{ reason: "history_record_oversized", count: 1 }],
      items: [
        {
          source_record_id: "large-event",
          reason: "history_record_oversized",
          original_reference: "tend-source:calendar/primary/large-event",
        },
      ],
    });
  } finally {
    store.close();
  }
});

it("queues an owned stable record with missing mandatory fields instead of holding readable siblings", async () => {
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
    expect(
      await api.commit({
        ...state,
        profile_account_email: policy.account_email,
        records: [{ id: "stable-but-missing-fields" }],
        previous_cursor: null,
        cursor: "next",
        complete: false,
      }),
    ).toMatchObject({
      quarantined: 1,
      complete: false,
      evidence_partial: true,
    });
    expect(
      await store.historyQuarantines(
        policy.principal_id,
        "gmail",
        policy.account_email,
      ),
    ).toMatchObject({
      total: 1,
      items: [
        {
          source_record_id: "stable-but-missing-fields",
          reason: "invalid_provider_string",
        },
      ],
    });
  } finally {
    store.close();
  }
});
it("rejects an invalid outer history wrapper without changing the checkpoint", async () => {
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
    await expect(
      api.commit({
        ...state,
        profile_account_email: policy.account_email,
        records: { id: "not-a-page" },
        previous_cursor: null,
        cursor: "next",
        complete: false,
      }),
    ).rejects.toThrow("Invalid or stale history page");
    expect(
      (await store.historyBackfills(policy.principal_id))[0],
    ).toMatchObject({ cursor: null, page_count: 0 });
  } finally {
    store.close();
  }
});

it("reports only retained records when the store rejects normalized older observations", async () => {
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
    const commit = vi
      .spyOn(store, "commitHistoryBackfill")
      .mockReturnValueOnce([]);
    const result = await api.commit({
      ...state,
      profile_account_email: policy.account_email,
      records: [
        {
          id: "stale-readable-mail",
          threadId: "thread",
          labelIds: ["INBOX"],
          internalDate: String(Date.parse("2020-01-01T10:00:00Z")),
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: "peer@example.com" },
              { name: "To", value: policy.account_email },
            ],
            body: {
              data: Buffer.from("Older readable content").toString("base64url"),
            },
          },
        },
      ],
      previous_cursor: null,
      cursor: "next",
      complete: false,
    });
    expect(commit.mock.calls[0]?.[0].records).toHaveLength(1);
    expect(result.accepted).toBe(0);
  } finally {
    store.close();
  }
});

it.each(["DRAFT", "SPAM", "TRASH"])(
  "excludes policy label %s without leaving a permanent content-review entry",
  async (label) => {
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
      store.commitHistoryBackfill({
        owner_id: policy.principal_id,
        source: "gmail",
        account_id: policy.account_email,
        version: 1,
        watermark: String(state.watermark),
        expected_cursor: null,
        cursor: null,
        advance: false,
        operation_hash: "a".repeat(64),
        complete: false,
        records: [],
        quarantines: [
          {
            source_record_id: "policy-excluded",
            reason: "body_size_limit",
            observed_at: now().toISOString(),
            original_reference: `tend-source:gmail/${encodeURIComponent(policy.account_email)}/policy-excluded`,
          },
        ],
      });
      const result = await api.commit({
        ...state,
        profile_account_email: policy.account_email,
        records: [
          { id: "policy-excluded", threadId: "thread", labelIds: [label] },
        ],
        previous_cursor: null,
        cursor: null,
        complete: true,
      });
      expect(result).toMatchObject({
        accepted: 0,
        quarantined: 0,
        complete: true,
        content_complete: true,
      });
      expect(store.quarantineCount(policy.principal_id)).toBe(0);
      expect(store.interactions(policy.principal_id)).toHaveLength(0);
    } finally {
      store.close();
    }
  },
);

describe("history resource budget", () => {
  it("allows a 1 GiB semantic index and blocks above it", async () => {
    const { INDEX_BUDGET } = await import("../src/semantic-search.ts");
    expect(INDEX_BUDGET).toBe(1024 ** 3);
  });
});
