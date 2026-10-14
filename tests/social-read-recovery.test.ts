import { describe, expect, it, vi } from "vitest";
import { TendStore } from "../src/engine.ts";
import {
  SocialReadSessions,
  type SocialReadInput,
  type SocialReadResult,
} from "../src/social-read-session.ts";
import { parseSocialPolicy, socialWindow } from "../src/social-policy.ts";

const personal = {
  source: "whatsapp_personal" as const,
  account_id: "personal-one",
};
const linked = {
  source: "linkedin" as const,
  account_id: "urn:li:person:owner",
};
const policy = parseSocialPolicy({
  window_days: 30,
  accounts: [
    {
      ...personal,
      provider: "unipile",
      owner_identity: "owner-user",
      owner_verified: true,
      api_base_url: "https://api1.unipile.com:13111",
    },
    {
      ...linked,
      provider: "linkedin",
      owner_identity: linked.account_id,
      owner_verified: true,
      profile_bindings: [],
    },
  ],
})!;
function request(
  input: SocialReadInput,
): Extract<SocialReadInput, { available: true }> {
  if (!input.available) throw new Error(input.reason);
  return input;
}
function identity(input: SocialReadResult): string {
  if (input.kind !== "identity")
    throw new Error("Identity verification failed");
  return input.proof_id;
}
function setup(
  account: typeof personal | typeof linked = personal,
  age = 0,
  cursor: string | null = null,
) {
  let now = new Date("2026-10-14T12:00:00.000Z");
  const owner = "fictional-recovery-owner";
  const store = new TendStore(":memory:", {
    mode: "live",
    principal: { owner_id: owner, user_id: "u", chat_id: "c" },
    clock: () => now,
  });
  const window = socialWindow(new Date(now.getTime() - age));
  store.seed(
    [],
    [],
    [
      {
        ...account,
        owner_id: owner,
        mode: "live",
        last_success: null,
        status: "partial",
        coverage_start: window.start,
        coverage_end: window.end,
        cursor,
      },
    ],
  );
  const sessions = new SocialReadSessions({
    store,
    policy,
    principal_id: owner,
    clock: () => now,
  });
  return {
    store,
    owner,
    sessions,
    now: () => now,
    advance: () => {
      now = new Date(now.getTime() + 60000);
    },
    proof: async () => {
      const p = request(await sessions.plan({ ...account, phase: "identity" }));
      return identity(
        await sessions.result({
          request_id: p.request_id,
          status: 200,
          body:
            account.source === "whatsapp_personal"
              ? {
                  object: "Account",
                  type: "WHATSAPP",
                  id: account.account_id,
                  connection_params: { im: { phone_number: "owner-user" } },
                  sources: [{ status: "OK" }],
                }
              : {
                  elements: [
                    {
                      memberComplianceAuthorizationKey: {
                        member: account.account_id,
                      },
                      memberComplianceScopes: ["DMA"],
                      regulatedAt: now.getTime() - 86400000,
                    },
                  ],
                },
        }),
      );
    },
  };
}
const message = (id: string) => ({
  id,
  account_id: personal.account_id,
  chat_id: "thread",
  sender_id: "friend",
  is_sender: false,
  timestamp: "2026-10-13T12:00:00Z",
  text: "Fictional context",
  attendees: [
    { attendee_provider_id: "owner-user" },
    { attendee_provider_id: "friend" },
  ],
});
describe("pure SQLite social read recovery", () => {
  it("records distinct terminal quarantines without declaring current coverage", async () => {
    const x = setup();
    try {
      const proof_id = await x.proof();
      const p = request(
        await x.sessions.plan({ ...personal, phase: "snapshot", proof_id }),
      );
      const result = await x.sessions.result({
        request_id: p.request_id,
        status: 200,
        body: {
          object: "MessageList",
          cursor: null,
          items: [
            { ...message("bad-one"), is_sender: "invalid" },
            { ...message("bad-two"), is_sender: "invalid" },
            { account_id: personal.account_id, text: "PRIVATE MALFORMED A" },
            { account_id: personal.account_id, text: "PRIVATE MALFORMED B" },
          ],
        },
      });
      expect(result).toMatchObject({
        kind: "page",
        complete: false,
        pagination_complete: true,
        evidence_partial: true,
        quarantined: 4,
      });
      expect(x.store.quarantineCount(x.owner)).toBe(4);
      expect(x.store.sourceStatus(x.owner)[0]?.status).toBe("partial");
      expect(JSON.stringify(result)).not.toContain("PRIVATE MALFORMED");
      const retry = request(
        await x.sessions.plan({ ...personal, phase: "identity" }),
      );
      expect(
        await x.sessions.result({
          request_id: retry.request_id,
          status: 429,
          body: {},
          headers: { "Retry-After": "5" },
        }),
      ).toMatchObject({ kind: "blocked" });
      expect(x.store.sourceStatus(x.owner)[0]).toMatchObject({
        status: "stale",
        pagination_complete: true,
      });
      x.advance();
      const renewedProof = await x.proof();
      const fresh = request(
        await x.sessions.plan({
          ...personal,
          phase: "snapshot",
          proof_id: renewedProof,
        }),
      );
      expect(fresh.plan.coverage_end).toBe(x.now().toISOString());
    } finally {
      x.store.close();
    }
  });
  it("keeps an obsolete LinkedIn change-feed gap blocked after fresh identity verification", async () => {
    const cursor = `li-change:${Date.parse("2026-09-13T12:00:00.000Z")}`;
    const x = setup(linked, 31 * 86400000, cursor);
    try {
      const proof_id = await x.proof();
      expect(
        await x.sessions.plan({ ...linked, phase: "changes", proof_id }),
      ).toMatchObject({ available: false, reason: "changelog_retention_gap" });
      expect(x.store.sourceStatus(x.owner)[0]?.cursor).toBe(cursor);
    } finally {
      x.store.close();
    }
  });
  it("does not resurrect a source revoked immediately before an obsolete reset", async () => {
    const x = setup(personal, 31 * 86400000, "old-cursor");
    try {
      const proof_id = await x.proof();
      const reset = x.store.reconnectLiveSource.bind(x.store);
      vi.spyOn(x.store, "reconnectLiveSource").mockImplementation((...args) => {
        x.store.revokeSource(x.owner, personal.source);
        return reset(...args);
      });
      expect(
        await x.sessions.plan({ ...personal, phase: "snapshot", proof_id }),
      ).toMatchObject({ available: false });
      expect(x.store.sourceStatus(x.owner)[0]?.status).toBe("revoked");
    } finally {
      x.store.close();
    }
  });
  it("keeps terminal quarantines partial, preserves unseen evidence and starts a fresh window", async () => {
    const x = setup();
    try {
      const proof_id = await x.proof();
      const page = async (items: unknown[], cursor: string | null) => {
        const p = request(
          await x.sessions.plan({ ...personal, phase: "snapshot", proof_id }),
        );
        return x.sessions.result({
          request_id: p.request_id,
          status: 200,
          body: { object: "MessageList", items, cursor },
        });
      };
      expect(await page([message("retained")], null)).toMatchObject({
        kind: "page",
        complete: true,
      });
      x.advance();
      expect(
        await page([{ ...message("bad-one"), is_sender: "invalid" }], "second"),
      ).toMatchObject({ kind: "page", complete: false });
      expect(await page([], null)).toMatchObject({
        kind: "page",
        complete: false,
        pagination_complete: true,
        evidence_partial: true,
      });
      expect(x.store.sourceStatus(x.owner)[0]).toMatchObject({
        status: "partial",
        cursor: null,
        evidence_incomplete: true,
        pagination_complete: true,
      });
      expect(
        x.store.interactions(x.owner).map((r) => r.source_record_id),
      ).toEqual(["retained"]);
      x.advance();
      const fresh = request(
        await x.sessions.plan({ ...personal, phase: "snapshot", proof_id }),
      );
      expect(fresh.plan.coverage_end).toBe(x.now().toISOString());
      expect(x.store.sourceStatus(x.owner)[0]).toMatchObject({
        status: "partial",
        cursor: null,
        evidence_incomplete: false,
        pagination_complete: false,
      });
    } finally {
      x.store.close();
    }
  });
  it("does not turn system-event-only terminal pages into an endless quarantine loop", async () => {
    const x = setup();
    try {
      const proof_id = await x.proof();
      const original = request(
        await x.sessions.plan({ ...personal, phase: "snapshot", proof_id }),
      );
      await x.sessions.result({
        request_id: original.request_id,
        status: 200,
        body: {
          object: "MessageList",
          items: [message("system-event")],
          cursor: null,
        },
      });
      expect(x.store.counts(x.owner).interactions).toBe(1);
      x.advance();
      const p = request(
        await x.sessions.plan({ ...personal, phase: "snapshot", proof_id }),
      );
      expect(
        await x.sessions.result({
          request_id: p.request_id,
          status: 200,
          body: {
            object: "MessageList",
            items: [
              {
                id: "system-event",
                account_id: personal.account_id,
                is_event: true,
              },
            ],
            cursor: null,
          },
        }),
      ).toMatchObject({
        kind: "page",
        complete: true,
        quarantined: 0,
        pagination_complete: true,
        evidence_partial: false,
      });
      expect(x.store.sourceStatus(x.owner)[0]?.status).toBe("current");
      expect(x.store.counts(x.owner).interactions).toBe(0);
    } finally {
      x.store.close();
    }
  });
  it.each([personal, linked])(
    "refreshes an obsolete partial $source window after a fresh identity proof",
    async (account) => {
      const x = setup(
        account,
        31 * 86400000,
        account.source === "linkedin" ? "li-snapshot:3" : "old-provider-cursor",
      );
      try {
        const proof_id = await x.proof();
        const p = request(
          await x.sessions.plan({ ...account, phase: "snapshot", proof_id }),
        );
        expect(p.plan.coverage_end).toBe(x.now().toISOString());
        expect(p.plan.expected_cursor).toBeNull();
        expect(x.store.sourceStatus(x.owner)[0]).toMatchObject({
          status: "partial",
          cursor: null,
          coverage_end: x.now().toISOString(),
        });
      } finally {
        x.store.close();
      }
    },
  );
});
