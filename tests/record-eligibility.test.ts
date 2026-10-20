import { describe, expect, it } from "vitest";
import { eligibleRecords } from "../src/record-eligibility.ts";
import { exampleLivePolicy } from "../src/live-policy.ts";
import type { NormalizedRecord, SourceState } from "../src/engine.ts";
const now = new Date("2026-10-24T12:00:00Z");
const policy = {
  ...exampleLivePolicy,
  history: { version: 1, mode: "all_available" } as const,
};
const record: NormalizedRecord = {
  owner_id: policy.principal_id,
  source: "calendar",
  account_id: "primary",
  source_record_id: "old",
  source_thread_id: "old",
  kind: "meeting",
  direction: "event",
  actor_identity: "mira@example.invalid",
  participant_identities: [],
  occurred_at: "2020-01-01T12:00:00.000Z",
  end_at: "2020-01-01T13:00:00.000Z",
  observed_at: now.toISOString(),
  body_text: "Old meeting",
  evidence_reference:
    "https://calendar.google.com/calendar/u/0/r/eventedit/old",
  ingestion_mode: "live",
  coverage_start: "0001-01-01T00:00:00.000Z",
  coverage_end: now.toISOString(),
  cancelled: false,
  contact_id: "M",
  content_hash: "a".repeat(64),
  record_key: "old",
};
const state: SourceState = {
  owner_id: policy.principal_id,
  source: "calendar",
  account_id: "primary",
  mode: "live",
  last_success: now.toISOString(),
  status: "partial",
  coverage_start: record.coverage_start,
  coverage_end: record.coverage_end,
  cursor: null,
};
describe("historical record eligibility", () => {
  it("keeps past Calendar evidence in history only and retains source revocation", () => {
    expect(
      eligibleRecords(
        [record],
        now,
        policy,
        [state],
        policy.principal_id,
        true,
        "history",
      ),
    ).toEqual([record]);
    expect(
      eligibleRecords(
        [record],
        now,
        policy,
        [state],
        policy.principal_id,
        true,
      ),
    ).toEqual([]);
    expect(
      eligibleRecords(
        [record],
        now,
        exampleLivePolicy,
        [state],
        policy.principal_id,
        true,
        "history",
      ),
    ).toEqual([]);
    expect(
      eligibleRecords(
        [record],
        now,
        policy,
        [{ ...state, status: "revoked" }],
        policy.principal_id,
        true,
        "history",
      ),
    ).toEqual([]);
    expect(
      eligibleRecords(
        [{ ...record, account_id: "foreign" }],
        now,
        policy,
        [state],
        policy.principal_id,
        true,
        "history",
      ),
    ).toEqual([]);
  });
  it("retains old message context only for approved accounts and never future mail", () => {
    const mail = {
      ...record,
      source: "gmail" as const,
      account_id: policy.account_email,
      kind: "message",
      direction: "received" as const,
    };
    const source = {
      ...state,
      source: "gmail" as const,
      account_id: policy.account_email,
    };
    expect(
      eligibleRecords(
        [mail],
        now,
        policy,
        [source],
        policy.principal_id,
        true,
        "history",
      ),
    ).toEqual([mail]);
    expect(
      eligibleRecords(
        [{ ...mail, occurred_at: "2027-01-01T12:00:00.000Z" }],
        now,
        policy,
        [source],
        policy.principal_id,
        true,
        "history",
      ),
    ).toEqual([]);
  });
});
