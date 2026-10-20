import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PostgresStore } from "../src/postgres-store.ts";
import type { LiveRecord } from "../src/google-records.ts";
const dir = mkdtempSync(join(tmpdir(), "tend-private-pg-"));
let started = false;
let store: PostgresStore;
const clock = () => new Date("2026-10-20T12:00:00Z"),
  principal = { owner_id: "private-test", user_id: "user", chat_id: "chat" };
beforeAll(async () => {
  execFileSync(
    "initdb",
    [
      "-D",
      join(dir, "data"),
      "-U",
      "private_test",
      "--auth-local=trust",
      "--auth-host=reject",
      "--no-locale",
      "--encoding=UTF8",
    ],
    { stdio: "pipe" },
  );
  execFileSync(
    "pg_ctl",
    [
      "-D",
      join(dir, "data"),
      "-l",
      join(dir, "postgres.log"),
      "-o",
      `-k ${dir} -h '' -p 19588 -F`,
      "-w",
      "start",
    ],
    { stdio: "pipe" },
  );
  started = true;
  store = await PostgresStore.open({
    host: dir,
    port: 19588,
    user: "private_test",
    database: "postgres",
    principal,
    clock,
  });
}, 30000);
afterAll(async () => {
  await store?.close();
  if (started)
    execFileSync(
      "pg_ctl",
      ["-D", join(dir, "data"), "-m", "fast", "-w", "stop"],
      { stdio: "pipe" },
    );
  rmSync(dir, { recursive: true, force: true });
});
describe("private PostgreSQL read parity", () => {
  it("applies owner,contact,source,window,keyword filters with stable paging and no ledger writes", async () => {
    const owner = principal.owner_id;
    await store.seed(
      [
        { owner_id: owner, contact_id: "OWNER", name: "Owner" },
        { owner_id: owner, contact_id: "peer", name: "Peer" },
      ],
      [
        {
          owner_id: owner,
          contact_id: "OWNER",
          identity: "owner@example.invalid",
        },
        {
          owner_id: owner,
          contact_id: "peer",
          identity: "peer@example.invalid",
        },
      ],
      [
        {
          owner_id: owner,
          source: "gmail",
          account_id: "owner@example.invalid",
          mode: "live",
          status: "partial",
          last_success: clock().toISOString(),
          coverage_start: "2026-09-20T12:00:00Z",
          coverage_end: clock().toISOString(),
          cursor: "keep",
        },
      ],
    );
    for (let i = 0; i < 3; i++) {
      const body = "Original text " + i;
      const row: LiveRecord = {
        owner_id: owner,
        source: "gmail",
        account_id: "owner@example.invalid",
        source_record_id: "m" + i,
        source_thread_id: "t",
        kind: "message",
        direction: "received",
        actor_identity: "peer@example.invalid",
        participant_identities: ["owner@example.invalid"],
        occurred_at: "2026-10-20T10:00:00Z",
        observed_at: clock().toISOString(),
        body_text: body,
        evidence_reference: "tend-source:fixture/" + i,
        ingestion_mode: "live",
        coverage_start: "2026-09-20T12:00:00Z",
        coverage_end: clock().toISOString(),
        cancelled: false,
        contact_ids: ["peer"],
        authored_text: body,
        authored_spans: [],
        attribution: "direct",
        eligible_for_extraction: false,
      };
      await store.ingest(row);
    }
    expect(await store.privateContacts(owner, "peer", "", 50)).toHaveLength(1);
    const query = {
      contact_ids: ["peer"],
      accounts: [{ source: "gmail", account_id: "owner@example.invalid" }],
      now: clock().toISOString(),
      message_start: "2026-09-20T12:00:00Z",
      calendar_end: "2026-10-27T12:00:00Z",
      limit: 2,
    };
    const first = await store.privateHistory(owner, query);
    expect(first.total).toBe(3);
    expect(first.records).toHaveLength(2);
    const last = first.records.at(-1)!;
    expect(
      (
        await store.privateHistory(owner, {
          ...query,
          after: { occurred_at: last.occurred_at, record_key: last.record_key },
        })
      ).records,
    ).toHaveLength(1);
    expect(
      (
        await store.privateHistory(owner, {
          ...query,
          contact_ids: [],
          terms: ["text", "2"],
        })
      ).records,
    ).toHaveLength(1);
    expect(
      (await store.privateHistory(owner, { ...query, accounts: [] })).total,
    ).toBe(0);
    await expect(store.privateHistory("other", query)).rejects.toThrow(
      "unauthorized",
    );
    const prepared = {
      reply: { outbound_sent: false as const, normal_message: "Read" },
      record_guards: first.records.map((r) => ({
        record_key: r.record_key,
        content_hash: r.content_hash,
      })),
    };
    const auth = { ...principal, chat_type: "private", text: "read" };
    expect(await store.validatePreparedRead(auth, prepared)).toEqual(
      prepared.reply,
    );
    expect(await store.telegramDeliveryCounts()).toEqual({
      reply_pending: 0,
      sent: 0,
    });
    await store.seed(
      [{ owner_id: owner, contact_id: "other", name: "Other" }],
      [
        {
          owner_id: owner,
          contact_id: "other",
          identity: "other@example.invalid",
        },
      ],
      [
        {
          owner_id: owner,
          source: "calendar",
          account_id: "snapshot",
          mode: "snapshot",
          status: "partial",
          last_success: clock().toISOString(),
          coverage_start: "2026-10-20T00:00:00Z",
          coverage_end: "2026-10-27T00:00:00Z",
          cursor: null,
        },
      ],
    );
    const base = first.records[0]!;
    await store.ingest({
      ...base,
      source_record_id: "wrong",
      actor_identity: "other@example.invalid",
      contact_ids: ["other"],
    });
    for (const id of ["approved", "unapproved"])
      await store.ingest({
        ...base,
        source: "calendar",
        account_id: "snapshot",
        source_record_id: id,
        kind: "meeting",
        direction: "event",
        actor_identity: "owner@example.invalid",
        participant_identities: [
          "owner@example.invalid",
          "peer@example.invalid",
        ],
        occurred_at: "2026-10-21T10:00:00Z",
        end_at: "2026-10-21T11:00:00Z",
        ingestion_mode: "snapshot",
      });
    const grouped = {
      ...query,
      limit: 50,
      contact_ids: ["peer", "other"],
      members: [
        {
          source: "gmail",
          account_id: "owner@example.invalid",
          contact_id: "peer",
        },
        { source: "linkedin", account_id: "different", contact_id: "other" },
      ],
    };
    expect(
      (await store.privateHistory(owner, grouped)).records.map(
        (r) => r.source_record_id,
      ),
    ).not.toContain("wrong");
    const aggregate = (
      await store.privateHistory(owner, {
        ...grouped,
        activity_for: [
          { selector: "peer", contact_ids: ["peer"] },
          {
            selector: "group",
            contact_ids: ["peer", "other"],
            members: grouped.members,
          },
        ],
      })
    ).activity;
    expect(aggregate?.peer).toEqual({
      count: 3,
      last_at: "2026-10-20T10:00:00Z",
      sources: ["gmail"],
    });
    expect(aggregate?.group?.count).toBe(3);
    const snapshots = {
      ...grouped,
      members: [
        { source: "calendar", account_id: "snapshot", contact_id: "peer" },
      ],
      snapshots: [{ calendar_id: "snapshot", event_id: "approved" }],
    };
    expect(
      (await store.privateHistory(owner, snapshots)).records.map(
        (r) => r.source_record_id,
      ),
    ).toEqual(["approved"]);
    expect(
      (
        await store.privateHistory(owner, { ...snapshots, terms: ["Original"] })
      ).records.map((r) => r.source_record_id),
    ).toEqual(["approved"]);
    await store.revokeSource(owner, "gmail");
    expect((await store.privateHistory(owner, query)).total).toBe(0);
    expect(await store.validatePreparedRead(auth, prepared)).not.toEqual(
      prepared.reply,
    );
  });
});
