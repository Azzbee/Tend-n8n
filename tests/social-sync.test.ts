import { TendStore } from "../src/engine.ts";
import { describe, expect, it } from "vitest";
import {
  normalizeSocialBatch,
  type SocialSyncRequest,
  type SocialSyncContext,
} from "../src/social-sync.ts";
import { parseSocialPolicy, type SocialPolicy } from "../src/social-policy.ts";
const policy = parseSocialPolicy({
  window_days: 30,
  accounts: [
    {
      source: "whatsapp_personal",
      provider: "unipile",
      account_id: "personal-one",
      owner_identity: "owner-user",
      owner_verified: true,
      api_base_url: "https://api1.unipile.com:13111",
    },
  ],
}) as SocialPolicy;
const message = () => ({
  id: "message-one",
  account_id: "personal-one",
  chat_id: "thread-one",
  sender_id: "other-user",
  timestamp: "2026-10-13T12:00:00Z",
  is_sender: false,
  text: "I'll send it.",
  attendees: [
    { attendee_provider_id: "owner-user" },
    { attendee_provider_id: "other-user" },
  ],
});
const request = (): SocialSyncRequest => ({
  source: "whatsapp_personal",
  account_id: "personal-one",
  format: "unipile_messages",
  items: [message()],
  cursor: "page-two",
  expected_cursor: null,
  complete: false,
  coverage_start: "2026-09-14T12:00:00.000Z",
  coverage_end: "2026-10-14T12:00:00.000Z",
  reconcile: false,
});
const context: SocialSyncContext = {
  principal_id: "owner",
  now: new Date("2026-10-14T12:00:00Z"),
  authenticated: { provider: "unipile", account_id: "personal-one" },
};
describe("bounded social page normalization", () => {
  it("produces a cursor-checked batch with verified identities", () => {
    const r = normalizeSocialBatch(policy, request(), context);
    expect(r.batch.expected_cursor).toBeNull();
    expect(r.batch.records).toHaveLength(1);
    expect(r.batch.seen_record_ids).toEqual(["message-one"]);
    expect(r.batch.contacts).toHaveLength(1);
    expect(r.batch.complete).toBe(false);
  });
  it("hashes equivalent provider pages identically despite JSON key order", () => {
    const a = normalizeSocialBatch(policy, request(), context);
    const input = request();
    input.items = [Object.fromEntries(Object.entries(message()).reverse())];
    const b = normalizeSocialBatch(policy, input, context);
    expect(a.page_hash).toBe(b.page_hash);
    expect(a.page_hash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("keeps a quarantined page from asserting complete reconciled coverage", () => {
    const r = normalizeSocialBatch(
      policy,
      {
        ...request(),
        items: [{ ...message(), sender_id: "owner-user" }],
        complete: true,
        reconcile: true,
        cursor: null,
      },
      context,
    );
    expect(r.batch.records).toHaveLength(0);
    expect(r.batch.quarantines).toHaveLength(1);
    expect(r.batch.complete).toBe(true);
    expect(r.batch.evidence_incomplete).toBe(true);
    expect(r.batch.reconcile).toBe(false);
  });
  it("completes system-event pagination and removes reclassified message evidence", () => {
    const r = normalizeSocialBatch(
      policy,
      {
        ...request(),
        items: [{ ...message(), is_event: true }],
        complete: true,
        reconcile: true,
        cursor: null,
      },
      context,
    );
    expect(r.batch.records).toEqual([]);
    expect(r.batch.quarantines).toEqual([]);
    expect(r.batch.evidence_incomplete).toBe(false);
    expect(r.batch.complete).toBe(true);
    expect(r.batch.reconcile).toBe(true);
    expect(r.batch.seen_record_ids).toEqual(["message-one"]);
    expect(r.batch.removed_record_ids).toEqual(["message-one"]);
  });
  it("preserves verified deletion targets and invalidations", () => {
    const r = normalizeSocialBatch(
      policy,
      {
        ...request(),
        format: "unipile_webhook",
        items: [
          {
            account_id: "personal-one",
            account_type: "WHATSAPP",
            account_info: { user_id: "owner-user" },
            event: "message_deleted",
            message_id: "message-one",
          },
        ],
      },
      context,
    );
    expect(r.batch.removed_record_ids).toEqual(["message-one"]);
  });
  it.each([
    { account_id: "foreign" },
    { source: "linkedin" },
    { format: "linkedin_changes" },
    { coverage_start: "2026-08-14T12:00:00.000Z" },
    { coverage_end: "2026-10-15T12:00:00.000Z" },
    { expected_cursor: undefined },
    { cursor: 123 },
    { complete: "true" },
    { items: Array.from({ length: 1001 }, message) },
  ])("rejects scope/cursor/shape expansion", (patch) =>
    expect(() =>
      normalizeSocialBatch(
        policy,
        { ...request(), ...patch } as SocialSyncRequest,
        context,
      ),
    ).toThrow(),
  );
  it("resumes a captured window while enforcing current retention", () => {
    const r = normalizeSocialBatch(policy, request(), {
      ...context,
      now: new Date("2026-10-14T12:10:00Z"),
    });
    expect(r.batch.records).toHaveLength(1);
  });
  it("rejects records outside the captured snapshot window even when retained", () => {
    const r = normalizeSocialBatch(
      policy,
      { ...request(), coverage_end: "2026-10-12T12:00:00.000Z" },
      context,
    );
    expect(r.batch.records).toEqual([]);
    expect(r.batch.quarantines?.[0]?.reason).toBe("outside_snapshot_window");
  });
  it("deduplicates identical page records and rejects conflicting duplicates", () => {
    expect(
      normalizeSocialBatch(
        policy,
        { ...request(), items: [message(), message()] },
        context,
      ).batch.records,
    ).toHaveLength(1);
    expect(() =>
      normalizeSocialBatch(
        policy,
        {
          ...request(),
          items: [message(), { ...message(), text: "different" }],
        },
        context,
      ),
    ).toThrow("conflicting social page duplicate");
  });
  it("requires matching authenticated provider response", () =>
    expect(() =>
      normalizeSocialBatch(policy, request(), {
        ...context,
        authenticated: null,
      }),
    ).toThrow());
  it("does not treat an expired record as eligible retained evidence", () => {
    const r = normalizeSocialBatch(
      policy,
      {
        ...request(),
        items: [{ ...message(), timestamp: "2026-08-01T12:00:00Z" }],
      },
      context,
    );
    expect(r.batch.records).toEqual([]);
    expect(r.batch.removed_record_ids).toEqual(["message-one"]);
  });
});

describe("approved Unipile Business synchronization", () => {
  const businessPolicy = {
    window_days: 30,
    accounts: [{ ...policy.accounts[0], source: "whatsapp_business" }],
  };
  it("uses policy-selected Business source across accepted and rejected results", () => {
    const selected = parseSocialPolicy(businessPolicy)!;
    const page = { ...request(), source: "whatsapp_business" as const };
    const accepted = normalizeSocialBatch(selected, page, context);
    expect(accepted.batch.source).toBe("whatsapp_business");
    expect(accepted.batch.records[0]?.source).toBe("whatsapp_business");
    expect(
      normalizeSocialBatch(
        selected,
        { ...page, items: [{ ...message(), deleted: true }] },
        context,
      ).batch.removed_record_ids,
    ).toEqual(["message-one"]);
    expect(
      normalizeSocialBatch(
        selected,
        { ...page, items: [{ ...message(), account_id: "foreign" }] },
        context,
      ).batch.quarantines,
    ).toHaveLength(1);
    expect(() => normalizeSocialBatch(selected, request(), context)).toThrow();
    expect(() =>
      normalizeSocialBatch(
        selected,
        { ...page, format: "meta_webhook" },
        context,
      ),
    ).toThrow();
  });
});

it.each(["whatsapp_personal", "whatsapp_business"] as const)(
  "invalidates retained %s evidence and pending AI when an edited snapshot loses its text",
  (source) => {
    const selected = parseSocialPolicy({
      window_days: 30,
      accounts: [{ ...policy.accounts[0], source }],
    })!;
    const store = new TendStore(":memory:", {
      mode: "live",
      principal: { owner_id: "owner", user_id: "u", chat_id: "c" },
      clock: () => context.now,
    });
    try {
      store.seed(
        [],
        [],
        [
          {
            owner_id: "owner",
            source,
            account_id: "personal-one",
            mode: "live",
            last_success: null,
            status: "partial",
            coverage_start: request().coverage_start,
            coverage_end: request().coverage_end,
            cursor: null,
          },
        ],
      );
      const initial = normalizeSocialBatch(
        selected,
        { ...request(), source },
        context,
      );
      const record = store.commitLiveBatch(initial.batch)[0]!;
      const oldHash = record.content_hash;
      expect(oldHash).toMatch(/^[a-f0-9]{64}$/);
      const candidate = {
        quote: record.body_text,
        action: "send",
        suggested_due: null,
      };
      expect(store.addCandidate(record, candidate).status).toBe("pending");
      const currentContext = {
        ...context,
        original_message_times: store.originalMessageTimes(
          "owner",
          source,
          "personal-one",
        ),
      };
      const changed = normalizeSocialBatch(
        selected,
        {
          ...request(),
          source,
          expected_cursor: "page-two",
          cursor: "page-three",
          items: [
            {
              ...message(),
              edited: 1,
              text: null,
              timestamp: context.now.toISOString(),
            },
          ],
        },
        currentContext,
      );
      expect(changed.invalidated_record_ids).toEqual(["message-one"]);
      expect(changed.batch.removed_record_ids).toEqual(["message-one"]);
      expect(changed.batch.records).toEqual([]);
      store.commitLiveBatch(changed.batch);
      expect(store.interactions("owner")).toEqual([]);
      expect(store.commitments("owner")[0]).toMatchObject({
        status: "invalidated",
        evidence_valid: false,
        quote: "",
        action: "",
        suggested_due: null,
      });
      expect(() => store.addCandidate(record, candidate)).toThrow(
        /unresolved identity|evidence not persisted\/current/,
      );
      const unavailable = normalizeSocialBatch(
        selected,
        { ...request(), source, items: [{ ...message(), text: null }] },
        context,
      );
      expect(unavailable.invalidated_record_ids).toEqual([]);
      expect(unavailable.batch.evidence_incomplete).toBe(true);
      expect(unavailable.batch.quarantines?.[0]?.reason).toBe(
        "provider_text_unavailable",
      );
    } finally {
      store.close();
    }
  },
);

it("normalizes and replays1181LinkedIn URL rows inside the existing node budget", () => {
  const owner = "https://www.linkedin.com/in/fixture-owner/";
  const account = {
    source: "linkedin",
    provider: "linkedin",
    account_id: "urn:li:person:owner",
    owner_identity: "urn:li:person:owner",
    owner_verified: true,
    profile_bindings: [
      {
        profile_url: owner,
        member_urn: "urn:li:person:owner",
        verified_by: "owner",
      },
    ],
  };
  const p = parseSocialPolicy({ window_days: 30, accounts: [account] })!;
  const r: SocialSyncRequest = {
    ...request(),
    source: "linkedin",
    account_id: account.account_id,
    format: "linkedin_snapshot",
    items: Array.from({ length: 1181 }, (_, i) => ({
      "CONVERSATION ID": `thread-${i}`,
      "SENDER PROFILE URL": "https://www.linkedin.com/in/fixture-other/",
      "RECIPIENT PROFILE URLS": owner,
      FROM: "Mira",
      TO: "Owner",
      DATE: "2026-10-13T12:00:00Z",
      CONTENT: "I'll send the report.",
    })),
  };
  const ctx = {
    ...context,
    authenticated: {
      provider: "linkedin" as const,
      account_id: account.account_id,
    },
  };
  const a = normalizeSocialBatch(p, r, ctx),
    b = normalizeSocialBatch(p, r, ctx);
  expect(a.batch.records).toHaveLength(1181);
  expect(a.batch.quarantines).toHaveLength(0);
  const store = new TendStore(":memory:", {
    mode: "live",
    principal: { owner_id: "owner", user_id: "u", chat_id: "c" },
    clock: () => context.now,
  });
  try {
    store.seed(
      [],
      [],
      [
        {
          owner_id: "owner",
          source: "linkedin",
          account_id: account.account_id,
          mode: "live",
          last_success: null,
          status: "partial",
          coverage_start: r.coverage_start,
          coverage_end: r.coverage_end,
          cursor: null,
        },
      ],
    );
    a.batch.operation_hash = a.page_hash;
    b.batch.operation_hash = b.page_hash;
    expect(store.commitLiveBatch(a.batch)).toHaveLength(1181);
    expect(store.commitLiveBatch(b.batch)).toHaveLength(0);
    expect(store.sourceStatus("owner")[0]?.cursor).toBe(r.cursor);
  } finally {
    store.close();
  }

  expect(a.page_hash).toBe(b.page_hash);
  expect(a.batch.records.map((x) => x.source_record_id)).toEqual(
    b.batch.records.map((x) => x.source_record_id),
  );
  expect(() =>
    normalizeSocialBatch(p, { ...r, items: Array(2001).fill({}) }, ctx),
  ).toThrow("invalid social page");
  expect(() =>
    normalizeSocialBatch(
      policy,
      { ...request(), items: Array(1001).fill({}) },
      context,
    ),
  ).toThrow("invalid social page");
  expect(() =>
    normalizeSocialBatch(
      p,
      { ...r, items: [{ extra: Array(20001).fill(0) }] },
      ctx,
    ),
  ).toThrow("social page limit");
});

describe("historical social pages", () => {
  it("requires explicit history capability for old coverage and keeps authenticated provider checks", () => {
    const historical = {
      ...request(),
      coverage_start: "0001-01-01T00:00:00.000Z",
      items: [{ ...message(), timestamp: "2020-01-01T12:00:00Z" }],
    };
    expect(() => normalizeSocialBatch(policy, historical, context)).toThrow();
    const approved = {
      ...policy,
      history: { version: 1, mode: "all_available" } as const,
    };
    expect(
      normalizeSocialBatch(approved, historical, context).batch.records,
    ).toHaveLength(1);
    expect(() =>
      normalizeSocialBatch(
        approved,
        { ...historical, coverage_end: "2027-01-01T12:00:00.000Z" },
        context,
      ),
    ).toThrow();
    expect(() =>
      normalizeSocialBatch(approved, historical, {
        ...context,
        authenticated: { provider: "unipile", account_id: "foreign" },
      }),
    ).toThrow();
  });
});

describe("historical frozen watermark", () => {
  it("defers post-watermark records to incremental ingestion only in the explicit history lane", () => {
    const approved = {
      ...policy,
      history: { version: 1, mode: "all_available" } as const,
    };
    const historical = {
      ...request(),
      coverage_start: "0001-01-01T00:00:00.000Z",
      coverage_end: "2026-10-12T12:00:00.000Z",
    };
    expect(
      normalizeSocialBatch(approved, historical, context).batch
        .evidence_incomplete,
    ).toBe(true);
    const deferred = normalizeSocialBatch(approved, historical, {
      ...context,
      history_watermark: historical.coverage_end,
    });
    expect(deferred.batch.records).toEqual([]);
    expect(deferred.batch.quarantines).toEqual([]);
    expect(deferred.batch.evidence_incomplete).toBe(false);
    expect(() =>
      normalizeSocialBatch(policy, historical, {
        ...context,
        history_watermark: historical.coverage_end,
      }),
    ).toThrow();
    expect(() =>
      normalizeSocialBatch(approved, historical, {
        ...context,
        history_watermark: context.now.toISOString(),
      }),
    ).toThrow();
    expect(
      normalizeSocialBatch(
        approved,
        {
          ...historical,
          items: [{ ...message(), timestamp: "2027-01-01T12:00:00Z" }],
        },
        { ...context, history_watermark: historical.coverage_end },
      ).batch.evidence_incomplete,
    ).toBe(true);
  });
});
