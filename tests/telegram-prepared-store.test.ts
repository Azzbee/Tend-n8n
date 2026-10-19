import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import {
  TendStore,
  type LiveBatch,
  type AuthCommand,
  telegramAIContactScope,
  telegramAIRecordSet,
} from "../src/engine.ts";
import { PostgresStore } from "../src/postgres-store.ts";
import {
  prepareLiveAI,
  validateLiveAI,
  liveAIDependencies,
} from "../src/live-ai.ts";
import {
  prepareNormalReply,
  type PreparedTelegramRead,
} from "../src/telegram-normal.ts";
import {
  exampleLivePolicy,
  type VerifiedContactGroup,
} from "../src/live-policy.ts";
import { postgresTestRuntime } from "./postgres-test-runtime.ts";

describe("prepared normal-message ledger parity", () => {
  let runtime: Awaited<ReturnType<typeof postgresTestRuntime>>;
  const cleanups: (() => void | Promise<void>)[] = [];
  beforeAll(async () => {
    runtime = await postgresTestRuntime();
  }, 90000);
  afterEach(async () => {
    for (const close of cleanups.splice(0).reverse()) await close();
  });
  afterAll(() => runtime?.close());

  async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "tend-prepared-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const principal = { owner_id: randomUUID(), user_id: "u", chat_id: "c" };
    let now = "2026-10-19T12:00:00Z";
    const clock = () => new Date(now);
    const path = join(dir, "store.sqlite");
    const sqlite = new TendStore(path, { mode: "live", principal, clock });
    cleanups.push(() => sqlite.close());
    const pg = await PostgresStore.open({
      connectionString: runtime.connectionString,
      principal,
      clock,
    });
    cleanups.push(() => pg.close());
    const stores = [sqlite, pg];
    const state = {
      owner_id: principal.owner_id,
      source: "gmail" as const,
      account_id: "owner@example.invalid",
      mode: "live" as const,
      last_success: null,
      status: "partial",
      coverage_start: "2026-09-19T12:00:00Z",
      coverage_end: now,
      cursor: null,
    };
    const text = "I will send the report on 2026-10-20";
    const record = {
      owner_id: principal.owner_id,
      source: "gmail" as const,
      account_id: state.account_id,
      source_record_id: "r",
      source_thread_id: "t",
      kind: "message",
      direction: "received" as const,
      actor_identity: "friend@example.invalid",
      participant_identities: ["friend@example.invalid"],
      occurred_at: "2026-10-18T12:00:00Z",
      observed_at: now,
      body_text: text,
      authored_text: text,
      authored_spans: [{ start: 0, end: text.length, text }],
      evidence_reference: "https://mail.google.com/mail/u/0/#all/r",
      ingestion_mode: "live" as const,
      coverage_start: state.coverage_start,
      coverage_end: now,
      cancelled: false,
      contact_ids: ["friend"],
      attribution: "direct" as const,
      eligible_for_extraction: true,
    };
    const batch: LiveBatch = {
      owner_id: principal.owner_id,
      source: "gmail",
      account_id: state.account_id,
      records: [record],
      cursor: "a",
      expected_cursor: null,
      complete: false,
      reconcile: false,
      coverage_start: state.coverage_start,
      coverage_end: now,
      seen_record_ids: ["r"],
      contacts: [
        { owner_id: principal.owner_id, contact_id: "friend", name: "Friend" },
      ],
      identities: [
        {
          owner_id: principal.owner_id,
          identity: "friend@example.invalid",
          contact_id: "friend",
        },
      ],
    };
    for (const store of stores) {
      await store.seed(
        [],
        [
          {
            owner_id: principal.owner_id,
            identity: state.account_id,
            contact_id: "OWNER",
          },
        ],
        [state],
      );
      await store.commitLiveBatch(batch);
    }
    const auth: AuthCommand = {
      ...principal,
      chat_type: "private",
      text: "Prépare un brouillon pour friend@example.invalid",
    };
    async function prepared(
      store: (typeof stores)[number],
      group?: VerifiedContactGroup,
      scoped = false,
    ): Promise<PreparedTelegramRead> {
      const records = await store.interactions(principal.owner_id);
      const ai = prepareLiveAI({
        owner_id: principal.owner_id,
        contact_id: group?.id ?? "friend",
        purpose: "draft",
        draft_context: {
          now,
          contact_name: "Friend",
          owner_request: "Ask about the report",
          policy: {
            ...exampleLivePolicy,
            principal_id: principal.owner_id,
            account_email: state.account_id,
            verified_owner_emails: [state.account_id],
          },
        },
        records,
        ...(group ? { contact_group: group } : {}),
      });
      const output = {
        items: [{ evidence_id: "E1", quote: text }],
        draft: { text: "Hi Friend, how is the report progressing?" },
      };
      const result = validateLiveAI(ai, output, records, group, clock());
      const value: PreparedTelegramRead = {
        reply: {
          outbound_sent: false,
          ai: result,
          preview: result.draft?.text,
        },
        record_guards: liveAIDependencies(ai),
        state_guard: {
          contacts: await store.contacts(principal.owner_id),
          commitments: await store.commitments(principal.owner_id),
          sources: await store.sourceStatus(principal.owner_id),
        },
        ai_guard: {
          prepared: ai,
          output,
          ...(group ? { current_group: group } : {}),
        },
      };
      if (scoped) {
        const contacts = await store.contacts(principal.owner_id);
        const accounts = (await store.sourceStatus(principal.owner_id)).map(
          ({ source, account_id }) => ({ source, account_id }),
        );
        const recipient = telegramAIContactScope(
          principal.owner_id,
          ai.contact_id,
          group,
          contacts,
        )!;
        value.ai_guard!.freshness = {
          recipient,
          accounts,
          records: telegramAIRecordSet(
            principal.owner_id,
            ai.contact_id,
            group,
            records,
            accounts,
          ),
        };
        delete value.state_guard;
      }
      return value;
    }
    const changed = (cancelled = false): LiveBatch => ({
      ...batch,
      cursor: "b",
      expected_cursor: "a",
      records: [
        {
          ...record,
          cancelled,
          body_text: "Updated source context",
          authored_text: "Updated source context",
          authored_spans: [
            { start: 0, end: 22, text: "Updated source context" },
          ],
        },
      ],
    });
    return {
      stores,
      setClock: (value: string) => {
        now = value;
      },
      sqlite,
      pg,
      principal,
      auth,
      prepared,
      batch,
      record,
      changed,
      path,
      resetClock: () => {
        now = "2026-10-19T12:00:00Z";
      },
      advance: () => {
        now = "2026-11-19T12:00:00Z";
      },
    };
  }
  it("commits one concurrent duplicate, hashes original owner text, and acknowledges normally", async () => {
    const f = await fixture();
    for (const store of f.stores) {
      const p = await f.prepared(store);
      const results = await Promise.all([
        Promise.resolve().then(() =>
          store.commitTelegramReply(f.auth, "normal", 1, p),
        ),
        Promise.resolve().then(() =>
          store.commitTelegramReply(f.auth, "normal", 1, p),
        ),
      ]);
      expect(results.filter((r) => r.accepted)).toHaveLength(1);
      expect(
        await store.pendingTelegramReply(f.principal.owner_id, "normal", 1),
      ).toMatchObject({ reply: { ai: { status: "validated" } } });
      await store.acknowledgeTelegramReply(f.auth, "normal", 1, 99);
      expect(
        await store.pendingTelegramReply(f.principal.owner_id, "normal", 1),
      ).toBeNull();
    }
    const db = new DatabaseSync(f.path, { readOnly: true });
    expect(
      db.prepare("SELECT payload_hash FROM live_telegram_updates").get()
        ?.payload_hash,
    ).toBe(createHash("sha256").update(f.auth.text).digest("hex"));
    db.close();
    const pool = new Pool({ connectionString: runtime.connectionString });
    try {
      expect(
        (
          await pool.query(
            "SELECT payload_hash FROM live_reply_ledger WHERE owner_id=$1",
            [f.principal.owner_id],
          )
        ).rows[0]?.payload_hash,
      ).toBe(createHash("sha256").update(f.auth.text).digest("hex"));
    } finally {
      await pool.end();
    }
  });
  it("enforces private enrolled principal and valid update keys before committing", async () => {
    const f = await fixture();
    for (const store of f.stores) {
      const p = await f.prepared(store);
      for (const override of [
        { user_id: "other" },
        { owner_id: "other" },
        { chat_id: "other" },
        { chat_type: "group" },
      ])
        await expect(
          Promise.resolve().then(() =>
            store.commitTelegramReply(
              { ...f.auth, ...override },
              "normal",
              1,
              p,
            ),
          ),
        ).rejects.toThrow("unauthorized");
      await expect(
        Promise.resolve().then(() =>
          store.commitTelegramReply(f.auth, "bad/channel", 1, p),
        ),
      ).rejects.toThrow("update key");
      expect(await store.telegramDeliveryCounts()).toEqual({
        reply_pending: 0,
        sent: 0,
      });
    }
  });
  for (const scenario of ["edited", "cancelled", "revoked", "expired"] as const)
    it(`scrubs ${scenario} evidence between preparation and commit`, async () => {
      const f = await fixture();
      for (const store of f.stores) {
        f.resetClock();
        const p = await f.prepared(store);
        if (scenario === "revoked")
          await store.revokeSource(f.principal.owner_id, "gmail");
        else if (scenario === "expired") f.advance();
        else await store.commitLiveBatch(f.changed(scenario === "cancelled"));
        const result = await store.commitTelegramReply(f.auth, "normal", 1, p);
        expect(result).toMatchObject({
          accepted: true,
          reply: {
            outbound_sent: false,
            warning: expect.stringContaining("changed"),
          },
        });
        expect(JSON.stringify(result)).not.toContain(f.record.body_text);
        expect(result.reply).not.toHaveProperty("ai");
      }
    });
  it("revalidates exact quotes and verified-group revisions", async () => {
    const f = await fixture();
    const group: VerifiedContactGroup = {
      id: "verified-friend",
      name: "Friend",
      verified_at: "2026-10-18T12:00:00Z",
      proof_kind: "owner_confirmed",
      proof_reference: "owner-reviewed-proof",
      members: [
        {
          contact_id: "friend",
          source: "gmail",
          account_id: f.record.account_id,
          identity: "friend@example.invalid",
        },
      ],
    };
    for (const store of f.stores) {
      const p = await f.prepared(store, group);
      p.ai_guard!.current_group = { ...group, proof_reference: "changed" };
      expect(
        (await store.commitTelegramReply(f.auth, "normal", 1, p)).reply,
      ).not.toHaveProperty("ai");
      const fabricated = await f.prepared(store);
      fabricated.ai_guard!.output = {
        items: [{ evidence_id: "E1", quote: "invented quote" }],
      };
      expect(
        (await store.commitTelegramReply(f.auth, "normal", 2, fabricated))
          .reply,
      ).not.toHaveProperty("ai");
    }
  });
  it("revalidates obligation state and preserves explicit slash mutations", async () => {
    const f = await fixture();
    for (const store of f.stores) {
      const r = (await store.interactions(f.principal.owner_id))[0]!;
      await store.addCandidate(r, {
        quote: f.record.body_text,
        action: "send the report",
        suggested_due: "2026-10-20",
      });
      const p = await f.prepared(store);
      const id = (await store.commitments(f.principal.owner_id))[0]!
        .commitment_id;
      await store.telegramCommand(
        { ...f.auth, text: `/confirm ${id} 2026-10-20` },
        "slash",
        1,
      );
      expect(
        (await store.commitTelegramReply(f.auth, "normal", 1, p)).reply,
      ).not.toHaveProperty("ai");
      expect((await store.commitments(f.principal.owner_id))[0]).toMatchObject({
        status: "confirmed",
        due_date: "2026-10-20",
      });
    }
  });
  it("does not retain an orphan reply for a disconnected request, including one queued on the owner lock", async () => {
    const f = await fixture();
    for (const store of f.stores) {
      const p = await f.prepared(store);
      const aborted = new AbortController();
      aborted.abort(new Error("disconnected"));
      await expect(
        Promise.resolve().then(() =>
          store.commitTelegramReply(f.auth, "normal", 1, p, aborted.signal),
        ),
      ).rejects.toThrow("disconnected");
      expect(await store.telegramDeliveryCounts()).toEqual({
        reply_pending: 0,
        sent: 0,
      });
    }
    const p = await f.prepared(f.pg);
    const pool = new Pool({ connectionString: runtime.connectionString });
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT owner_id FROM live_runtime_principal WHERE owner_id=$1 FOR UPDATE",
        [f.principal.owner_id],
      );
      const controller = new AbortController();
      const pending = f.pg.commitTelegramReply(
        f.auth,
        "normal",
        2,
        p,
        controller.signal,
      );
      const assertion = expect(pending).rejects.toThrow("disconnected");
      controller.abort(new Error("disconnected"));
      await blocker.query("COMMIT");
      await assertion;
      expect(await f.pg.telegramDeliveryCounts()).toEqual({
        reply_pending: 0,
        sent: 0,
      });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await pool.end();
    }
  });
  it("scoped AI accepts unrelated contact changes and sync checkpoints, attaching current coverage", async () => {
    const f = await fixture();
    for (const store of f.stores) {
      const p = await f.prepared(store, undefined, true);
      await store.commitLiveBatch({
        ...f.batch,
        records: [],
        expected_cursor: "a",
        cursor: "b",
        seen_record_ids: [],
      });
      await store.seed(
        [
          {
            owner_id: f.principal.owner_id,
            contact_id: "unrelated",
            name: "Another Person",
          },
        ],
        [],
        [],
      );
      const result = await store.commitTelegramReply(f.auth, "normal", 1, p);
      expect(result.reply?.preview).toBe(
        "Hi Friend, how is the report progressing?",
      );
      expect(result.reply?.coverage).toEqual(
        await store.sourceStatus(f.principal.owner_id),
      );
      expect(result.reply?.coverage).not.toEqual(p.reply.coverage);
    }
  });
  for (const field of ["name", "identity"] as const)
    it(`scoped AI withdraws changed selected ${field} metadata`, async () => {
      const f = await fixture();
      for (const store of f.stores) {
        const p = await f.prepared(store, undefined, true);
        if (store === f.sqlite) {
          const db = new DatabaseSync(f.path);
          if (field === "name")
            db.prepare(
              "UPDATE contacts SET name=? WHERE owner_id=? AND contact_id='friend'",
            ).run("Changed Name", f.principal.owner_id);
          else
            db.prepare(
              "UPDATE identities SET identity=? WHERE owner_id=? AND contact_id='friend'",
            ).run("changed@example.invalid", f.principal.owner_id);
          db.close();
        } else {
          const pool = new Pool({ connectionString: runtime.connectionString });
          try {
            await pool.query(
              field === "name"
                ? "UPDATE live_contacts SET name=$2 WHERE owner_id=$1 AND contact_id='friend'"
                : "UPDATE live_identities SET identity=$2 WHERE owner_id=$1 AND contact_id='friend'",
              [
                f.principal.owner_id,
                field === "name" ? "Changed Name" : "changed@example.invalid",
              ],
            );
          } finally {
            await pool.end();
          }
        }
        expect(
          (await store.commitTelegramReply(f.auth, "normal", 1, p)).reply,
        ).not.toHaveProperty("ai");
      }
    });
  for (const target of [true, false])
    it(`scoped AI ${target ? "withdraws a new target message" : "ignores an unrelated new message"}`, async () => {
      const f = await fixture();
      for (const store of f.stores) {
        const p = await f.prepared(store, undefined, true);
        await store.commitLiveBatch({
          ...f.batch,
          expected_cursor: "a",
          cursor: "b",
          records: [
            {
              ...f.record,
              source_record_id: "new-message",
              actor_identity: target
                ? "friend@example.invalid"
                : "other@example.invalid",
              participant_identities: ["owner@example.invalid"],
              contact_ids: [target ? "friend" : "other"],
            },
          ],
          contacts: [
            {
              owner_id: f.principal.owner_id,
              contact_id: target ? "friend" : "other",
              name: target ? "Friend" : "Other",
            },
          ],
          identities: [
            {
              owner_id: f.principal.owner_id,
              identity: target
                ? "friend@example.invalid"
                : "other@example.invalid",
              contact_id: target ? "friend" : "other",
            },
          ],
        });
        const result = await store.commitTelegramReply(f.auth, "normal", 1, p);
        if (target) expect(result.reply).not.toHaveProperty("ai");
        else
          expect(result.reply?.preview).toBe(
            "Hi Friend, how is the report progressing?",
          );
      }
    });
  it("scoped AI guards all relevant records beyond selected model evidence", async () => {
    const f = await fixture();
    for (const store of f.stores) {
      await store.commitLiveBatch({
        ...f.batch,
        expected_cursor: "a",
        cursor: "b",
        records: Array.from({ length: 8 }, (_, index) => ({
          ...f.record,
          source_record_id: `extra-${index}`,
        })),
      });
      const p = await f.prepared(store, undefined, true);
      const unused = (await store.interactions(f.principal.owner_id)).find(
        (record) =>
          !p.record_guards.some(
            (guard) => guard.record_key === record.record_key,
          ),
      )!;
      expect(unused).toBeDefined();
      await store.commitLiveBatch({
        ...f.batch,
        expected_cursor: "b",
        cursor: "c",
        records: [
          {
            ...f.record,
            source_record_id: unused.source_record_id,
            body_text: "Changed context",
            authored_text: "Changed context",
            authored_spans: [{ start: 0, end: 15, text: "Changed context" }],
          },
        ],
      });
      expect(
        (await store.commitTelegramReply(f.auth, "normal", 1, p)).reply,
      ).not.toHaveProperty("ai");
    }
  });
  for (const scenario of ["edited", "cancelled", "revoked", "expired"] as const)
    it(`scoped AI preserves ${scenario} dependency rejection`, async () => {
      const f = await fixture();
      for (const store of f.stores) {
        f.resetClock();
        const p = await f.prepared(store, undefined, true);
        if (scenario === "revoked")
          await store.revokeSource(f.principal.owner_id, "gmail");
        else if (scenario === "expired") f.advance();
        else await store.commitLiveBatch(f.changed(scenario === "cancelled"));
        expect(
          (await store.commitTelegramReply(f.auth, "normal", 1, p)).reply,
        ).not.toHaveProperty("ai");
      }
    });
  it("scoped AI guards recipient-specific style records as well as citations", async () => {
    const f = await fixture();
    const style = "Hey Friend, could you check this?";
    for (const store of f.stores) {
      await store.commitLiveBatch({
        ...f.batch,
        expected_cursor: "a",
        cursor: "b",
        records: [
          {
            ...f.record,
            source_record_id: "style",
            direction: "sent",
            actor_identity: f.record.account_id,
            participant_identities: ["friend@example.invalid"],
            body_text: style,
            authored_text: style,
            authored_spans: [{ start: 0, end: style.length, text: style }],
          },
        ],
      });
      const p = await f.prepared(store, undefined, true);
      expect(p.ai_guard?.prepared.draft_context?.style_basis).toBe(
        "recipient_examples",
      );
      const styleRecord = (await store.interactions(f.principal.owner_id)).find(
        (record) => record.source_record_id === "style",
      )!;
      expect(
        p.record_guards.some(
          (guard) => guard.record_key === styleRecord.record_key,
        ),
      ).toBe(true);
      const changed = "Hello Friend, please check this.";
      await store.commitLiveBatch({
        ...f.batch,
        expected_cursor: "b",
        cursor: "c",
        records: [
          {
            ...f.record,
            source_record_id: "style",
            direction: "sent",
            actor_identity: f.record.account_id,
            participant_identities: ["friend@example.invalid"],
            body_text: changed,
            authored_text: changed,
            authored_spans: [{ start: 0, end: changed.length, text: changed }],
          },
        ],
      });
      expect(
        (await store.commitTelegramReply(f.auth, "normal", 1, p)).reply,
      ).not.toHaveProperty("ai");
    }
  });
  it("scoped AI withdraws changed or removed verified group proof", async () => {
    const f = await fixture();
    const group: VerifiedContactGroup = {
      id: "verified-friend",
      name: "Friend",
      verified_at: "2026-10-18T12:00:00Z",
      proof_kind: "owner_confirmed",
      proof_reference: "owner-reviewed",
      members: [
        {
          contact_id: "friend",
          source: "gmail",
          account_id: f.record.account_id,
          identity: "friend@example.invalid",
        },
      ],
    };
    for (const store of f.stores) {
      const changed = await f.prepared(store, group, true);
      changed.ai_guard!.current_group = {
        ...group,
        proof_reference: "changed-proof",
      };
      expect(
        (await store.commitTelegramReply(f.auth, "normal", 1, changed)).reply,
      ).not.toHaveProperty("ai");
      const removed = await f.prepared(store, group, true);
      removed.ai_guard!.current_group = null;
      expect(
        (await store.commitTelegramReply(f.auth, "normal", 2, removed)).reply,
      ).not.toHaveProperty("ai");
    }
  });
  it("scoped AI ignores unrelated expired-record cleanup during model time", async () => {
    const f = await fixture();
    for (const store of f.stores) {
      f.resetClock();
      await store.commitLiveBatch({
        ...f.batch,
        expected_cursor: "a",
        cursor: "b",
        records: [
          {
            ...f.record,
            source_record_id: "old-unrelated",
            occurred_at: "2026-09-19T12:00:05Z",
            actor_identity: "other@example.invalid",
            participant_identities: ["owner@example.invalid"],
            contact_ids: ["other"],
          },
        ],
        contacts: [
          {
            owner_id: f.principal.owner_id,
            contact_id: "other",
            name: "Other",
          },
        ],
        identities: [
          {
            owner_id: f.principal.owner_id,
            identity: "other@example.invalid",
            contact_id: "other",
          },
        ],
      });
      const p = await f.prepared(store, undefined, true);
      f.setClock("2026-10-19T12:00:06Z");
      await store.expireLiveEvidence(
        f.principal.owner_id,
        "2026-09-19T12:00:06Z",
        "2026-10-19T12:00:06Z",
        "2026-10-26T12:00:06Z",
      );
      expect(
        (await store.interactions(f.principal.owner_id)).some(
          (record) => record.source_record_id === "old-unrelated",
        ),
      ).toBe(false);
      expect(
        (await store.commitTelegramReply(f.auth, "normal", 1, p)).reply
          ?.preview,
      ).toBe("Hi Friend, how is the report progressing?");
    }
  });
  for (const initial of ["revoked", "missing"] as const)
    it(`scoped AI notices new target evidence when an approved ${initial} account connects during inference`, async () => {
      const f = await fixture();
      for (const store of f.stores) {
        const calendarState = {
          owner_id: f.principal.owner_id,
          source: "calendar" as const,
          account_id: "primary",
          mode: "live" as const,
          last_success: null,
          status: initial === "revoked" ? "revoked" : "partial",
          coverage_start: "2026-10-19T12:00:00Z",
          coverage_end: "2026-10-26T12:00:00Z",
          cursor: null,
        };
        if (initial === "revoked") await store.seed([], [], [calendarState]);
        let calls = 0;
        const prepared = await prepareNormalReply({
          auth: f.auth,
          store,
          clock: () => new Date("2026-10-19T12:00:00Z"),
          policy: { ...exampleLivePolicy, principal_id: f.principal.owner_id },
          model: async () => {
            if (++calls === 1)
              return { intent: "draft_preview", query: "friend" };
            if (initial === "missing")
              await store.seed([], [], [calendarState]);
            await store.reconnectLiveSource(
              f.principal.owner_id,
              "calendar",
              "primary",
              calendarState.coverage_start,
              calendarState.coverage_end,
            );
            const text = "Upcoming project meeting";
            await store.commitLiveBatch({
              ...f.batch,
              source: "calendar",
              account_id: "primary",
              expected_cursor: null,
              cursor: "calendar-next",
              coverage_start: calendarState.coverage_start,
              coverage_end: calendarState.coverage_end,
              records: [
                {
                  ...f.record,
                  source: "calendar",
                  account_id: "primary",
                  source_record_id: "new-target-meeting",
                  kind: "meeting",
                  direction: "event",
                  occurred_at: "2026-10-19T13:00:00Z",
                  end_at: "2026-10-19T14:00:00Z",
                  body_text: text,
                  authored_text: text,
                  authored_spans: [{ start: 0, end: text.length, text }],
                  eligible_for_extraction: false,
                  coverage_start: calendarState.coverage_start,
                  coverage_end: calendarState.coverage_end,
                },
              ],
            });
            return {
              items: [{ evidence_id: "E1", quote: f.record.authored_text }],
              draft: { text: "Hi Friend, how is the report progressing?" },
            };
          },
        });
        expect(calls).toBe(2);
        expect(prepared.ai_guard?.freshness?.accounts).toContainEqual({
          source: "calendar",
          account_id: "primary",
        });
        expect(prepared.reply.preview).toBe(
          "Hi Friend, how is the report progressing?",
        );
        expect(
          (await store.commitTelegramReply(f.auth, "normal", 1, prepared))
            .reply,
        ).not.toHaveProperty("ai");
      }
    });
  it("existing source-change scrubbing clears the entire new reply shape", async () => {
    const f = await fixture();
    for (const store of f.stores) {
      const p = await f.prepared(store);
      await store.commitTelegramReply(f.auth, "normal", 1, p);
      expect(await store.cachedReplyText(f.principal.owner_id)).toContain(
        "Hi Friend, how is the report progressing?",
      );
      await store.commitLiveBatch(f.changed());
      expect(
        await store.pendingTelegramReply(f.principal.owner_id, "normal", 1),
      ).toBeNull();
      expect(await store.cachedReplyText(f.principal.owner_id)).not.toContain(
        "Hi Friend, how is the report progressing?",
      );
    }
  });
});
