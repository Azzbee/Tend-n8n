import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TendStore, type RawRecord } from "../src/engine.ts";
import type { LiveRecord } from "../src/google-records.ts";

const principal = {
  owner_id: "test-live-owner",
  user_id: "live-owner",
  chat_id: "live-private",
};
const now = () => new Date("2026-10-14T12:00:00Z");
const auth = { ...principal, chat_type: "private", text: "/status" };
const contacts = [
  { owner_id: principal.owner_id, contact_id: "A1", name: "Same Name" },
  { owner_id: principal.owner_id, contact_id: "A2", name: "Same Name" },
];
const identities = [
  {
    owner_id: principal.owner_id,
    contact_id: "OWNER",
    identity: "owner@example.invalid",
  },
  {
    owner_id: principal.owner_id,
    contact_id: "A1",
    identity: "a@example.invalid",
  },
  {
    owner_id: principal.owner_id,
    contact_id: "A2",
    identity: "b@example.invalid",
  },
];
function raw(id = "m1"): LiveRecord {
  const text = "Hello.\nI will send the notes by 2026-10-15.\nThanks.";
  const authored = "I will send the notes by 2026-10-15.";
  return {
    owner_id: principal.owner_id,
    source: "gmail",
    account_id: "owner@example.invalid",
    source_record_id: id,
    source_thread_id: "thread-1",
    kind: "message",
    direction: "received",
    actor_identity: "a@example.invalid",
    participant_identities: ["owner@example.invalid"],
    occurred_at: "2026-10-14T08:00:00Z",
    observed_at: now().toISOString(),
    body_text: text,
    evidence_reference: "https://mail.google.com/mail/u/0/#all/test-thread",
    ingestion_mode: "live",
    coverage_start: "2026-09-14T12:00:00Z",
    coverage_end: now().toISOString(),
    cancelled: false,
    contact_ids: ["A1"],
    authored_text: text,
    authored_spans: [{ start: 7, end: 7 + authored.length, text: authored }],
    attribution: "direct",
    eligible_for_extraction: true,
  };
}
function makeStore(): TendStore {
  const store = new TendStore(":memory:", {
    mode: "live",
    principal,
    clock: now,
  });
  store.seed(contacts, identities, [
    {
      owner_id: principal.owner_id,
      source: "gmail",
      account_id: "owner@example.invalid",
      mode: "live",
      last_success: null,
      status: "partial",
      coverage_start: raw().coverage_start,
      coverage_end: raw().coverage_end,
      cursor: null,
    },
  ]);
  return store;
}
describe("private live owner store", () => {
  it("scrubs prior candidate text/date when current accepted evidence changes", () => {
    const store = makeStore(),
      record = raw();
    store.ingest(record);
    store.addCandidate(record, {
      quote: record.authored_spans[0]!.text,
      action: "send the notes",
      suggested_due: "2026-10-15",
    });
    store.ingest({
      ...record,
      body_text: "The offer was withdrawn.",
      authored_text: "The offer was withdrawn.",
      authored_spans: [{ start: 0, end: 24, text: "The offer was withdrawn." }],
    });
    expect(store.commitments(principal.owner_id)[0]).toMatchObject({
      status: "invalidated",
      evidence_valid: false,
      quote: "",
      action: "",
      suggested_due: null,
      due_date: null,
    });
    store.close();
  });
  it("refuses fixture diagnostics or another principal on a private database and preserves replay after reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "tend-private-boundary-")),
      path = join(directory, "private.sqlite");
    try {
      const store = new TendStore(path, {
        mode: "live",
        principal,
        clock: now,
      });
      store.seed(contacts, identities, [
        {
          owner_id: principal.owner_id,
          source: "gmail",
          account_id: "owner@example.invalid",
          mode: "live",
          last_success: null,
          status: "partial",
          coverage_start: raw().coverage_start,
          coverage_end: raw().coverage_end,
          cursor: null,
        },
      ]);
      store.ingest(raw());
      expect(
        store.telegramCommand(
          { ...auth, text: "/prep a@example.invalid" },
          "private-test",
          900,
        ).accepted,
      ).toBe(true);
      store.acknowledgeTelegramReply(auth, "private-test", 900, 1);
      expect(store.cachedReplyText(principal.owner_id)).not.toContain(
        "send the notes",
      );
      store.close();
      expect(statSync(path).mode & 0o077).toBe(0);
      expect(() => new TendStore(path)).toThrow("database mode");
      expect(
        () =>
          new TendStore(path, {
            mode: "live",
            principal: { ...principal, owner_id: "another-owner" },
          }),
      ).toThrow("principal");
      const reopened = new TendStore(path, {
        mode: "live",
        principal,
        clock: now,
      });
      expect(reopened.telegramCommand(auth, "private-test", 900).accepted).toBe(
        false,
      );
      expect(reopened.interactions(principal.owner_id)).toHaveLength(1);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("preserves generic local-part case in exact email lookup", () => {
    const store = makeStore();
    store.seed(
      [{ owner_id: principal.owner_id, contact_id: "Upper", name: "Upper" }],
      [
        {
          owner_id: principal.owner_id,
          contact_id: "Upper",
          identity: "A@example.invalid",
        },
      ],
      [],
    );
    expect(
      store.resolveContact(principal.owner_id, "a@EXAMPLE.INVALID").contact_id,
    ).toBe("A1");
    expect(
      store.resolveContact(principal.owner_id, "A@example.invalid").contact_id,
    ).toBe("Upper");
    store.close();
  });
  it("drops orphan contacts after revocation while retaining calendar-backed identities", () => {
    const store = makeStore();
    store.ingest(raw());
    store.seed(
      [],
      [],
      [
        {
          owner_id: principal.owner_id,
          source: "calendar",
          account_id: "primary",
          mode: "live",
          last_success: null,
          status: "partial",
          coverage_start: now().toISOString(),
          coverage_end: "2026-10-21T12:00:00Z",
          cursor: null,
        },
      ],
    );
    store.ingest({
      ...raw("event"),
      source: "calendar",
      account_id: "primary",
      kind: "meeting",
      direction: "event",
      actor_identity: "b@example.invalid",
      occurred_at: "2026-10-15T12:00:00Z",
      end_at: "2026-10-15T13:00:00Z",
      contact_ids: ["A2"],
      authored_text: "",
      authored_spans: [],
      eligible_for_extraction: false,
    });
    store.revokeSource(principal.owner_id, "gmail");
    expect(store.contacts(principal.owner_id).map((x) => x.contact_id)).toEqual(
      ["A2"],
    );
    expect(() =>
      store.resolveContact(principal.owner_id, "a@example.invalid"),
    ).toThrow("unknown");
    store.close();
  });
  it("includes ongoing and all-day events by overlap and expires exact end boundary", () => {
    const store = makeStore();
    store.seed(
      [],
      [],
      [
        {
          owner_id: principal.owner_id,
          source: "calendar",
          account_id: "primary",
          mode: "live",
          last_success: null,
          status: "partial",
          coverage_start: now().toISOString(),
          coverage_end: "2026-10-21T12:00:00Z",
          cursor: null,
        },
      ],
    );
    for (const [id, start, end] of [
      ["ongoing", "2026-10-14T11:00:00Z", "2026-10-14T13:00:00Z"],
      ["all-day", "2026-10-13T22:00:00Z", "2026-10-14T22:00:00Z"],
      ["ended", "2026-10-14T10:00:00Z", "2026-10-14T12:00:00Z"],
    ])
      store.ingest({
        ...raw(id),
        source: "calendar",
        account_id: "primary",
        kind: "meeting",
        direction: "event",
        occurred_at: start!,
        end_at: end!,
        contact_ids: ["A1"],
        authored_text: "",
        authored_spans: [],
        eligible_for_extraction: false,
      });
    expect(store.command({ ...auth, text: "/today" }).meetings).toHaveLength(2);
    store.expireLiveEvidence(
      principal.owner_id,
      "2026-09-14T12:00:00Z",
      now().toISOString(),
      "2026-10-21T12:00:00Z",
    );
    expect(store.interactions(principal.owner_id)).toHaveLength(2);
    store.close();
  });

  it("binds owner queries and resolves email without merging same-name contacts", () => {
    const store = makeStore();
    store.ingest(raw());
    expect(() => store.command({ ...auth, owner_id: "another-owner" })).toThrow(
      "unauthorized",
    );
    expect(
      store.command({ ...auth, text: "/prep a@example.invalid" }).contact,
    ).toHaveProperty("contact_id", "A1");
    expect(
      store.command({ ...auth, text: "/contacts Same" }).contacts,
    ).toHaveLength(2);
    expect(
      store.command({ ...auth, text: "/prep Same Name" }).contacts,
    ).toHaveLength(2);
    store.close();
  });
  it("commits an empty complete sync and does not reconcile missing rows on a partial page", () => {
    const store = makeStore();
    store.ingest(raw());
    store.commitLiveBatch({
      owner_id: principal.owner_id,
      source: "gmail",
      account_id: "owner@example.invalid",
      records: [],
      cursor: "page-2",
      complete: false,
      coverage_start: raw().coverage_start,
      coverage_end: raw().coverage_end,
      reconcile: false,
      seen_record_ids: [],
    });
    expect(store.interactions(principal.owner_id)).toHaveLength(1);
    expect(store.sourceStatus(principal.owner_id)[0]?.cursor).toBe("page-2");
    store.commitLiveBatch({
      owner_id: principal.owner_id,
      source: "gmail",
      account_id: "owner@example.invalid",
      records: [],
      cursor: null,
      complete: true,
      coverage_start: raw().coverage_start,
      coverage_end: raw().coverage_end,
      reconcile: true,
      seen_record_ids: [],
    });
    expect(store.interactions(principal.owner_id)).toHaveLength(0);
    expect(store.sourceStatus(principal.owner_id)[0]?.last_success).toBe(
      now().toISOString(),
    );
    expect(store.sourceStatus(principal.owner_id)[0]?.status).toBe("current");
    store.close();
  });
  it("validates exact authored spans, excludes group promises, and purges replay contents on revocation", () => {
    const store = makeStore();
    const record = raw();
    store.ingest(record);
    const candidate = {
      quote: record.authored_spans[0]!.text,
      action: "send the notes",
      suggested_due: "2026-10-15",
    };
    expect(store.addCandidate(record, candidate).status).toBe("pending");
    const group = {
      ...raw("m2"),
      participant_identities: ["owner@example.invalid", "b@example.invalid"],
      contact_ids: ["A1", "A2"],
      attribution: "group" as const,
      eligible_for_extraction: false,
    };
    store.ingest(group);
    expect(() => store.addCandidate(group, candidate)).toThrow();
    const delivered = store.telegramCommand(
      { ...auth, text: "/prep a@example.invalid" },
      "test-live-channel",
      1,
    );
    expect(delivered.accepted).toBe(true);
    store.revokeSource(principal.owner_id, "gmail");
    expect(store.interactions(principal.owner_id)).toHaveLength(0);
    expect(store.commitments(principal.owner_id)[0]?.quote).toBe("");
    expect(store.cachedReplyText(principal.owner_id)).not.toContain(
      "send the notes",
    );
    expect(store.telegramCommand(auth, "test-live-channel", 1).accepted).toBe(
      false,
    );
    store.close();
  });
  it("uses the injected real clock rather than the fixture week", () => {
    const store = makeStore();
    store.seed(
      [],
      [],
      [
        {
          owner_id: principal.owner_id,
          source: "calendar",
          account_id: "primary",
          mode: "live",
          last_success: null,
          status: "partial",
          coverage_start: now().toISOString(),
          coverage_end: "2026-10-21T12:00:00Z",
          cursor: null,
        },
      ],
    );
    const meeting: RawRecord = {
      ...raw("event"),
      source: "calendar",
      account_id: "primary",
      kind: "meeting",
      direction: "event",
      occurred_at: "2026-10-21T10:00:00Z",
    };
    store.ingest({
      ...meeting,
      end_at: "2026-10-21T11:00:00Z",
      contact_ids: ["A1"],
      authored_text: "",
      authored_spans: [],
      attribution: "direct",
      eligible_for_extraction: false,
    });
    expect(store.command({ ...auth, text: "/today" }).meetings).toHaveLength(1);
    store.close();
  });
});
