import { DatabaseSync } from "node:sqlite";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { TendStore, type SourceState, type LiveBatch } from "../src/engine.ts";
import type { LiveRecord } from "../src/google-records.ts";
import { PostgresStore, type LockTiming } from "../src/postgres-store.ts";
import { requestPath } from "../src/request-context.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiveServer } from "../src/live-api.ts";
import { InternalAuth, verificationHash } from "../src/internal-auth.ts";
import { exampleLivePolicy } from "../src/live-policy.ts";
import { migrateLiveStore } from "../src/migrate-live-store.ts";
import { postgresTestRuntime } from "./postgres-test-runtime.ts";
import { createPrivateOutreach } from "../src/outreach-service.ts";
import { outreachWindow } from "../src/outreach.ts";
import { normalizeUnipileMessage } from "../src/messaging-records.ts";
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
  it("routes the private bot's outreach commands through the outreach book", async () => {
    const bot = await PostgresStore.open({
      connectionString: runtime.connectionString,
      principal,
      clock,
    });
    try {
      createPrivateOutreach(bot, principal.owner_id, {
        TEND_OUTREACH_DB: ":memory:",
        OUTREACH_ENABLED: "false",
      });
      const say = async (text: string, update: number) =>
        (
          await bot.telegramCommand(
            { ...principal, chat_type: "private", text },
            "outreach-channel",
            update,
          )
        ).reply as Record<string, unknown>;
      expect(Array.isArray((await say("/outreach", 1)).outreach)).toBe(true);
      expect(await say("/approve Onot-an-id 00000000", 2)).toMatchObject({
        outbound_sent: false,
        outreach_error: "unknown outreach item",
      });
      expect((await say("/status", 3)).counts).toBeDefined();
    } finally {
      await bot.close();
    }
  });
  it("approves a real outreach draft through the private bot with /approve ID CODE", async () => {
    // Relies on the promise the first test confirmed (owed by the owner, due 2026-10-15).
    const bot = await PostgresStore.open({
      connectionString: runtime.connectionString,
      principal,
      clock,
    });
    try {
      const outreach = createPrivateOutreach(
        bot,
        principal.owner_id,
        { TEND_OUTREACH_DB: ":memory:", OUTREACH_ENABLED: "false" },
        clock,
      );
      const planned = (await outreach.route(
        "POST",
        "/api/live/outreach/plan",
        {},
      ))!.body as { created: { id: string; reason: string }[] };
      expect(planned.created.map((c) => c.reason)).toEqual(["you_owe_soon"]);
      const id = planned.created[0]!.id;
      const say = async (text: string, update: number) =>
        (
          await bot.telegramCommand(
            { ...principal, chat_type: "private", text },
            "outreach-approve",
            update,
          )
        ).reply as Record<string, unknown>;
      // The template carries a placeholder, so the owner edits before approving.
      const edited = (await say(
        `/edit ${id} Hi Friend, the report is on track.`,
        1,
      )) as { outreach_item: { status: string; text_code: string } };
      expect(edited.outreach_item.status).toBe("pending");
      expect(await say(`/approve ${id} 00000000`, 2)).toMatchObject({
        outreach_error: "draft changed since you saw it",
      });
      expect(
        await say(`/approve ${id} ${edited.outreach_item.text_code}`, 3),
      ).toMatchObject({
        outbound_sent: false,
        outreach_item: {
          id,
          status: "approved",
          draft_text: "Hi Friend, the report is on track.",
        },
      });
    } finally {
      await bot.close();
    }
  });
  it("selects the same extraction candidates in SQL as the SQLite rule", async () => {
    // A separate principal so earlier tests' attempts and candidates do not count.
    const own = {
      owner_id: "ec-owner",
      user_id: "ec-user",
      chat_id: "ec-chat",
    };
    const remap = <T>(value: T): T =>
      JSON.parse(
        JSON.stringify(value).replaceAll(principal.owner_id, own.owner_id),
      ) as T;
    const ecPg = await PostgresStore.open({
      connectionString: runtime.connectionString,
      principal: own,
      clock,
    });
    const ecSqlite = new TendStore(":memory:", {
      mode: "live",
      principal: own,
      clock,
    });
    try {
      const ownerIdentity = {
        owner_id: own.owner_id,
        identity: "owner@example.com",
        contact_id: "OWNER",
      };
      await ecPg.seed([], [ownerIdentity], [remap(state)]);
      ecSqlite.seed([], [ownerIdentity], [remap(state)]);
      const received: LiveRecord = {
        ...record,
        source_record_id: "r-in",
        direction: "received",
        actor_identity: "friend@example.com",
        participant_identities: ["owner@example.com"],
        attribution: "group",
        eligible_for_extraction: false,
        authored_spans: [],
      };
      const page = {
        ...remap(batch([record, received])),
        operation_hash: "e".repeat(64),
      };
      await ecPg.commitLiveBatch(page);
      ecSqlite.commitLiveBatch(page);
      const keys = (rows: { record_key: string }[]) =>
        rows.map((r) => r.record_key).sort();
      const pgAll = keys(await ecPg.extractionCandidates(own.owner_id, null));
      expect(pgAll).toEqual(
        keys(ecSqlite.extractionCandidates(own.owner_id, null)),
      );
      // The eligible authored message is a candidate; the received one is not.
      expect(pgAll).toHaveLength(1);
      const key = pgAll[0]!;
      expect(keys(await ecPg.extractionCandidates(own.owner_id, key))).toEqual(
        keys(ecSqlite.extractionCandidates(own.owner_id, key)),
      );
      const stored = (await ecPg.interactions(own.owner_id)).find(
        (r) => r.record_key === key,
      )!;
      await ecPg.markExtractionAttempt(own.owner_id, key, stored.content_hash);
      ecSqlite.markExtractionAttempt(own.owner_id, key, stored.content_hash);
      // Attempted: gone from the poll, still reachable by key.
      expect(await ecPg.extractionCandidates(own.owner_id, null)).toEqual([]);
      expect(ecSqlite.extractionCandidates(own.owner_id, null)).toEqual([]);
      expect(keys(await ecPg.extractionCandidates(own.owner_id, key))).toEqual([
        key,
      ]);
      expect(keys(ecSqlite.extractionCandidates(own.owner_id, key))).toEqual([
        key,
      ]);
    } finally {
      await ecPg.close();
      ecSqlite.close();
    }
  });
  it("reads the same outreach window in SQL as outreachWindow", async () => {
    const own = {
      owner_id: "ow-owner",
      user_id: "ow-user",
      chat_id: "ow-chat",
    };
    const remap = <T>(value: T): T =>
      JSON.parse(
        JSON.stringify(value).replaceAll(principal.owner_id, own.owner_id),
      ) as T;
    const owPg = await PostgresStore.open({
      connectionString: runtime.connectionString,
      principal: own,
      clock,
    });
    try {
      await owPg.seed(
        [],
        [
          {
            owner_id: own.owner_id,
            identity: "owner@example.com",
            contact_id: "OWNER",
          },
        ],
        [remap(state)],
      );
      const at = (day: number) =>
        new Date(Date.parse("2026-09-15T10:00:00Z") + day * 86400000)
          .toISOString()
          .replace(".000Z", "+00:00");
      const plain = (id: string, day: number, sent: boolean): LiveRecord => ({
        ...record,
        source_record_id: id,
        source_thread_id: "t-" + id,
        occurred_at: at(day),
        body_text: "Fictional note " + id,
        authored_text: "Fictional note " + id,
        authored_spans: [],
        eligible_for_extraction: false,
        ...(sent
          ? {}
          : {
              direction: "received" as const,
              actor_identity: "friend@example.com",
              participant_identities: ["owner@example.com"],
            }),
      });
      // 12 sent messages over four weeks (more than the 10 kept per
      // contact), an old and a recent received one.
      const rows = [
        ...Array.from({ length: 12 }, (_, i) => plain("s" + i, i * 2, true)),
        plain("old-in", 3, false),
        plain("new-in", 27, false),
      ];
      await owPg.commitLiveBatch({
        ...remap(batch(rows)),
        operation_hash: "f".repeat(64),
      });
      const all = await owPg.interactions(own.owner_id);
      expect(all).toHaveLength(rows.length);
      const keyOf = (id: string) =>
        all.find((r) => r.source_record_id === id)!.record_key;
      const keys = [keyOf("old-in")];
      const sorted = (list: { record_key: string }[]) =>
        list.map((r) => r.record_key).sort();
      const fromSql = await owPg.outreachInteractions(
        own.owner_id,
        clock(),
        keys,
      );
      expect(sorted(fromSql)).toEqual(
        sorted(outreachWindow(all, clock(), keys)),
      );
      expect(fromSql.length).toBeLessThan(all.length);
      expect(sorted(fromSql)).toContain(keyOf("old-in"));
      expect(sorted(fromSql)).not.toContain(keyOf("s0"));
      expect(fromSql).toEqual(
        all.filter((r) => fromSql.some((x) => x.record_key === r.record_key)),
      );
    } finally {
      await owPg.close();
    }
  });
  it("cancels an outreach read that would hold the owner lock past its budget, and resets the timeout", async () => {
    type Bounded = {
      run<T>(op: (s: Bounded) => Promise<T>): Promise<T>;
      boundedRecords(sql: string, values: unknown[]): Promise<unknown[]>;
      q(sql: string): Promise<{ statement_timeout: string }[]>;
    };
    const store = pg as unknown as Bounded;
    const started = Date.now();
    await expect(
      store.run((s) =>
        s.boundedRecords(
          "SELECT * FROM live_records WHERE pg_sleep(4) IS NOT NULL",
          [],
        ),
      ),
    ).rejects.toThrow(/statement timeout/);
    expect(Date.now() - started).toBeLessThan(3500);
    // The lock is free again and the budget does not leak into the rest of
    // a caller's transaction.
    const after = await store.run(async (s) => {
      await s.boundedRecords("SELECT * FROM live_records WHERE false", []);
      return (await s.q("SHOW statement_timeout"))[0]!.statement_timeout;
    });
    expect(after).toBe("0");
    expect(Date.now() - started).toBeLessThan(4000);
  });
  it("reports slow owner-lock calls with the API route, wait and hold only", async () => {
    type Store = {
      run<T>(op: (s: Store) => Promise<T>): Promise<T>;
      q(sql: string): Promise<unknown[]>;
    };
    const seen: LockTiming[] = [];
    pg.setLockTiming((t) => seen.push(t));
    const store = pg as unknown as Store;
    try {
      await store.run((s) => s.q("SELECT 1"));
      expect(seen).toEqual([]);
      const holder = requestPath.run("/api/live/outreach/plan", () =>
        store.run((s) => s.q("SELECT pg_sleep(0.7)")),
      );
      await new Promise((r) => setTimeout(r, 100));
      await requestPath.run("/api/live/model-input", () =>
        store.run((s) => s.q("SELECT 1")),
      );
      await holder;
      const byPath = Object.fromEntries(seen.map((t) => [t.path, t]));
      expect(byPath["/api/live/outreach/plan"]!.hold_ms).toBeGreaterThanOrEqual(
        600,
      );
      // The second call waited for the first one's lock and held it briefly.
      expect(byPath["/api/live/model-input"]!.wait_ms).toBeGreaterThanOrEqual(
        400,
      );
      expect(byPath["/api/live/model-input"]!.hold_ms).toBeLessThan(400);
      for (const t of seen)
        expect(Object.keys(t).sort()).toEqual([
          "at",
          "hold_ms",
          "path",
          "wait_ms",
        ]);
    } finally {
      pg.setLockTiming(() => {});
    }
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
  it("invalidates existing promises when unchanged text loses direct attribution", async () => {
    const identity = {
      owner_id: "downgrade-owner",
      user_id: "downgrade-user",
      chat_id: "downgrade-chat",
    };
    const postgres = await PostgresStore.open({
      connectionString: runtime.connectionString,
      principal: identity,
      clock,
    });
    const memory = new TendStore(":memory:", {
      mode: "live",
      principal: identity,
      clock,
    });
    const direct = { ...record, owner_id: identity.owner_id };
    const input = {
      quote: direct.body_text,
      action: "send the report",
      suggested_due: "2026-10-15",
    };
    try {
      for (const store of [postgres, memory]) {
        await store.seed(
          [
            {
              owner_id: identity.owner_id,
              contact_id: "friend",
              name: "Friend",
            },
          ],
          [
            {
              owner_id: identity.owner_id,
              identity: "friend@example.com",
              contact_id: "friend",
            },
            {
              owner_id: identity.owner_id,
              identity: "owner@example.com",
              contact_id: "OWNER",
            },
          ],
          [{ ...state, owner_id: identity.owner_id }],
        );
        const initial = await store.ingest(direct);
        const candidate = await store.addCandidate(direct, input);
        expect(candidate.evidence_valid).toBe(true);
        const unknown = {
          ...direct,
          participant_identities: [],
          contact_ids: [],
          attribution: "unknown" as const,
          eligible_for_extraction: false,
        };
        const retained = await store.ingest(unknown);
        expect(retained.body_text).toBe(initial.body_text);
        expect(retained.content_hash).not.toBe(initial.content_hash);
        expect((await store.commitments(identity.owner_id))[0]).toMatchObject({
          status: "invalidated",
          evidence_valid: false,
          quote: "",
          action: "",
        });
        await expect(
          Promise.resolve().then(() => store.addCandidate(unknown, input)),
        ).rejects.toThrow();
      }
    } finally {
      await postgres.close();
      memory.close();
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

  it.each(["done", "cancelled"] as const)(
    "rejects a re-proposed %s obligation after evidence invalidation with identical parity",
    async (terminal) => {
      const ownerPrincipal = {
        owner_id: `closed-${terminal}`,
        user_id: "closed-user",
        chat_id: "closed-chat",
      };
      const postgres = await PostgresStore.open({
          connectionString: runtime.connectionString,
          principal: ownerPrincipal,
          clock,
        }),
        memory = new TendStore(":memory:", {
          mode: "live",
          principal: ownerPrincipal,
          clock,
        });
      const raw = { ...record, owner_id: ownerPrincipal.owner_id },
        input = {
          quote: raw.body_text,
          action: "send the report",
          suggested_due: "2026-10-15",
        },
        results: string[] = [];
      try {
        for (const store of [postgres, memory]) {
          await store.seed(
            [
              {
                owner_id: ownerPrincipal.owner_id,
                contact_id: "friend",
                name: "Friend",
              },
            ],
            [
              {
                owner_id: ownerPrincipal.owner_id,
                identity: "owner@example.com",
                contact_id: "OWNER",
              },
              {
                owner_id: ownerPrincipal.owner_id,
                identity: "friend@example.com",
                contact_id: "friend",
              },
            ],
            [{ ...state, owner_id: ownerPrincipal.owner_id }],
          );
          await store.ingest(raw);
          const candidate = await store.addCandidate(raw, input),
            auth = {
              ...ownerPrincipal,
              chat_type: "private",
              text: `/confirm ${candidate.commitment_id} 2026-10-15`,
            };
          await store.command(auth);
          await store.command({
            ...auth,
            text: `/${terminal === "done" ? "done" : "cancel"} ${candidate.commitment_id}`,
          });
          await store.ingest({
            ...raw,
            body_text: "Changed closed evidence",
            authored_text: "Changed closed evidence",
            authored_spans: [],
            eligible_for_extraction: false,
          });
          await store.ingest(raw);
          const before = await store.commitments(ownerPrincipal.owner_id);
          expect(before[0]).toMatchObject({
            status: terminal,
            evidence_valid: false,
          });
          let result = "unexpected_success";
          try {
            await store.addCandidate(raw, input);
          } catch (error) {
            result =
              error instanceof Error ? error.message : "unexpected_error";
          }
          results.push(result);
          expect(await store.commitments(ownerPrincipal.owner_id)).toEqual(
            before,
          );
        }
        expect(results).toEqual([
          "invalidated candidate requires external owner review; automatic reinstatement unsupported",
          "invalidated candidate requires external owner review; automatic reinstatement unsupported",
        ]);
      } finally {
        await postgres.close();
        memory.close();
      }
    },
  );

  it("carries evidence gaps across pages without false pruning and restarts completed partial snapshots", async () => {
    const ownerPrincipal = {
        owner_id: "gap-parity",
        user_id: "gap-user",
        chat_id: "gap-chat",
      },
      historical = "2026-10-13T08:00:00Z";
    const postgres = await PostgresStore.open({
        connectionString: runtime.connectionString,
        principal: ownerPrincipal,
        clock,
      }),
      memory = new TendStore(":memory:", {
        mode: "live",
        principal: ownerPrincipal,
        clock,
      });
    const raw = { ...record, owner_id: ownerPrincipal.owner_id },
      states = [];
    try {
      for (const store of [postgres, memory]) {
        await store.seed(
          [
            {
              owner_id: ownerPrincipal.owner_id,
              contact_id: "friend",
              name: "Friend",
            },
          ],
          [
            {
              owner_id: ownerPrincipal.owner_id,
              identity: "owner@example.com",
              contact_id: "OWNER",
            },
            {
              owner_id: ownerPrincipal.owner_id,
              identity: "friend@example.com",
              contact_id: "friend",
            },
          ],
          [
            {
              ...state,
              owner_id: ownerPrincipal.owner_id,
              last_success: historical,
            },
          ],
        );
        await store.ingest(raw);
        const bad: LiveBatch = {
          owner_id: ownerPrincipal.owner_id,
          source: "gmail",
          account_id: state.account_id,
          records: [],
          cursor: "next-gap",
          expected_cursor: null,
          complete: false,
          reconcile: false,
          coverage_start: state.coverage_start,
          coverage_end: state.coverage_end,
          seen_record_ids: ["ambiguous"],
          evidence_incomplete: true,
          quarantines: [
            {
              source_record_id: "ambiguous",
              reason: "unresolved_identity",
              observed_at: now,
            },
          ],
        };
        await store.commitLiveBatch(bad);
        const partial = (await store.sourceStatus(ownerPrincipal.owner_id))[0]!;
        expect(partial).toMatchObject({
          status: "partial",
          cursor: "next-gap",
          evidence_incomplete: true,
          pagination_complete: false,
          last_success: historical,
        });
        expect(
          await store.prepareLiveSnapshot(
            ownerPrincipal.owner_id,
            "gmail",
            state.account_id,
            state.coverage_start,
            state.coverage_end,
          ),
        ).toEqual(partial);
        await store.commitLiveBatch({
          ...bad,
          records: [],
          quarantines: [],
          seen_record_ids: [],
          cursor: null,
          expected_cursor: "next-gap",
          complete: true,
          reconcile: true,
          evidence_incomplete: false,
        });
        const finished = (
          await store.sourceStatus(ownerPrincipal.owner_id)
        )[0]!;
        expect(finished).toMatchObject({
          status: "partial",
          cursor: null,
          evidence_incomplete: true,
          pagination_complete: true,
          last_success: historical,
        });
        expect((await store.counts(ownerPrincipal.owner_id)).interactions).toBe(
          1,
        );
        await store.markLiveSyncError(
          ownerPrincipal.owner_id,
          "gmail",
          state.account_id,
          false,
          null,
          429,
        );
        expect(
          (await store.sourceStatus(ownerPrincipal.owner_id))[0],
        ).toMatchObject({
          status: "stale",
          pagination_complete: true,
          evidence_incomplete: true,
          last_success: historical,
        });
        const restarted = await store.prepareLiveSnapshot(
          ownerPrincipal.owner_id,
          "gmail",
          state.account_id,
          state.coverage_start,
          state.coverage_end,
        );
        expect(restarted).toMatchObject({
          status: "partial",
          cursor: null,
          evidence_incomplete: false,
          pagination_complete: false,
          last_batch_hash: "",
        });
        await store.commitLiveBatch({
          ...bad,
          records: [raw],
          quarantines: [],
          seen_record_ids: [raw.source_record_id],
          cursor: null,
          expected_cursor: null,
          complete: true,
          reconcile: true,
          evidence_incomplete: false,
        });
        expect(
          (await store.sourceStatus(ownerPrincipal.owner_id))[0],
        ).toMatchObject({
          status: "current",
          pagination_complete: true,
          evidence_incomplete: false,
          last_success: new Date(now).toISOString(),
        });
        await store.prepareLiveSnapshot(
          ownerPrincipal.owner_id,
          "gmail",
          state.account_id,
          state.coverage_start,
          state.coverage_end,
        );
        await store.commitLiveBatch({
          ...bad,
          cursor: null,
          complete: true,
          reconcile: true,
        });
        await store.reconnectLiveSource(
          ownerPrincipal.owner_id,
          "gmail",
          state.account_id,
          state.coverage_start,
          state.coverage_end,
        );
        states.push((await store.sourceStatus(ownerPrincipal.owner_id))[0]);
        expect(states.at(-1)).toMatchObject({
          status: "partial",
          pagination_complete: false,
          evidence_incomplete: false,
          cursor: null,
          last_success: null,
        });
        expect((await store.counts(ownerPrincipal.owner_id)).interactions).toBe(
          1,
        );
      }
      expect(states[0]).toEqual(states[1]);
    } finally {
      await postgres.close();
      memory.close();
    }
  });

  it("preserves a quarantined changelog gap across watermark resumes and clean terminal pages", async () => {
    const ownerPrincipal = {
        owner_id: "changelog-gap-parity",
        user_id: "gap-user",
        chat_id: "gap-chat",
      },
      account = "urn:li:person:gap-owner",
      historical = "2026-10-13T08:00:00Z",
      baseline = `li-change:${Date.parse("2026-10-13T09:00:00Z")}`,
      watermark = `li-change:${Date.parse("2026-10-13T09:01:00Z")}`,
      nextWatermark = `li-change:${Date.parse("2026-10-13T09:02:00Z")}`;
    const postgres = await PostgresStore.open({
        connectionString: runtime.connectionString,
        principal: ownerPrincipal,
        clock,
      }),
      memory = new TendStore(":memory:", {
        mode: "live",
        principal: ownerPrincipal,
        clock,
      });
    const raw = {
        ...record,
        owner_id: ownerPrincipal.owner_id,
        source: "linkedin" as const,
        account_id: account,
      },
      states = [];
    try {
      for (const store of [postgres, memory]) {
        await store.seed(
          [
            {
              owner_id: ownerPrincipal.owner_id,
              contact_id: "friend",
              name: "Friend",
            },
          ],
          [
            {
              owner_id: ownerPrincipal.owner_id,
              identity: "owner@example.com",
              contact_id: "OWNER",
            },
            {
              owner_id: ownerPrincipal.owner_id,
              identity: "friend@example.com",
              contact_id: "friend",
            },
          ],
          [
            {
              ...state,
              owner_id: ownerPrincipal.owner_id,
              source: "linkedin",
              account_id: account,
              cursor: baseline,
              last_success: historical,
            },
          ],
        );
        await store.ingest(raw);
        const bad: LiveBatch = {
          owner_id: ownerPrincipal.owner_id,
          source: "linkedin",
          account_id: account,
          records: [],
          cursor: watermark,
          expected_cursor: baseline,
          complete: true,
          reconcile: true,
          coverage_start: state.coverage_start,
          coverage_end: state.coverage_end,
          seen_record_ids: ["bad-change"],
          evidence_incomplete: true,
          quarantines: [
            {
              source_record_id: "bad-change",
              reason: "actor_mismatch",
              observed_at: now,
            },
          ],
        };
        await store.commitLiveBatch(bad);
        const resumed = await store.prepareLiveSnapshot(
          ownerPrincipal.owner_id,
          "linkedin",
          account,
          state.coverage_start,
          state.coverage_end,
          watermark,
        );
        await store.commitLiveBatch({
          ...bad,
          cursor: nextWatermark,
          expected_cursor: watermark,
          evidence_incomplete: false,
          seen_record_ids: [],
          quarantines: [],
        });
        expect((await store.counts(ownerPrincipal.owner_id)).interactions).toBe(
          1,
        );
        expect(resumed).toMatchObject({
          status: "partial",
          cursor: watermark,
          evidence_incomplete: true,
          pagination_complete: false,
          last_success: historical,
        });
        const current = (await store.sourceStatus(ownerPrincipal.owner_id))[0]!;
        states.push(current);
        expect(current).toMatchObject({
          status: "partial",
          cursor: nextWatermark,
          evidence_incomplete: true,
          pagination_complete: true,
          last_success: historical,
        });
      }
      expect(states[0]).toEqual(states[1]);
    } finally {
      await postgres.close();
      memory.close();
    }
  });
  it.each(["whatsapp_personal", "whatsapp_business"] as const)(
    "restarts an active partial %s window without discarding evidence before complete reconciliation",
    async (source) => {
      const ownerPrincipal = {
        owner_id: `same-window-${source}`,
        user_id: "recovery-user",
        chat_id: "recovery-chat",
      };
      const postgres = await PostgresStore.open({
          connectionString: runtime.connectionString,
          principal: ownerPrincipal,
          clock,
        }),
        memory = new TendStore(":memory:", {
          mode: "live",
          principal: ownerPrincipal,
          clock,
        });
      const account = `recovery-${source}`;
      const normalized = Array.from({ length: 6 }, (_, i) => {
        const result = normalizeUnipileMessage(
          {
            id: `retained-${i}`,
            account_id: account,
            chat_id: "recovery-thread",
            sender_id: "15550000001",
            is_sender: 1,
            timestamp: "2026-10-13T10:00:00Z",
            text: record.body_text,
            attendees: [
              { attendee_provider_id: "15550000001" },
              { attendee_provider_id: "999999999@lid" },
            ],
          },
          {
            principal_id: ownerPrincipal.owner_id,
            account_id: account,
            owner_identity: "15550000001",
            now: clock(),
            authenticated: { provider: "unipile", account_id: account },
          },
          source,
        );
        if (result.kind !== "accepted")
          throw new Error("Fictional WhatsApp normalization failed");
        return result;
      });
      const snapshot: SourceState = {
        ...state,
        owner_id: ownerPrincipal.owner_id,
        source,
        account_id: account,
        coverage_start: normalized[0]!.record.coverage_start,
        coverage_end: normalized[0]!.record.coverage_end,
        evidence_incomplete: false,
        pagination_complete: false,
      };
      const records = normalized.map((r) => r.record);
      const legacy: LiveBatch = {
        ...batch(),
        owner_id: ownerPrincipal.owner_id,
        source,
        account_id: account,
        coverage_start: snapshot.coverage_start,
        coverage_end: snapshot.coverage_end,
        records,
        seen_record_ids: records.map((r) => r.source_record_id),
        contacts: normalized[0]!.contacts,
        identities: normalized[0]!.identities,
        cursor: "legacy-twenty-item-cursor",
        evidence_incomplete: false,
      };
      try {
        for (const store of [postgres, memory]) {
          await store.seed([], [], [snapshot]);
          const retained = await store.commitLiveBatch(legacy);
          const candidate = await store.addCandidate(retained[0]!, {
            quote: record.body_text,
            action: "send the report",
            suggested_due: "2026-10-15",
          });
          await store.command({
            ...ownerPrincipal,
            chat_type: "private",
            text: `/confirm ${candidate.commitment_id} 2026-10-15`,
          });
          const before = {
            records: await store.interactions(ownerPrincipal.owner_id),
            contacts: await store.contacts(ownerPrincipal.owner_id),
            obligations: await store.commitments(ownerPrincipal.owner_id),
          };
          const partial = (
            await store.sourceStatus(ownerPrincipal.owner_id)
          )[0]!;
          expect(partial).toMatchObject({
            status: "partial",
            cursor: legacy.cursor,
          });
          expect(
            await store.prepareLiveSnapshot(
              ownerPrincipal.owner_id,
              source,
              account,
              snapshot.coverage_start,
              snapshot.coverage_end,
            ),
          ).toEqual(partial);
          await store.reconnectLiveSource(
            ownerPrincipal.owner_id,
            source,
            account,
            snapshot.coverage_start,
            snapshot.coverage_end,
            true,
          );
          expect({
            records: await store.interactions(ownerPrincipal.owner_id),
            contacts: await store.contacts(ownerPrincipal.owner_id),
            obligations: await store.commitments(ownerPrincipal.owner_id),
          }).toEqual(before);
          expect(
            (await store.sourceStatus(ownerPrincipal.owner_id))[0],
          ).toMatchObject({
            status: "partial",
            cursor: null,
            coverage_start: snapshot.coverage_start,
            coverage_end: snapshot.coverage_end,
            pagination_complete: false,
            evidence_incomplete: false,
          });
          const first: LiveBatch = {
            ...legacy,
            records: records.slice(0, 5),
            seen_record_ids: records.slice(0, 5).map((r) => r.source_record_id),
            expected_cursor: null,
            cursor: "new-five-item-cursor",
          };
          await store.commitLiveBatch(first);
          expect(await store.commitLiveBatch(first)).toEqual([]);
          expect(await store.interactions(ownerPrincipal.owner_id)).toEqual(
            before.records,
          );
          expect(await store.commitments(ownerPrincipal.owner_id)).toEqual(
            before.obligations,
          );
          await expect(
            Promise.resolve().then(() =>
              store.commitLiveBatch({
                ...first,
                expected_cursor: "wrong-cursor",
                cursor: "must-not-advance",
              }),
            ),
          ).rejects.toThrow("stale");
          await store.markLiveSyncError(
            ownerPrincipal.owner_id,
            source,
            account,
            false,
            null,
            599,
          );
          expect(
            (await store.sourceStatus(ownerPrincipal.owner_id))[0],
          ).toMatchObject({
            cursor: "new-five-item-cursor",
            last_error: 599,
            coverage_start: snapshot.coverage_start,
            coverage_end: snapshot.coverage_end,
          });
          expect(await store.interactions(ownerPrincipal.owner_id)).toEqual(
            before.records,
          );
          expect(await store.commitments(ownerPrincipal.owner_id)).toEqual(
            before.obligations,
          );
          await store.commitLiveBatch({
            ...first,
            records: [],
            seen_record_ids: [],
            cursor: null,
            expected_cursor: "new-five-item-cursor",
            complete: true,
            reconcile: true,
          });
          expect(
            (await store.interactions(ownerPrincipal.owner_id))
              .map((r) => r.source_record_id)
              .sort(),
          ).toEqual(
            records
              .slice(0, 5)
              .map((r) => r.source_record_id)
              .sort(),
          );
          expect(await store.commitments(ownerPrincipal.owner_id)).toEqual(
            before.obligations,
          );
          expect(
            (await store.sourceStatus(ownerPrincipal.owner_id))[0],
          ).toMatchObject({
            status: "current",
            cursor: null,
            pagination_complete: true,
            evidence_incomplete: false,
          });
          await store.revokeSource(ownerPrincipal.owner_id, source);
          const revoked = await store.sourceStatus(ownerPrincipal.owner_id);
          await expect(
            Promise.resolve().then(() =>
              store.reconnectLiveSource(
                ownerPrincipal.owner_id,
                source,
                account,
                snapshot.coverage_start,
                snapshot.coverage_end,
                true,
              ),
            ),
          ).rejects.toThrow("source revoked; active connection required");
          expect(await store.sourceStatus(ownerPrincipal.owner_id)).toEqual(
            revoked,
          );
        }
      } finally {
        await postgres.close();
        memory.close();
      }
    },
  );
  it("blocks conditional refresh after revocation without changing explicit manual reconnect", async () => {
    const ownerPrincipal = {
      owner_id: "reconnect-race",
      user_id: "race-user",
      chat_id: "race-chat",
    };
    const postgres = await PostgresStore.open({
        connectionString: runtime.connectionString,
        principal: ownerPrincipal,
        clock,
      }),
      memory = new TendStore(":memory:", {
        mode: "live",
        principal: ownerPrincipal,
        clock,
      });
    try {
      for (const store of [postgres, memory]) {
        await store.seed(
          [],
          [],
          [{ ...state, owner_id: ownerPrincipal.owner_id }],
        );
        const observed = (
          await store.sourceStatus(ownerPrincipal.owner_id)
        )[0]!;
        expect(observed.status).not.toBe("revoked");
        await store.revokeSource(ownerPrincipal.owner_id, "gmail");
        const revoked = await store.sourceStatus(ownerPrincipal.owner_id);
        await expect(
          Promise.resolve().then(() =>
            store.reconnectLiveSource(
              ownerPrincipal.owner_id,
              "gmail",
              state.account_id,
              state.coverage_start,
              state.coverage_end,
              true,
            ),
          ),
        ).rejects.toThrow("source revoked; active connection required");
        expect(await store.sourceStatus(ownerPrincipal.owner_id)).toEqual(
          revoked,
        );
        await store.reconnectLiveSource(
          ownerPrincipal.owner_id,
          "gmail",
          state.account_id,
          state.coverage_start,
          state.coverage_end,
        );
        expect(
          (await store.sourceStatus(ownerPrincipal.owner_id))[0],
        ).toMatchObject({
          status: "partial",
          cursor: null,
          last_success: null,
        });
      }
    } finally {
      await postgres.close();
      memory.close();
    }
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
    page.quarantines = [
      {
        source_record_id: "legacy-unavailable",
        reason: "provider_text_unavailable",
        observed_at: clock().toISOString(),
      },
    ];
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
    const legacyDb = new DatabaseSync(path);
    try {
      legacyDb.exec(
        "ALTER TABLE live_quarantines DROP COLUMN original_reference",
      );
    } finally {
      legacyDb.close();
    }
    try {
      const proof = await migrateLiveStore(
        path,
        { connectionString: runtime.connectionString },
        migrationPrincipal,
      );
      expect(proof.verified).toBe(true);
      expect(proof.counts.interactions).toBe(1);
      expect(proof.counts.live_quarantines).toBe(1);
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
        expect(
          await migrated.historyQuarantines(
            migrationPrincipal.owner_id,
            "gmail",
            st.account_id,
          ),
        ).toMatchObject({
          total: 1,
          items: [
            {
              source_record_id: "legacy-unavailable",
              original_reference: null,
            },
          ],
        });
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
