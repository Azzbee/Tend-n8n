import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { TendStore, type SourceState, type LiveBatch } from "../src/engine.ts";
import type { LiveRecord } from "../src/google-records.ts";
import { PostgresStore } from "../src/postgres-store.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiveServer } from "../src/live-api.ts";
import { InternalAuth, verificationHash } from "../src/internal-auth.ts";
import { exampleLivePolicy } from "../src/live-policy.ts";
import { migrateLiveStore } from "../src/migrate-live-store.ts";
import { postgresTestRuntime } from "./postgres-test-runtime.ts";
const principal = {
    owner_id: "parity-owner",
    user_id: "parity-user",
    chat_id: "parity-chat",
  },
  now = "2026-10-14T10:00:00Z",
  clock = () => new Date(now);
const state: SourceState = {
  owner_id: principal.owner_id,
  source: "gmail",
  account_id: "owner@example.com",
  mode: "live",
  last_success: null,
  status: "partial",
  coverage_start: "2026-09-14T10:00:00Z",
  coverage_end: now,
  cursor: null,
};
const record: LiveRecord = {
  owner_id: principal.owner_id,
  source: "gmail",
  account_id: state.account_id,
  source_record_id: "r1",
  source_thread_id: "t1",
  kind: "message",
  direction: "sent",
  actor_identity: "owner@example.com",
  participant_identities: ["friend@example.com"],
  occurred_at: "2026-10-13T10:00:00Z",
  observed_at: now,
  body_text: "I will send the report on 2026-10-15",
  evidence_reference: "https://mail.google.com/mail/u/0/#all/r1",
  ingestion_mode: "live",
  coverage_start: state.coverage_start,
  coverage_end: state.coverage_end,
  cancelled: false,
  contact_ids: ["friend"],
  authored_text: "I will send the report on 2026-10-15",
  authored_spans: [
    { start: 0, end: 36, text: "I will send the report on 2026-10-15" },
  ],
  attribution: "direct",
  eligible_for_extraction: true,
};
// Use the literal string length so malformed spans are never hidden by the fixture.
record.authored_spans[0]!.end = record.body_text.length;
const batch = (
  records: LiveRecord[] = [record],
  cursor: string | null = "next",
  expected: string | null = null,
): LiveBatch => ({
  owner_id: principal.owner_id,
  source: "gmail",
  account_id: state.account_id,
  records,
  cursor,
  expected_cursor: expected,
  complete: false,
  reconcile: false,
  coverage_start: state.coverage_start,
  coverage_end: state.coverage_end,
  seen_record_ids: records.map((r) => r.source_record_id),
  contacts: [
    { owner_id: principal.owner_id, contact_id: "friend", name: "Friend" },
  ],
  identities: [
    {
      owner_id: principal.owner_id,
      identity: "friend@example.com",
      contact_id: "friend",
    },
  ],
});
describe("canonical PostgreSQL live parity", () => {
  let runtime: Awaited<ReturnType<typeof postgresTestRuntime>>,
    pg: PostgresStore,
    sqlite: TendStore;
  beforeAll(async () => {
    runtime = await postgresTestRuntime();
    pg = await PostgresStore.open({
      connectionString: runtime.connectionString,
      principal,
      clock,
    });
    sqlite = new TendStore(":memory:", { mode: "live", principal, clock });
    for (const store of [pg, sqlite])
      await store.seed(
        [],
        [
          {
            owner_id: principal.owner_id,
            identity: "owner@example.com",
            contact_id: "OWNER",
          },
        ],
        [state],
      );
  }, 90000);
  afterAll(async () => {
    await pg?.close();
    sqlite?.close();
    runtime?.close();
  });
  it("matches normalized records, candidate transitions, cursors and reply recovery", async () => {
    const initial = { ...batch(), operation_hash: "a".repeat(64) };
    const a = await pg.commitLiveBatch(initial),
      b = sqlite.commitLiveBatch(initial);
    expect(a).toEqual(b);
    const replay = { ...initial, expected_cursor: "obsolete", records: [] };
    expect(await pg.commitLiveBatch(replay)).toEqual([]);
    expect(sqlite.commitLiveBatch(replay)).toEqual([]);
    await expect(
      pg.commitLiveBatch({ ...replay, operation_hash: "b".repeat(64) }),
    ).rejects.toThrow("cursor");
    await expect(
      pg.commitLiveBatch({ ...replay, operation_hash: "invalid" }),
    ).rejects.toThrow("operation hash");
    const candidate = {
      quote: record.body_text,
      action: "send the report",
      suggested_due: "2026-10-15",
    };
    const persisted = (await pg.interactions(principal.owner_id))[0]!;
    expect(await pg.addCandidate(persisted, candidate)).toEqual(
      sqlite.addCandidate(record, candidate),
    );
    const id = (await pg.commitments(principal.owner_id))[0]!.commitment_id;
    const auth = {
      ...principal,
      chat_type: "private",
      text: `/confirm ${id} 2026-10-15`,
    };
    expect(await pg.telegramCommand(auth, "owner-channel", 1)).toEqual(
      sqlite.telegramCommand(auth, "owner-channel", 1),
    );
    expect(
      await pg.pendingTelegramReply(principal.owner_id, "owner-channel", 1),
    ).toEqual(
      sqlite.pendingTelegramReply(principal.owner_id, "owner-channel", 1),
    );
    await pg.acknowledgeTelegramReply(auth, "owner-channel", 1, 9);
    sqlite.acknowledgeTelegramReply(auth, "owner-channel", 1, 9);
    expect(await pg.telegramDeliveryCounts()).toEqual(
      sqlite.telegramDeliveryCounts(),
    );
    expect(await pg.sourceStatus(principal.owner_id)).toEqual(
      sqlite.sourceStatus(principal.owner_id),
    );
  });
  it("serializes concurrent duplicate commands across independent connections", async () => {
    const second = await PostgresStore.open({
      connectionString: runtime.connectionString,
      principal,
      clock,
    });
    try {
      const auth = { ...principal, chat_type: "private", text: "/status" },
        replies = await Promise.all([
          pg.telegramCommand(auth, "owner-channel", 2),
          second.telegramCommand(auth, "owner-channel", 2),
        ]);
      expect(replies.filter((r) => r.accepted)).toHaveLength(1);
      expect(
        await pg.pendingTelegramReply(principal.owner_id, "owner-channel", 2),
      ).not.toBeNull();
    } finally {
      await second.close();
    }
  });
  it("rolls back a mixed invalid page and rejects competing stale cursors", async () => {
    const before = await pg.counts(),
      bad = {
        ...record,
        source_record_id: "bad",
        actor_identity: "unknown@example.com",
      };
    await expect(
      pg.commitLiveBatch(
        batch([{ ...record, source_record_id: "r2" }, bad], "other", "next"),
      ),
    ).rejects.toThrow("identity");
    expect(await pg.counts()).toEqual(before);
    expect((await pg.sourceStatus(principal.owner_id))[0]!.cursor).toBe("next");
    const pages = [
      batch([{ ...record, source_record_id: "r3" }], "a", "next"),
      batch([{ ...record, source_record_id: "r4" }], "b", "next"),
    ];
    const result = await Promise.allSettled(
      pages.map((p) => pg.commitLiveBatch(p)),
    );
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
  it("persists restart state and isolates principals", async () => {
    const reopened = await PostgresStore.open({
      connectionString: runtime.connectionString,
      principal,
      clock,
    });
    try {
      expect(await reopened.interactions(principal.owner_id)).toEqual(
        await pg.interactions(principal.owner_id),
      );
      await expect(reopened.interactions("foreign")).rejects.toThrow(
        "unauthorized",
      );
    } finally {
      await reopened.close();
    }
    await expect(
      PostgresStore.open({
        connectionString: runtime.connectionString,
        principal: { ...principal, user_id: "foreign" },
      }),
    ).rejects.toThrow("principal mismatch");
    const foreign = await PostgresStore.open({
      connectionString: runtime.connectionString,
      principal: { owner_id: "other", user_id: "other", chat_id: "other" },
    });
    try {
      expect(await foreign.counts()).toEqual({
        interactions: 0,
        commitments: 0,
      });
      await expect(foreign.commitLiveBatch(batch())).rejects.toThrow(
        "unauthorized",
      );
    } finally {
      await foreign.close();
    }
  });
  it("invalidates changed evidence and scrubs pending replies atomically", async () => {
    const changed = {
      ...record,
      body_text: "Changed evidence",
      authored_text: "Changed evidence",
      authored_spans: [],
      eligible_for_extraction: false,
    };
    await pg.ingest(changed);
    sqlite.ingest(changed);
    expect((await pg.commitments(principal.owner_id))[0]).toEqual(
      sqlite.commitments(principal.owner_id)[0],
    );
    expect(
      await pg.pendingTelegramReply(principal.owner_id, "owner-channel", 2),
    ).toBeNull();
    await expect(
      pg.command({
        ...principal,
        chat_type: "private",
        text: `/confirm ${(await pg.commitments(principal.owner_id))[0]!.commitment_id} 2026-10-15`,
      }),
    ).rejects.toThrow("invalid transition");
  });

  it("preserves confirmed decisions after evidence edits and permits explicit owner closure", async () => {
    for (const store of [pg, sqlite]) {
      const current = (await store.commitments(principal.owner_id))[0]!;
      expect(current).toMatchObject({
        status: "confirmed",
        due_date: "2026-10-15",
        evidence_valid: false,
        quote: "",
        action: "",
      });
      await store.ingest(record);
      const replay = await store.addCandidate(record, {
        quote: record.body_text,
        action: "send the report",
        suggested_due: "2026-10-15",
      });
      expect(replay).toEqual(current);
      const auth = {
        ...principal,
        chat_type: "private",
        text: `/draft ${current.commitment_id}`,
      };
      await expect(
        Promise.resolve().then(() => store.command(auth)),
      ).rejects.toThrow();
      await expect(
        Promise.resolve().then(() =>
          store.command({
            ...auth,
            text: `/confirm ${current.commitment_id} 2026-10-15`,
          }),
        ),
      ).rejects.toThrow();
      expect(
        await store.command({
          ...auth,
          text: `/done ${current.commitment_id}`,
        }),
      ).toMatchObject({
        status: "done",
        due_date: "2026-10-15",
        evidence_valid: false,
      });
    }
    expect(
      await pg.originalMessageTimes(
        principal.owner_id,
        "gmail",
        state.account_id,
      ),
    ).toMatchObject({ r1: record.occurred_at });
    expect(
      await pg.originalMessageTimes(
        principal.owner_id,
        "gmail",
        "foreign-account",
      ),
    ).toEqual({});
  });
  it("stores multi-contact context with nullable scalar attribution and no personal candidate", async () => {
    const context = {
      ...record,
      source_record_id: "group-context",
      participant_identities: ["friend@example.com", "second@example.com"],
      contact_ids: ["friend", "second"],
      attribution: "group" as const,
      eligible_for_extraction: false,
    };
    for (const store of [pg, sqlite]) {
      await store.seed(
        [
          {
            owner_id: principal.owner_id,
            contact_id: "second",
            name: "Second",
          },
        ],
        [
          {
            owner_id: principal.owner_id,
            identity: "second@example.com",
            contact_id: "second",
          },
        ],
        [],
      );
      const result = await store.ingest(context);
      expect(result.contact_id).toBe("");
      expect(result.contact_ids).toHaveLength(2);
      await expect(
        Promise.resolve().then(() =>
          store.addCandidate(context, {
            quote: context.body_text,
            action: "send the report",
            suggested_due: "2026-10-15",
          }),
        ),
      ).rejects.toThrow("direct authored evidence required");
    }
    expect(
      (await pg.interactions(principal.owner_id)).find(
        (r) => r.source_record_id === "group-context",
      ),
    ).toEqual(
      sqlite
        .interactions(principal.owner_id)
        .find((r) => r.source_record_id === "group-context"),
    );
  });
  it("expires evidence, prunes identities and preserves invalid obligations on revocation", async () => {
    for (const store of [pg, sqlite])
      await store.expireLiveEvidence(
        principal.owner_id,
        "2026-10-14T00:00:00Z",
        "2026-10-14T00:00:00Z",
        "2026-10-21T00:00:00Z",
      );
    expect(await pg.counts()).toEqual(sqlite.counts());
    expect(await pg.contacts(principal.owner_id)).toEqual(
      sqlite.contacts(principal.owner_id),
    );
    expect(await pg.commitments(principal.owner_id)).toEqual(
      sqlite.commitments(principal.owner_id),
    );
    await pg.revokeSource(principal.owner_id, "gmail");
    expect((await pg.sourceStatus(principal.owner_id))[0]!.status).toBe(
      "revoked",
    );
    await expect(pg.commitLiveBatch(batch())).rejects.toThrow(
      "unregistered live account",
    );
    await pg.reconnectLiveSource(
      principal.owner_id,
      "gmail",
      state.account_id,
      state.coverage_start,
      state.coverage_end,
    );
    expect((await pg.sourceStatus(principal.owner_id))[0]).toMatchObject({
      status: "partial",
      cursor: null,
      last_success: null,
    });
  });
  it("streams a read-only checkpoint with counts, hashes, cursor and pending ledger parity", async () => {
    const migrationPrincipal = {
        owner_id: "migration-owner",
        user_id: "m-user",
        chat_id: "m-chat",
      },
      folder = mkdtempSync(join(tmpdir(), "tend-migration-")),
      path = join(folder, "checkpoint.sqlite");
    const old = new TendStore(path, {
      mode: "live",
      principal: migrationPrincipal,
      clock,
    });
    const st = { ...state, owner_id: migrationPrincipal.owner_id },
      r = { ...record, owner_id: migrationPrincipal.owner_id };
    old.seed(
      [],
      [
        {
          owner_id: migrationPrincipal.owner_id,
          identity: "owner@example.com",
          contact_id: "OWNER",
        },
      ],
      [st],
    );
    const page = batch([r]);
    page.owner_id = migrationPrincipal.owner_id;
    page.contacts = page.contacts!.map((c) => ({
      ...c,
      owner_id: migrationPrincipal.owner_id,
    }));
    page.identities = page.identities!.map((i) => ({
      ...i,
      owner_id: migrationPrincipal.owner_id,
    }));
    old.commitLiveBatch(page);
    old.markExtractionAttempt(
      migrationPrincipal.owner_id,
      old.interactions(migrationPrincipal.owner_id)[0]!.record_key,
      old.interactions(migrationPrincipal.owner_id)[0]!.content_hash,
    );
    old.addCandidate(r, {
      quote: r.body_text,
      action: "send the report",
      suggested_due: "2026-10-15",
    });
    old.telegramCommand(
      { ...migrationPrincipal, chat_type: "private", text: "/status" },
      "migration-channel",
      99,
    );
    const expectedRecords = old.interactions(migrationPrincipal.owner_id),
      expectedState = old.sourceStatus(migrationPrincipal.owner_id),
      expectedReply = old.pendingTelegramReply(
        migrationPrincipal.owner_id,
        "migration-channel",
        99,
      );
    old.close();
    try {
      const proof = await migrateLiveStore(
        path,
        { connectionString: runtime.connectionString },
        migrationPrincipal,
      );
      expect(proof.verified).toBe(true);
      expect(proof.counts.interactions).toBe(1);
      expect(proof.hashes.interactions).toMatch(/^[a-f0-9]{64}$/);
      const migrated = await PostgresStore.open({
        connectionString: runtime.connectionString,
        principal: migrationPrincipal,
        clock,
      });
      try {
        expect(
          await migrated.interactions(migrationPrincipal.owner_id),
        ).toEqual(expectedRecords);
        expect(
          await migrated.sourceStatus(migrationPrincipal.owner_id),
        ).toEqual(expectedState);
        expect(
          await migrated.pendingTelegramReply(
            migrationPrincipal.owner_id,
            "migration-channel",
            99,
          ),
        ).toEqual(expectedReply);
        expect(await migrated.extractionAttempted(expectedRecords[0]!)).toBe(
          true,
        );
      } finally {
        await migrated.close();
      }
      await expect(
        migrateLiveStore(
          path,
          { connectionString: runtime.connectionString },
          migrationPrincipal,
        ),
      ).rejects.toThrow("not empty");
      const reread = new TendStore(path, {
        mode: "live",
        principal: migrationPrincipal,
        clock,
      });
      expect(reread.sourceStatus(migrationPrincipal.owner_id)).toEqual(
        expectedState,
      );
      reread.close();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
  it("serves real PostgreSQL-backed HTTP reads and durable owner command acknowledgements", async () => {
    const policy = { ...exampleLivePolicy, principal_id: "http-pg-owner" },
      principal = {
        owner_id: policy.principal_id,
        user_id: "live-owner",
        chat_id: "live-private",
      },
      key = "FICTIONAL_ONLY_0123456789_abcdefghijklmnopqrstuvwxyz_ABCD";
    const store = await PostgresStore.open({
      connectionString: runtime.connectionString,
      principal,
      clock,
    });
    const server = createLiveServer({
      policy,
      store,
      clock,
      auth: new InternalAuth(undefined, verificationHash(key)),
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("listen");
    const base = `http://127.0.0.1:${address.port}`,
      headers = {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      };
    try {
      expect((await fetch(base + "/api/live/status")).status).toBe(401);
      const status = await fetch(base + "/api/live/status", { headers });
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({
        counts: { interactions: 0, commitments: 0 },
      });
      const body = {
        ...principal,
        chat_type: "private",
        text: "/status",
        telegram_channel_id: "http-owner",
        telegram_update_id: 1,
      };
      const command = () =>
        fetch(base + "/api/live/telegram/command", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
      expect(await (await command()).json()).toMatchObject({ accepted: true });
      expect(await (await command()).json()).toEqual({ accepted: false });
      expect(
        await (
          await fetch(
            base +
              "/api/live/telegram/pending-reply?channel_id=http-owner&update_id=1",
            { headers },
          )
        ).json(),
      ).toMatchObject({ available: true, reply: { outbound_sent: false } });
      expect(
        (
          await fetch(base + "/api/live/telegram/ack", {
            method: "POST",
            headers,
            body: JSON.stringify({ ...body, telegram_message_id: 42 }),
          })
        ).status,
      ).toBe(200);
      expect(await store.telegramDeliveryCounts()).toEqual({
        reply_pending: 0,
        sent: 1,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await store.close();
    }
  });
  it("returns retryable failure when async storage initialization fails, without SQLite fallback", async () => {
    const policy = { ...exampleLivePolicy, principal_id: "failed-http-owner" },
      key = "FICTIONAL_ONLY_0123456789_abcdefghijklmnopqrstuvwxyz_ABCD";
    const store = await PostgresStore.open({
      connectionString: runtime.connectionString,
      principal: {
        owner_id: policy.principal_id,
        user_id: "live-owner",
        chat_id: "live-private",
      },
      clock,
    });
    await store.close();
    const server = createLiveServer({
      policy,
      store,
      clock,
      auth: new InternalAuth(undefined, verificationHash(key)),
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("listen");
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/live/status`,
        { headers: { Authorization: "Bearer " + key } },
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "Private storage is not ready; retry later.",
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
