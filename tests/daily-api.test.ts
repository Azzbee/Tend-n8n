import { describe, expect, it } from "vitest";
import { formatDailyDigest } from "../src/daily-api.ts";

describe("safe plain-text daily digest formatting", () => {
  it("includes cited priorities, proposal labels and explicit source coverage", () => {
    const text = formatDailyDigest({
      outbound_sent: false,
      priorities: [
        {
          kind: "meeting",
          reason: "Upcoming meeting",
          date: "2026-10-21T08:00:00Z",
          text: "Project <review>",
          source: "calendar",
          reference: "https://example.invalid/meeting",
        },
      ],
      priority_pending: [
        {
          text: "Possible follow-up",
          source: "gmail",
          reference: "https://example.invalid/mail",
        },
      ],
      coverage: [
        {
          source: "gmail",
          status: "partial",
          mode: "live",
          account_id: "owner@example.invalid",
          coverage_start: "2000-01-01",
          coverage_end: "2026-10-20",
        },
      ],
    });
    expect(text).toContain("Project <review>");
    expect(text).toContain("https://example.invalid/meeting");
    expect(text).toContain("Unconfirmed proposals. These are not deadlines.");
    expect(text).toContain("gmail: partial (live)");
    expect(text).toContain("Imported coverage may be partial");
  });
  it("does not infer absence or urgency from an empty import", () => {
    expect(
      formatDailyDigest({ outbound_sent: false, priorities: [], coverage: [] }),
    ).toContain("does not establish that no work exists");
  });
  it("rejects stale fallback and unrelated normal-message replies", () => {
    expect(() =>
      formatDailyDigest({ outbound_sent: false, warning: "Evidence changed" }),
    ).toThrow();
  });
  it("keeps user text bounded and does not format held drafts as daily priorities", () => {
    const text = formatDailyDigest({
      outbound_sent: false,
      priorities: [
        {
          kind: "review_suggestion",
          text: "x".repeat(10000),
          source: "gmail",
          reference: "y".repeat(10000),
        },
      ],
      coverage: [],
    });
    expect(text.length).toBeLessThanOrEqual(3900);
    expect(() =>
      formatDailyDigest({
        outbound_sent: false,
        ai: { draft: { text: "Hi" } },
      }),
    ).toThrow();
  });
});

import { createDailyAPI } from "../src/daily-api.ts";
import { TendStore } from "../src/engine.ts";
import { exampleLivePolicy } from "../src/live-policy.ts";

describe("private daily API integration", () => {
  function setup() {
    const clock = () => new Date("2026-10-20T07:00:00Z");
    const policy = { ...exampleLivePolicy, principal_id: "owner" };
    const store = new TendStore(":memory:", {
      mode: "live",
      clock,
      principal: {
        owner_id: "owner",
        user_id: "live-owner",
        chat_id: "live-private",
      },
    });
    store.seed([], [], []);
    const api = createDailyAPI({
      store,
      policy,
      clock,
      owner: { owner_id: "owner", user_id: "12345", chat_id: "12345" },
      normalModel: async () => {
        throw new Error("A scheduled digest must not call a classifier");
      },
    });
    return { api, store, policy };
  }
  it("prepares a deterministic cited digest and acknowledges one real owner receipt", async () => {
    const { api, store } = setup();
    try {
      const p = await api.prepare();
      expect(p.state).toBe("pending");
      const selection = {
        paris_date: p.paris_date,
        delivery_id: p.delivery_id,
      };
      const result = await api.claim(selection);
      expect(result.transport?.chat_id).toBe("12345");
      expect(result.transport?.text).toContain(
        "Imported coverage may be partial",
      );
      expect(
        await api.acknowledge({
          ...selection,
          receipt: { message_id: 82, chat: { id: 12345, type: "private" } },
        }),
      ).toEqual({ acknowledged: true, outbound_sent: false });
      expect((await api.status()).delivery?.state).toBe("sent");
      expect((await api.claim(selection)).transport).toBeNull();
    } finally {
      store.close();
    }
  });
  it("rejects caller-supplied destination and principal fields", async () => {
    const { api, store } = setup();
    try {
      const p = await api.prepare();
      await expect(
        api.claim({
          paris_date: p.paris_date,
          delivery_id: p.delivery_id,
          chat_id: "999",
        }),
      ).rejects.toThrow();
      await expect(
        api.acknowledge({
          paris_date: p.paris_date,
          delivery_id: p.delivery_id,
          receipt: {},
          owner_id: "other",
        }),
      ).rejects.toThrow();
    } finally {
      store.close();
    }
  });
  it("holds uncertain delivery without sending again", async () => {
    const { api, store } = setup();
    try {
      const p = await api.prepare();
      const selection = {
        paris_date: p.paris_date,
        delivery_id: p.delivery_id,
      };
      await api.claim(selection);
      expect(await api.uncertain(selection)).toEqual({
        held: true,
        outbound_sent: false,
      });
      expect((await api.prepare()).state).toBe("uncertain");
      expect((await api.claim(selection)).transport).toBeNull();
    } finally {
      store.close();
    }
  });
  it("rejects a destination binding from another policy owner", () => {
    const { store, policy } = setup();
    try {
      expect(() =>
        createDailyAPI({
          store,
          policy,
          owner: { owner_id: "other", user_id: "12345", chat_id: "12345" },
        }),
      ).toThrow(/owner/);
    } finally {
      store.close();
    }
  });
});
