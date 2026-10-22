import { requestPath } from "./request-context.ts";
import type {
  PrivateHistoryQuery,
  PrivateHistoryPage,
  PrivateContactActivity,
} from "./private-web-types.ts";
import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow,
} from "pg";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  type AuthCommand,
  type Contact,
  type Identity,
  type SourceState,
  type Source,
  type RawRecord,
  type NormalizedRecord,
  type LiveBatch,
  type Commitment,
  type Reply,
  exactTimestamp,
  isRecord,
  validateLiveCandidate,
  normalizeLiveRecord,
  liveBatchCompletion,
  resetLiveCompleteness,
  validatePreparedTelegramReply,
  initialHistoryCheckpoint,
  advanceHistoryCheckpoint,
  validateDailyBriefingRow,
  validateDailyBriefingTransition,
} from "./engine.ts";
import type { PreparedTelegramRead } from "./telegram-normal.ts";
import type { LiveRecord } from "./google-records.ts";
import { canonicalEmail } from "./google-records.ts";
import {
  calendarWindow,
  exampleLivePolicy,
  type LivePolicy,
  type VerifiedContactGroup,
} from "./live-policy.ts";
import {
  annotateThreads,
  linkThreads,
  onePerThread,
  separateFromThread,
  threadMembers,
  withoutThread,
  type ActionCosine,
  type ThreadOverride,
  type ThreadRow,
  type ThreadedCommitment,
} from "./promise-threads.ts";
import type {
  HistoryCheckpoint,
  HistoryPageCommit,
  HistoryQuarantineReport,
} from "./live-store.ts";
import type { DailyBriefingRow } from "./daily-briefing.ts";
import { eligiblePromiseSpans } from "./authored-promises.ts";
import {
  MEETING_DEFAULT_MS,
  MEETING_FOLLOWUP_MS,
  OUTREACH_READ_BUDGET_MS,
  REPLY_WINDOW_MS,
  STYLE_SOURCE_PER_CONTACT,
} from "./outreach.ts";
import type { LiveStore, Principal } from "./live-store.ts";
export interface PostgresOptions extends PoolConfig {
  principal: Principal;
  clock?: () => Date;
}
const recordColumns = [
  "owner_id",
  "record_key",
  "source",
  "account_id",
  "source_record_id",
  "source_thread_id",
  "kind",
  "direction",
  "actor_identity",
  "participant_identities",
  "occurred_at",
  "observed_at",
  "body_text",
  "evidence_reference",
  "ingestion_mode",
  "coverage_start",
  "coverage_end",
  "cancelled",
  "contact_id",
  "content_hash",
  "contact_ids",
  "authored_text",
  "authored_spans",
  "attribution",
  "eligible_for_extraction",
  "end_at",
  "all_day",
] as const;
const obligationColumns = [
  "owner_id",
  "commitment_id",
  "record_key",
  "contact_id",
  "source",
  "quote",
  "action",
  "suggested_due",
  "direction",
  "status",
  "due_date",
  "evidence_valid",
] as const;
export type CommandExtension = (
  auth: AuthCommand,
  scoped: PostgresStore,
) => Promise<Reply | null>;
export const SLOW_LOCK_MS = 500;
export interface LockTiming {
  at: string;
  path: string;
  wait_ms: number;
  hold_ms: number;
}
export class PostgresStore implements LiveStore {
  private readonly pool: Pool;
  private readonly principal: Principal;
  private readonly clock: () => Date;
  private readonly client: PoolClient | null;
  // Optional handler for commands owned elsewhere (outreach). It receives the
  // transaction-scoped store so its reads stay inside the same transaction.
  private extension: CommandExtension | null = null;
  setCommandExtension(extension: CommandExtension): void {
    this.extension = extension;
  }
  // Calls that waited for or held the owner lock for SLOW_LOCK_MS or more:
  // route and milliseconds only.
  private lockTiming: ((t: LockTiming) => void) | null = null;
  setLockTiming(report: (t: LockTiming) => void): void {
    this.lockTiming = report;
  }
  private constructor(
    pool: Pool,
    principal: Principal,
    clock: () => Date,
    client: PoolClient | null = null,
  ) {
    this.pool = pool;
    this.principal = principal;
    this.clock = clock;
    this.client = client;
  }
  static async open(options: PostgresOptions): Promise<PostgresStore> {
    const { principal, clock, ...config } = options;
    if (
      Object.values(principal).some((x) => typeof x !== "string" || !x.trim())
    )
      throw new Error("private principal required");
    const pool = new Pool(config),
      store = new PostgresStore(pool, principal, clock ?? (() => new Date()));
    try {
      await pool.query(
        readFileSync(
          new URL("../schema/002-live-runtime.sql", import.meta.url),
          "utf8",
        ),
      );
      await pool.query(
        readFileSync(
          new URL("../schema/005-history-and-daily.sql", import.meta.url),
          "utf8",
        ),
      );
      const referenceColumn = await pool.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='live_review_quarantines' AND column_name='original_reference'",
      );
      await pool.query(
        readFileSync(
          new URL("../schema/007-promise-threads.sql", import.meta.url),
          "utf8",
        ),
      );
      if (referenceColumn.rowCount === 0) {
        await pool.query(
          readFileSync(
            new URL(
              "../schema/006-history-quarantine-reference.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
      }
      await pool.query(
        "INSERT INTO live_runtime_principal VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [principal.owner_id, principal.user_id, principal.chat_id],
      );
      const row = (
        await pool.query<{ user_id: string; chat_id: string }>(
          "SELECT user_id,chat_id FROM live_runtime_principal WHERE owner_id=$1",
          [principal.owner_id],
        )
      ).rows[0];
      if (
        !row ||
        row.user_id !== principal.user_id ||
        row.chat_id !== principal.chat_id
      )
        throw new Error("database principal mismatch");
      return store;
    } catch (e) {
      await pool.end();
      throw e;
    }
  }
  async close(): Promise<void> {
    if (this.client) throw new Error("transaction store cannot close pool");
    await this.pool.end();
  }
  private owner(owner: string): void {
    if (owner !== this.principal.owner_id)
      throw new Error("unauthorized owner");
  }
  private async q<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    if (!this.client) throw new Error("transaction required");
    return (await this.client.query<T>(sql, values)).rows;
  }
  private async run<T>(
    operation: (store: PostgresStore) => Promise<T>,
  ): Promise<T> {
    if (this.client) return operation(this);
    const queued = Date.now();
    const client = await this.pool.connect();
    let locked = 0;
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT owner_id FROM live_runtime_principal WHERE owner_id=$1 FOR UPDATE",
        [this.principal.owner_id],
      );
      locked = Date.now();
      const result = await operation(
        Object.assign(
          new PostgresStore(this.pool, this.principal, this.clock, client),
          { extension: this.extension },
        ),
      );
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
      const done = Date.now(),
        wait_ms = (locked || done) - queued,
        hold_ms = locked ? done - locked : 0;
      // A failing reporter must not turn a committed call into an error.
      if (wait_ms + hold_ms >= SLOW_LOCK_MS)
        try {
          this.lockTiming?.({
            at: new Date(done).toISOString(),
            path: requestPath.getStore() ?? "background",
            wait_ms,
            hold_ms,
          });
        } catch {
          /* dropped */
        }
    }
  }
  async seed(
    contacts: Contact[],
    identities: Identity[],
    states: SourceState[],
  ): Promise<void> {
    for (const x of [...contacts, ...identities, ...states])
      this.owner(x.owner_id);
    return this.run(async (s) => {
      for (const c of contacts)
        await s.q(
          "INSERT INTO live_contacts VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [c.owner_id, c.contact_id, c.name],
        );
      for (const i of identities)
        await s.q(
          "INSERT INTO live_identities VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [i.owner_id, i.identity, i.contact_id],
        );
      for (const st of states)
        await s.q(
          "INSERT INTO live_accounts VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [st.owner_id, st.source, st.account_id, JSON.stringify(st)],
        );
    });
  }
  private async identities(owner: string): Promise<Identity[]> {
    this.owner(owner);
    return this.q<Identity & QueryResultRow>(
      "SELECT * FROM live_identities WHERE owner_id=$1",
      [owner],
    );
  }
  async counts(
    owner = this.principal.owner_id,
  ): Promise<{ interactions: number; commitments: number }> {
    this.owner(owner);
    return this.run(async (s) => {
      const r = (
        await s.q<{ interactions: string; commitments: string }>(
          "SELECT (SELECT count(*) FROM live_records WHERE owner_id=$1) interactions,(SELECT count(DISTINCT coalesce(m.thread_id,o.commitment_id)) FROM live_obligations o LEFT JOIN commitment_thread_members m ON m.owner_id=o.owner_id AND m.commitment_id=o.commitment_id WHERE o.owner_id=$1) commitments",
          [owner],
        )
      )[0]!;
      return {
        interactions: Number(r.interactions),
        commitments: Number(r.commitments),
      };
    });
  }
  async telegramDeliveryCounts(): Promise<{
    reply_pending: number;
    sent: number;
  }> {
    return this.run(async (s) => {
      const rows = await s.q<{ status: string; n: string }>(
        "SELECT status,count(*) n FROM live_reply_ledger WHERE owner_id=$1 GROUP BY status",
        [s.principal.owner_id],
      );
      return {
        reply_pending: Number(
          rows.find((x) => x.status === "reply_pending")?.n ?? 0,
        ),
        sent: Number(rows.find((x) => x.status === "sent")?.n ?? 0),
      };
    });
  }
  async sourceStatus(owner: string): Promise<SourceState[]> {
    this.owner(owner);
    return this.run(async (s) =>
      (
        await s.q<{ state: SourceState }>(
          "SELECT state FROM live_accounts WHERE owner_id=$1 ORDER BY source,account_id",
          [owner],
        )
      ).map((x) => x.state),
    );
  }
  private async state(
    owner: string,
    source: Source,
    account: string,
  ): Promise<SourceState> {
    this.owner(owner);
    const row = (
      await this.q<{ state: SourceState }>(
        "SELECT state FROM live_accounts WHERE owner_id=$1 AND source=$2 AND account_id=$3 FOR UPDATE",
        [owner, source, account],
      )
    )[0];
    if (!row) throw new Error("unknown source");
    return row.state;
  }
  private async putState(state: SourceState): Promise<void> {
    await this.q(
      "UPDATE live_accounts SET state=$4 WHERE owner_id=$1 AND source=$2 AND account_id=$3",
      [state.owner_id, state.source, state.account_id, JSON.stringify(state)],
    );
  }
  async originalMessageTimes(
    owner: string,
    source: Source,
    account: string,
  ): Promise<Record<string, string>> {
    this.owner(owner);
    return this.run(async (s) =>
      Object.fromEntries(
        (
          await s.q<{ source_record_id: string; occurred_at: string }>(
            "SELECT source_record_id,occurred_at FROM live_records WHERE owner_id=$1 AND source=$2 AND account_id=$3",
            [owner, source, account],
          )
        ).map((row) => [row.source_record_id, row.occurred_at]),
      ),
    );
  }
  async interactions(owner: string): Promise<NormalizedRecord[]> {
    this.owner(owner);
    return this.run(async (s) =>
      (
        await s.q(
          "SELECT * FROM live_records WHERE owner_id=$1 ORDER BY source,source_record_id",
          [owner],
        )
      ).map((x) => s.record(x)),
    );
  }
  // Outreach reads hold the owner lock like every call here; this bounds how
  // long one can hold it. It runs in a savepoint, so a timeout inside a larger
  // transaction (the Telegram command's) rolls back only this read, and it
  // puts back whatever statement_timeout the caller had.
  private async boundedRecords(
    sql: string,
    values: unknown[],
  ): Promise<NormalizedRecord[]> {
    await this.q("SAVEPOINT bounded_read");
    const previous = (
      await this.q<{ t: string }>(
        "SELECT current_setting('statement_timeout') AS t",
      )
    )[0]!.t;
    try {
      await this.q(`SET LOCAL statement_timeout = ${OUTREACH_READ_BUDGET_MS}`);
      const rows = (await this.q(sql, values)).map((x) => this.record(x));
      await this.q("SELECT set_config('statement_timeout', $1, true)", [
        previous,
      ]);
      await this.q("RELEASE SAVEPOINT bounded_read");
      return rows;
    } catch (error) {
      // Undoes the read and the SET LOCAL; the outer transaction stays usable.
      await this.q("ROLLBACK TO SAVEPOINT bounded_read")
        .then(() => this.q("RELEASE SAVEPOINT bounded_read"))
        .catch(() => {});
      throw error;
    }
  }
  // SQL twin of outreachWindow in outreach.ts; timestamps are validated
  // exact ISO strings on ingest, so the casts cannot fail. The per-contact
  // ranking reads keys only, never message bodies.
  async outreachInteractions(
    owner: string,
    now: Date,
    keys: string[],
  ): Promise<NormalizedRecord[]> {
    this.owner(owner);
    return this.run((s) =>
      s.boundedRecords(
        `WITH sent AS (SELECT record_key FROM (SELECT record_key, row_number() OVER (PARTITION BY contact_id ORDER BY occurred_at::timestamptz DESC, record_key) AS rn FROM live_records WHERE owner_id=$1 AND direction='sent' AND NOT cancelled AND source<>'calendar') ranked WHERE rn<=$5)
SELECT * FROM live_records WHERE owner_id=$1 AND (record_key IN (SELECT record_key FROM sent) OR record_key=ANY($4::text[]) OR occurred_at::timestamptz>=$2::timestamptz OR (source='calendar' AND COALESCE(end_at::timestamptz, occurred_at::timestamptz + interval '${MEETING_DEFAULT_MS} milliseconds')>=$3::timestamptz)) ORDER BY source,source_record_id`,
        [
          owner,
          new Date(now.getTime() - REPLY_WINDOW_MS).toISOString(),
          new Date(now.getTime() - MEETING_FOLLOWUP_MS).toISOString(),
          keys,
          STYLE_SOURCE_PER_CONTACT,
        ],
      ),
    );
  }
  // The records behind open outreach drafts: all that approve, edit, skip,
  // /draft, /gmail-draft and the Desk outreach list need.
  async recordsByKeys(
    owner: string,
    keys: string[],
  ): Promise<NormalizedRecord[]> {
    this.owner(owner);
    if (!keys.length) return [];
    return this.run((s) =>
      s.boundedRecords(
        "SELECT * FROM live_records WHERE owner_id=$1 AND record_key=ANY($2::text[]) ORDER BY source,source_record_id",
        [owner, keys],
      ),
    );
  }
  private record(row: QueryResultRow): NormalizedRecord {
    const out = { ...row };
    if (Array.isArray(row.authored_spans)) {
      out.authored_spans = (
        row.authored_spans as NonNullable<NormalizedRecord["authored_spans"]>
      ).map(({ start, end, text }) => ({ start, end, text }));
    }
    if (out.contact_id === null) out.contact_id = "";
    if (out.end_at === null) delete out.end_at;
    if (out.all_day === null) delete out.all_day;
    return out as unknown as NormalizedRecord;
  }
  private async byKey(
    owner: string,
    key: string,
  ): Promise<NormalizedRecord | undefined> {
    const row = (
      await this.q(
        "SELECT * FROM live_records WHERE owner_id=$1 AND record_key=$2",
        [owner, key],
      )
    )[0];
    return row ? this.record(row) : undefined;
  }
  async ingest(raw: RawRecord | LiveRecord): Promise<NormalizedRecord> {
    this.owner(raw.owner_id);
    return this.run((s) => s.write(raw));
  }
  private async write(
    raw: RawRecord,
    preserveNewer = false,
  ): Promise<NormalizedRecord> {
    const normalized = normalizeLiveRecord(
      raw,
      await this.identities(raw.owner_id),
    );
    const state = await this.state(raw.owner_id, raw.source, raw.account_id);
    if (
      !["live", "snapshot"].includes(state.mode) ||
      !["live", "snapshot"].includes(raw.ingestion_mode) ||
      (state.mode === "snapshot" &&
        (raw.source !== "calendar" || raw.ingestion_mode !== "snapshot")) ||
      (raw.source === "calendar" &&
        (raw.ingestion_mode === "snapshot") !== (state.mode === "snapshot")) ||
      state.status === "revoked"
    )
      throw new Error("unregistered account/mode or source revoked");
    const prior = (
      await this.q(
        "SELECT * FROM live_records WHERE owner_id=$1 AND record_key=$2",
        [raw.owner_id, normalized.record_key],
      )
    )[0];
    if (
      preserveNewer &&
      prior &&
      Date.parse(String(prior.observed_at)) > Date.parse(raw.observed_at)
    )
      return this.record(prior);
    if (prior && prior.content_hash !== normalized.content_hash)
      await this.invalidate(raw.owner_id, normalized.record_key);
    const values = recordColumns.map((k) =>
      k === "authored_spans"
        ? JSON.stringify(normalized.authored_spans ?? [])
        : k === "contact_id" && normalized.contact_id === ""
          ? null
          : (normalized[k] ?? (k === "contact_ids" ? [] : null)),
    );
    await this.q(
      `INSERT INTO live_records(${recordColumns.join(",")}) VALUES(${values.map((_, i) => "$" + (i + 1)).join(",")}) ON CONFLICT(owner_id,record_key) DO UPDATE SET ${recordColumns
        .filter((k) => !["owner_id", "record_key"].includes(k))
        .map((k) => `${k}=EXCLUDED.${k}`)
        .join(",")}`,
      values,
    );
    await this.q(
      "DELETE FROM live_interaction_contacts WHERE owner_id=$1 AND record_key=$2",
      [raw.owner_id, normalized.record_key],
    );
    for (const id of normalized.contact_ids ?? [])
      await this.q("INSERT INTO live_interaction_contacts VALUES($1,$2,$3)", [
        raw.owner_id,
        normalized.record_key,
        id,
      ]);
    return normalized;
  }
  private async invalidate(owner: string, key: string): Promise<void> {
    await this.q(
      "UPDATE live_obligations SET status=CASE WHEN status IN ('confirmed','done','cancelled','dismissed') THEN status ELSE 'invalidated' END,evidence_valid=false,quote='',action='',suggested_due=NULL,due_date=CASE WHEN status='confirmed' THEN due_date ELSE NULL END WHERE owner_id=$1 AND record_key=$2",
      [owner, key],
    );
    await this.scrub(owner);
  }
  private async scrub(owner: string): Promise<void> {
    await this.q(
      "UPDATE live_reply_ledger SET reply_data='{}'::jsonb WHERE owner_id=$1",
      [owner],
    );
  }
  private async remove(
    owner: string,
    source: Source,
    account: string,
    id: string,
  ): Promise<void> {
    const row = (
      await this.q<{ record_key: string }>(
        "SELECT record_key FROM live_records WHERE owner_id=$1 AND source=$2 AND account_id=$3 AND source_record_id=$4",
        [owner, source, account, id],
      )
    )[0];
    if (!row) return;
    await this.invalidate(owner, row.record_key);
    await this.q(
      "DELETE FROM live_records WHERE owner_id=$1 AND record_key=$2",
      [owner, row.record_key],
    );
  }
  private async prune(owner: string): Promise<void> {
    const removed = await this.q<{ contact_id: string }>(
      "DELETE FROM live_contacts c WHERE owner_id=$1 AND NOT EXISTS(SELECT 1 FROM live_interaction_contacts i WHERE i.owner_id=c.owner_id AND i.contact_id=c.contact_id) AND c.contact_id<>'OWNER' RETURNING contact_id",
      [owner],
    );
    if (removed.length) {
      await this.q(
        "DELETE FROM live_identities i WHERE owner_id=$1 AND contact_id<>'OWNER' AND NOT EXISTS(SELECT 1 FROM live_contacts c WHERE c.owner_id=i.owner_id AND c.contact_id=i.contact_id)",
        [owner],
      );
      await this.scrub(owner);
    }
  }
  async commitLiveBatch(batch: LiveBatch): Promise<NormalizedRecord[]> {
    this.owner(batch.owner_id);
    return this.run(async (s) => {
      const state = await s.state(
          batch.owner_id,
          batch.source,
          batch.account_id,
        ),
        hash =
          batch.operation_hash ??
          createHash("sha256").update(JSON.stringify(batch)).digest("hex");
      if (
        batch.operation_hash !== undefined &&
        !/^[a-f0-9]{64}$/.test(batch.operation_hash)
      )
        throw new Error("invalid operation hash");
      if (
        !["live", "snapshot"].includes(state.mode) ||
        state.status === "revoked"
      )
        throw new Error("unregistered live account");
      const completion = liveBatchCompletion(state, batch);
      if (state.last_batch_hash === hash) return [];
      if (
        batch.expected_cursor !== undefined &&
        state.cursor !== batch.expected_cursor
      )
        throw new Error("stale sync cursor");
      if (
        state.status === "current" ||
        state.coverage_start !== batch.coverage_start ||
        state.coverage_end !== batch.coverage_end
      )
        throw new Error("stale sync window");
      if (
        !exactTimestamp(batch.coverage_start) ||
        !exactTimestamp(batch.coverage_end) ||
        Date.parse(batch.coverage_start) > Date.parse(batch.coverage_end)
      )
        throw new Error("invalid coverage");
      if (
        batch.records.some(
          (r) =>
            r.owner_id !== batch.owner_id ||
            r.source !== batch.source ||
            r.account_id !== batch.account_id,
        )
      )
        throw new Error("batch account mismatch");
      await s.seed(batch.contacts ?? [], batch.identities ?? [], []);
      const out: NormalizedRecord[] = [];
      for (const raw of batch.records) {
        const quarantined = (
          await s.q<{ observed_at: string; original_reference: string | null }>(
            "SELECT observed_at,original_reference FROM live_review_quarantines WHERE owner_id=$1 AND source=$2 AND account_id=$3 AND record_id=$4",
            [
              batch.owner_id,
              batch.source,
              batch.account_id,
              raw.source_record_id,
            ],
          )
        )[0];
        if (
          quarantined &&
          Date.parse(quarantined.observed_at) > Date.parse(raw.observed_at)
        )
          continue;
        out.push(await s.write(raw, true));
        if (
          quarantined?.original_reference ===
          `tend-source:${batch.source}/${encodeURIComponent(batch.account_id)}/${encodeURIComponent(raw.source_record_id)}`
        )
          await s.q(
            "INSERT INTO live_history_seen(owner_id,source,account_id,version,record_id) SELECT owner_id,source,account_id,1,$4 FROM live_history_backfills WHERE owner_id=$1 AND source=$2 AND account_id=$3 AND version=1 ON CONFLICT DO NOTHING",
            [
              batch.owner_id,
              batch.source,
              batch.account_id,
              raw.source_record_id,
            ],
          );

        await s.q(
          "DELETE FROM live_review_quarantines WHERE owner_id=$1 AND source=$2 AND account_id=$3 AND record_id=$4 AND observed_at::timestamptz<=$5::timestamptz",
          [
            batch.owner_id,
            batch.source,
            batch.account_id,
            raw.source_record_id,
            raw.observed_at,
          ],
        );
      }
      for (const q of batch.quarantines ?? []) {
        const prior = (
          await s.q<{ observed_at: string }>(
            "SELECT observed_at FROM live_records WHERE owner_id=$1 AND source=$2 AND account_id=$3 AND source_record_id=$4",
            [
              batch.owner_id,
              batch.source,
              batch.account_id,
              q.source_record_id,
            ],
          )
        )[0];
        if (prior && Date.parse(prior.observed_at) > Date.parse(q.observed_at))
          continue;
        await s.remove(
          batch.owner_id,
          batch.source,
          batch.account_id,
          q.source_record_id,
        );
        await s.q(
          "INSERT INTO live_review_quarantines(owner_id,source,account_id,record_id,reason,observed_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_id,source,account_id,record_id) DO UPDATE SET reason=EXCLUDED.reason,observed_at=EXCLUDED.observed_at WHERE EXCLUDED.observed_at::timestamptz>=live_review_quarantines.observed_at::timestamptz",
          [
            batch.owner_id,
            batch.source,
            batch.account_id,
            q.source_record_id,
            q.reason,
            q.observed_at,
          ],
        );
      }
      for (const id of batch.seen_record_ids)
        await s.q(
          "INSERT INTO live_seen VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [batch.owner_id, batch.source, batch.account_id, id],
        );
      for (const id of batch.removed_record_ids ?? []) {
        const review = batch.quarantines?.find(
          (q) => q.source_record_id === id,
        );
        const prior = review
          ? (
              await s.q<{ observed_at: string }>(
                "SELECT observed_at FROM live_records WHERE owner_id=$1 AND source=$2 AND account_id=$3 AND source_record_id=$4",
                [batch.owner_id, batch.source, batch.account_id, id],
              )
            )[0]
          : undefined;
        if (
          review &&
          prior &&
          Date.parse(prior.observed_at) > Date.parse(review.observed_at)
        )
          continue;
        await s.remove(batch.owner_id, batch.source, batch.account_id, id);
      }
      if (completion.complete && batch.reconcile) {
        const missing = await s.q<{ source_record_id: string }>(
          "SELECT source_record_id FROM live_records r WHERE owner_id=$1 AND source=$2 AND account_id=$3 AND ((source='calendar' AND coalesce(end_at,occurred_at)::timestamptz>$4::timestamptz AND occurred_at::timestamptz<$5::timestamptz) OR (source<>'calendar' AND occurred_at::timestamptz>=$4::timestamptz AND occurred_at::timestamptz<=$5::timestamptz)) AND NOT EXISTS(SELECT 1 FROM live_seen v WHERE v.owner_id=r.owner_id AND v.source=r.source AND v.account_id=r.account_id AND v.record_id=r.source_record_id)",
          [
            batch.owner_id,
            batch.source,
            batch.account_id,
            batch.coverage_start,
            batch.coverage_end,
          ],
        );
        for (const r of missing)
          await s.remove(
            batch.owner_id,
            batch.source,
            batch.account_id,
            r.source_record_id,
          );
      }
      if (batch.complete)
        await s.q(
          "DELETE FROM live_seen WHERE owner_id=$1 AND source=$2 AND account_id=$3",
          [batch.owner_id, batch.source, batch.account_id],
        );
      await s.putState({
        ...state,
        cursor: batch.cursor,
        status: completion.complete ? "current" : "partial",
        ...completion.flags,
        last_success: completion.complete
          ? s.clock().toISOString()
          : state.last_success,
        last_batch_hash: hash,
        retry_after_until: null,
        attempt_count: 0,
        last_error: null,
      });
      await s.prune(batch.owner_id);
      return out;
    });
  }
  async prepareLiveSnapshot(
    owner: string,
    source: Source,
    account: string,
    start: string,
    end: string,
    resumeCursor?: string,
  ): Promise<SourceState> {
    this.owner(owner);
    return this.run(async (s) => {
      const state = await s.state(owner, source, account);
      if (state.mode === "snapshot") {
        if (
          source !== "calendar" ||
          state.status === "revoked" ||
          resumeCursor !== undefined ||
          !exactTimestamp(start) ||
          !exactTimestamp(end) ||
          Date.parse(start) >= Date.parse(end)
        )
          throw new Error("invalid manual calendar snapshot window");
        const next = {
          ...state,
          coverage_start: start,
          coverage_end: end,
          cursor: null,
          status: "partial",
          last_success: null,
          evidence_incomplete: true,
          pagination_complete: false,
        };
        await s.putState(next);
        return next;
      }
      if (resumeCursor !== undefined) {
        if (
          source !== "linkedin" ||
          resumeCursor.length > 8192 ||
          !/^li-change:(0|[1-9]\d*)$/.test(resumeCursor) ||
          !Number.isSafeInteger(Number(resumeCursor.slice(10)))
        )
          throw new Error("invalid changelog resume cursor");
        if (state.status === "revoked" || state.mode !== "live")
          throw new Error("source revoked or unavailable");
        if (state.cursor?.startsWith("li-change:")) {
          if (state.cursor !== resumeCursor)
            throw new Error("stale changelog resume cursor");
        } else if (
          state.cursor !== null ||
          !(
            state.status === "current" ||
            (state.status === "partial" && state.pagination_complete === true)
          )
        )
          throw new Error("completed snapshot required before changes");
        if (
          !exactTimestamp(start) ||
          !exactTimestamp(end) ||
          Date.parse(start) >= Date.parse(end)
        )
          throw new Error("invalid changelog window");
      } else if (
        state.status !== "current" &&
        !(state.status !== "revoked" && state.pagination_complete === true)
      )
        return state;
      const next = {
        ...state,
        cursor: resumeCursor ?? null,
        status: "partial",
        coverage_start: start,
        coverage_end: end,
        last_batch_hash: "",
        ...(resumeCursor === undefined
          ? resetLiveCompleteness(state)
          : { pagination_complete: false }),
      };
      await s.q(
        "DELETE FROM live_seen WHERE owner_id=$1 AND source=$2 AND account_id=$3",
        [owner, source, account],
      );
      await s.putState(next);
      return next;
    });
  }
  async reconnectLiveSource(
    owner: string,
    source: Source,
    account: string,
    start: string,
    end: string,
    requireActive = false,
  ): Promise<void> {
    this.owner(owner);
    return this.run(async (s) => {
      const state = await s.state(owner, source, account);
      if (requireActive && state.status === "revoked")
        throw new Error("source revoked; active connection required");
      if (
        !exactTimestamp(start) ||
        !exactTimestamp(end) ||
        Date.parse(start) >= Date.parse(end)
      )
        throw new Error("invalid reconnect window");
      await s.q(
        "DELETE FROM live_seen WHERE owner_id=$1 AND source=$2 AND account_id=$3",
        [owner, source, account],
      );
      await s.putState({
        ...state,
        status: "partial",
        cursor: null,
        last_success: null,
        coverage_start: start,
        coverage_end: end,
        last_batch_hash: "",
        ...resetLiveCompleteness(state),
        retry_after_until: null,
        attempt_count: 0,
        last_error: null,
      });
      await s.scrub(owner);
    });
  }
  async markLiveSyncError(
    owner: string,
    source: Source,
    account: string,
    reconnect: boolean,
    retryAfterUntil: string | null = null,
    statusCode: number | null = null,
  ): Promise<void> {
    this.owner(owner);
    return this.run(async (s) => {
      if (reconnect) return s.revokeSource(owner, source);
      const state = await s.state(owner, source, account);
      if (state.status === "revoked")
        throw new Error("source revoked; explicit reconnect required");
      await s.putState({
        ...state,
        status: "stale",
        retry_after_until: retryAfterUntil,
        attempt_count: (state.attempt_count ?? 0) + 1,
        last_error: statusCode,
      });
    });
  }
  async expireLiveEvidence(
    owner: string,
    messageStart: string,
    calendarStart: string,
    calendarEnd: string,
    socialStart: string = messageStart,
  ): Promise<void> {
    this.owner(owner);
    return this.run(async (s) => {
      const expired = await s.q<{
        source: Source;
        account_id: string;
        source_record_id: string;
      }>(
        "SELECT source,account_id,source_record_id FROM live_records WHERE owner_id=$1 AND ((source<>'calendar' AND occurred_at::timestamptz<CASE WHEN source='gmail' THEN $2::timestamptz ELSE $5::timestamptz END) OR (source='calendar' AND (coalesce(end_at,occurred_at)::timestamptz<=$3::timestamptz OR occurred_at::timestamptz>=$4::timestamptz)))",
        [owner, messageStart, calendarStart, calendarEnd, socialStart],
      );
      for (const r of expired)
        await s.remove(owner, r.source, r.account_id, r.source_record_id);
      await s.q(
        "DELETE FROM live_review_quarantines WHERE owner_id=$1 AND observed_at::timestamptz<CASE WHEN source='gmail' THEN $2::timestamptz ELSE $3::timestamptz END",
        [owner, messageStart, socialStart],
      );
      await s.prune(owner);
    });
  }
  async quarantineCount(owner: string): Promise<number> {
    this.owner(owner);
    return this.run(async (s) =>
      Number(
        (
          await s.q<{ n: string }>(
            "SELECT count(*) n FROM live_review_quarantines WHERE owner_id=$1",
            [owner],
          )
        )[0]!.n,
      ),
    );
  }
  async cachedReplyText(owner: string): Promise<string> {
    this.owner(owner);
    return this.run(async (s) =>
      (
        await s.q<{ reply_data: unknown }>(
          "SELECT reply_data FROM live_reply_ledger WHERE owner_id=$1 ORDER BY channel_id,update_id",
          [owner],
        )
      )
        .map((x) => JSON.stringify(x.reply_data))
        .join("\n"),
    );
  }
  async validatePreparedRead(
    auth: AuthCommand,
    prepared: PreparedTelegramRead,
    policy?: LivePolicy,
  ): Promise<Reply> {
    this.authorize(auth);
    return this.run(async (s) =>
      validatePreparedTelegramReply(
        auth.owner_id,
        prepared,
        await s.interactions(auth.owner_id),
        await s.contacts(auth.owner_id),
        await s.commitments(auth.owner_id),
        await s.sourceStatus(auth.owner_id),
        s.clock(),
        policy,
      ),
    );
  }
  async historyResourceUsage(
    owner: string,
  ): Promise<{ db_bytes: number; index_bytes: number }> {
    this.owner(owner);
    return this.run(async (s) => {
      const row = (
        await s.q<{ db_bytes: string; index_bytes: string }>(
          "SELECT pg_database_size(current_database())::text db_bytes,coalesce((SELECT sum(pg_total_relation_size(c.oid)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'live_semantic_%' AND c.relkind='r'),0)::text index_bytes",
        )
      )[0]!;
      return {
        db_bytes: Number(row.db_bytes),
        index_bytes: Number(row.index_bytes),
      };
    });
  }
  async historyBackfills(owner: string): Promise<HistoryCheckpoint[]> {
    this.owner(owner);
    return this.run(async (s) =>
      (
        await s.q<{
          data: HistoryCheckpoint;
          quarantined_count: string;
          record_count: string;
          oldest_at: string | null;
          newest_at: string | null;
        }>(
          "SELECT b.data,(SELECT count(*)::text FROM live_review_quarantines q WHERE q.owner_id=b.owner_id AND q.source=b.source AND q.account_id=b.account_id) quarantined_count,count(r.record_key)::text record_count,min(r.occurred_at::timestamptz)::text oldest_at,max(r.occurred_at::timestamptz)::text newest_at FROM live_history_backfills b LEFT JOIN live_history_seen h ON h.owner_id=b.owner_id AND h.source=b.source AND h.account_id=b.account_id AND h.version=b.version LEFT JOIN live_records r ON r.owner_id=h.owner_id AND r.source=h.source AND r.account_id=h.account_id AND r.source_record_id=h.record_id WHERE b.owner_id=$1 GROUP BY b.owner_id,b.source,b.account_id,b.version ORDER BY b.source,b.account_id",
          [owner],
        )
      ).map((r) => ({
        ...r.data,
        quarantined_count: Number(r.quarantined_count),
        record_count: Number(r.record_count),
        oldest_at:
          r.oldest_at === null ? null : new Date(r.oldest_at).toISOString(),
        newest_at:
          r.newest_at === null ? null : new Date(r.newest_at).toISOString(),
      })),
    );
  }
  async historyQuarantines(
    owner: string,
    source: Source,
    account: string,
    limit = 25,
  ): Promise<HistoryQuarantineReport> {
    this.owner(owner);
    return this.run(async (s) => {
      const state = (await s.sourceStatus(owner)).find(
        (row) => row.source === source && row.account_id === account,
      );
      if (
        !state ||
        state.mode !== "live" ||
        state.status === "revoked" ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw new Error("invalid history quarantine scope or limit");
      const total = Number(
        (
          await s.q<{ n: string }>(
            "SELECT count(*)::text n FROM live_review_quarantines WHERE owner_id=$1 AND source=$2 AND account_id=$3",
            [owner, source, account],
          )
        )[0]?.n ?? 0,
      );
      const reasons = await s.q<{ reason: string; n: string }>(
        "SELECT reason,count(*)::text n FROM live_review_quarantines WHERE owner_id=$1 AND source=$2 AND account_id=$3 GROUP BY reason ORDER BY count(*) DESC,reason LIMIT 51",
        [owner, source, account],
      );
      const rows = await s.q<{
        record_id: string;
        reason: string;
        observed_at: string;
        original_reference: string | null;
      }>(
        "SELECT record_id,reason,observed_at,original_reference FROM live_review_quarantines WHERE owner_id=$1 AND source=$2 AND account_id=$3 ORDER BY observed_at::timestamptz DESC,record_id LIMIT $4",
        [owner, source, account, limit],
      );
      return {
        total,
        reason_counts: reasons
          .slice(0, 50)
          .map((r) => ({ reason: r.reason, count: Number(r.n) })),
        reason_counts_truncated: reasons.length > 50,
        items: rows.map((r) => ({
          source_record_id: r.record_id,
          reason: r.reason,
          observed_at: r.observed_at,
          original_reference: r.original_reference,
        })),
      };
    });
  }
  async claimHistoryPoll(
    owner: string,
    source: Source,
    account: string,
  ): Promise<"incremental" | "history"> {
    this.owner(owner);
    return this.run(async (s) => {
      const state = await s.state(owner, source, account);
      if (state.mode !== "live" || state.status === "revoked")
        throw new Error("history source unavailable or revoked");
      const checkpoint = (await s.historyBackfills(owner)).find(
        (row) => row.source === source && row.account_id === account,
      );
      if (!checkpoint) throw new Error("history checkpoint missing");
      const lane = checkpoint.next_poll_lane ?? "incremental";
      if (lane !== "incremental" && lane !== "history")
        throw new Error("invalid history polling lane");
      await s.q(
        "UPDATE live_history_backfills SET data=$4 WHERE owner_id=$1 AND source=$2 AND account_id=$3 AND version=1",
        [
          owner,
          source,
          account,
          JSON.stringify({
            ...checkpoint,
            next_poll_lane: lane === "incremental" ? "history" : "incremental",
          }),
        ],
      );
      return lane;
    });
  }
  async beginHistoryBackfill(
    owner: string,
    source: Source,
    account: string,
    watermark: string,
  ): Promise<HistoryCheckpoint> {
    this.owner(owner);
    const initial = initialHistoryCheckpoint(
      owner,
      source,
      account,
      watermark,
      this.clock(),
    );
    return this.run(async (s) => {
      const state = await s.state(owner, source, account);
      if (state.mode !== "live" || state.status === "revoked")
        throw new Error("unregistered history source account");
      await s.q(
        "INSERT INTO live_history_backfills VALUES($1,$2,$3,1,$4) ON CONFLICT DO NOTHING",
        [owner, source, account, JSON.stringify(initial)],
      );
      return (await s.historyBackfills(owner)).find(
        (r) => r.source === source && r.account_id === account,
      )!;
    });
  }
  async commitHistoryBackfill(
    batch: HistoryPageCommit,
  ): Promise<NormalizedRecord[]> {
    this.owner(batch.owner_id);
    return this.run(async (s) => {
      const current = (await s.historyBackfills(batch.owner_id)).find(
        (r) => r.source === batch.source && r.account_id === batch.account_id,
      );
      if (!current) throw new Error("history checkpoint missing");
      const state = await s.state(
        batch.owner_id,
        batch.source,
        batch.account_id,
      );
      if (state.mode !== "live" || state.status === "revoked")
        throw new Error("history source revoked");
      const next = advanceHistoryCheckpoint(current, batch, this.clock());
      if (!next) return [];
      await s.seed(batch.contacts ?? [], batch.identities ?? [], []);
      const records: NormalizedRecord[] = [];
      for (const raw of batch.records) {
        const quarantined = (
          await s.q<{ observed_at: string }>(
            "SELECT observed_at FROM live_review_quarantines WHERE owner_id=$1 AND source=$2 AND account_id=$3 AND record_id=$4",
            [
              batch.owner_id,
              batch.source,
              batch.account_id,
              raw.source_record_id,
            ],
          )
        )[0];
        if (
          quarantined &&
          Date.parse(quarantined.observed_at) > Date.parse(raw.observed_at)
        )
          continue;
        const record = await s.write(raw, true);
        await s.q(
          "DELETE FROM live_review_quarantines WHERE owner_id=$1 AND source=$2 AND account_id=$3 AND record_id=$4 AND observed_at::timestamptz<=$5::timestamptz",
          [
            batch.owner_id,
            batch.source,
            batch.account_id,
            raw.source_record_id,
            raw.observed_at,
          ],
        );
        records.push(record);
        await s.q(
          "INSERT INTO live_history_seen VALUES($1,$2,$3,1,$4) ON CONFLICT DO NOTHING",
          [
            batch.owner_id,
            batch.source,
            batch.account_id,
            record.source_record_id,
          ],
        );
      }
      for (const q of batch.quarantines ?? []) {
        const prior = (
          await s.q<{ observed_at: string }>(
            "SELECT observed_at FROM live_records WHERE owner_id=$1 AND source=$2 AND account_id=$3 AND source_record_id=$4",
            [
              batch.owner_id,
              batch.source,
              batch.account_id,
              q.source_record_id,
            ],
          )
        )[0];
        if (prior && Date.parse(prior.observed_at) > Date.parse(q.observed_at))
          continue;
        await s.remove(
          batch.owner_id,
          batch.source,
          batch.account_id,
          q.source_record_id,
        );
        await s.q(
          "DELETE FROM live_history_seen WHERE owner_id=$1 AND source=$2 AND account_id=$3 AND version=1 AND record_id=$4",
          [batch.owner_id, batch.source, batch.account_id, q.source_record_id],
        );
        await s.q(
          "INSERT INTO live_review_quarantines(owner_id,source,account_id,record_id,reason,observed_at,original_reference) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(owner_id,source,account_id,record_id) DO UPDATE SET reason=EXCLUDED.reason,observed_at=EXCLUDED.observed_at,original_reference=EXCLUDED.original_reference WHERE EXCLUDED.observed_at::timestamptz>=live_review_quarantines.observed_at::timestamptz",
          [
            batch.owner_id,
            batch.source,
            batch.account_id,
            q.source_record_id,
            q.reason,
            q.observed_at,
            q.original_reference,
          ],
        );
      }
      for (const id of batch.removed_record_ids ?? []) {
        const prior = (
          await s.q<{ observed_at: string }>(
            "SELECT observed_at FROM live_records WHERE owner_id=$1 AND source=$2 AND account_id=$3 AND source_record_id=$4",
            [batch.owner_id, batch.source, batch.account_id, id],
          )
        )[0];
        if (
          prior &&
          Date.parse(prior.observed_at) >
            Date.parse(batch.withdrawals_observed_at ?? current.watermark)
        )
          continue;
        await s.remove(batch.owner_id, batch.source, batch.account_id, id);
        if (!batch.quarantines?.some((q) => q.source_record_id === id))
          await s.q(
            "DELETE FROM live_review_quarantines WHERE owner_id=$1 AND source=$2 AND account_id=$3 AND record_id=$4 AND observed_at::timestamptz<=$5::timestamptz",
            [
              batch.owner_id,
              batch.source,
              batch.account_id,
              id,
              batch.withdrawals_observed_at ?? current.watermark,
            ],
          );
        await s.q(
          "DELETE FROM live_history_seen WHERE owner_id=$1 AND source=$2 AND account_id=$3 AND version=1 AND record_id=$4",
          [batch.owner_id, batch.source, batch.account_id, id],
        );
      }
      const coverage = (
        await s.q<{
          n: string;
          oldest_at: string | null;
          newest_at: string | null;
        }>(
          "SELECT count(*)::text n,min(r.occurred_at::timestamptz)::text oldest_at,max(r.occurred_at::timestamptz)::text newest_at FROM live_history_seen h JOIN live_records r ON r.owner_id=h.owner_id AND r.source=h.source AND r.account_id=h.account_id AND r.source_record_id=h.record_id WHERE h.owner_id=$1 AND h.source=$2 AND h.account_id=$3 AND h.version=1",
          [batch.owner_id, batch.source, batch.account_id],
        )
      )[0]!;
      next.quarantined_count = Number(
        (
          await s.q<{ n: string }>(
            "SELECT count(*)::text n FROM live_review_quarantines WHERE owner_id=$1 AND source=$2 AND account_id=$3",
            [batch.owner_id, batch.source, batch.account_id],
          )
        )[0]?.n ?? 0,
      );
      next.record_count = Number(coverage.n);
      next.oldest_at =
        coverage.oldest_at === null
          ? null
          : new Date(coverage.oldest_at).toISOString();
      next.newest_at =
        coverage.newest_at === null
          ? null
          : new Date(coverage.newest_at).toISOString();
      await s.q(
        "UPDATE live_history_backfills SET data=$4 WHERE owner_id=$1 AND source=$2 AND account_id=$3 AND version=1",
        [batch.owner_id, batch.source, batch.account_id, JSON.stringify(next)],
      );
      return records;
    });
  }
  async retryHistoryBackfill(
    owner: string,
    source: Source,
    account: string,
    expectedLastError: string,
  ): Promise<boolean> {
    this.owner(owner);
    return this.run(async (s) => {
      const state = (await s.sourceStatus(owner)).find(
        (row) => row.source === source && row.account_id === account,
      );
      const current = (await s.historyBackfills(owner)).find(
        (row) => row.source === source && row.account_id === account,
      );
      if (
        state?.mode !== "live" ||
        state.status === "revoked" ||
        current?.status !== "paused" ||
        current.last_error !== expectedLastError ||
        !/^[a-z0-9_:-]{1,120}$/.test(expectedLastError) ||
        !expectedLastError.endsWith("requires_review")
      )
        return false;
      await s.q(
        "UPDATE live_history_backfills SET data=$4 WHERE owner_id=$1 AND source=$2 AND account_id=$3 AND version=1",
        [
          owner,
          source,
          account,
          JSON.stringify({ ...current, last_error: "owner_retry_requested" }),
        ],
      );
      return true;
    });
  }
  async pauseHistoryBackfill(
    owner: string,
    source: Source,
    account: string,
    error: string,
    retryAfter: string | null = null,
    resourceOnly = false,
  ): Promise<HistoryCheckpoint> {
    this.owner(owner);
    if (
      !/^[a-z0-9_:-]{1,120}$/.test(error) ||
      (retryAfter !== null && !exactTimestamp(retryAfter)) ||
      (resourceOnly &&
        (![
          "disk_floor",
          "index_budget",
          "history_resource_gate_required",
          "history_resource_measurement_unavailable",
        ].includes(error) ||
          retryAfter !== null))
    )
      throw new Error("invalid history pause");
    return this.run(async (s) => {
      const current = (await s.historyBackfills(owner)).find(
        (r) => r.source === source && r.account_id === account,
      );
      if (!current || current.status === "complete")
        throw new Error("history checkpoint unavailable");
      if (
        resourceOnly &&
        (current.last_error?.endsWith("requires_review") ||
          (current.retry_after_until !== null &&
            Date.parse(current.retry_after_until) > s.clock().getTime()))
      )
        return current;
      const row: HistoryCheckpoint = {
        ...current,
        status: "paused",
        retry_after_until:
          resourceOnly ||
          (current.retry_after_until !== null &&
            Date.parse(current.retry_after_until) > s.clock().getTime() &&
            (retryAfter === null ||
              Date.parse(current.retry_after_until) > Date.parse(retryAfter)))
            ? current.retry_after_until
            : retryAfter,
        last_error:
          current.last_error?.endsWith("requires_review") &&
          !error.endsWith("requires_review")
            ? current.last_error
            : error,
        updated_at: s.clock().toISOString(),
      };
      await s.q(
        "UPDATE live_history_backfills SET data=$4 WHERE owner_id=$1 AND source=$2 AND account_id=$3 AND version=1",
        [owner, source, account, JSON.stringify(row)],
      );
      return row;
    });
  }
  async dailyBriefingGet(
    owner: string,
    day: string,
  ): Promise<DailyBriefingRow | null> {
    this.owner(owner);
    return this.run(
      async (s) =>
        (
          await s.q<{ data: DailyBriefingRow }>(
            "SELECT data FROM live_daily_briefings WHERE owner_id=$1 AND paris_date=$2",
            [owner, day],
          )
        )[0]?.data ?? null,
    );
  }
  async dailyBriefingLatest(
    owner: string,
    sentOnly = false,
  ): Promise<DailyBriefingRow | null> {
    this.owner(owner);
    return this.run(
      async (s) =>
        (
          await s.q<{ data: DailyBriefingRow }>(
            "SELECT data FROM live_daily_briefings WHERE owner_id=$1" +
              (sentOnly ? " AND state='sent'" : "") +
              " ORDER BY paris_date DESC LIMIT 1",
            [owner],
          )
        )[0]?.data ?? null,
    );
  }
  async dailyBriefingInsert(row: DailyBriefingRow): Promise<boolean> {
    this.owner(row.owner_id);
    validateDailyBriefingRow(row);
    if (
      row.revision !== 0 ||
      row.attempts > (row.state === "pending" ? 1 : 0) ||
      !["pending", "missed"].includes(row.state)
    )
      throw new Error("invalid initial daily state");
    return this.run(
      async (s) =>
        (
          await s.q(
            "INSERT INTO live_daily_briefings VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING owner_id",
            [
              row.owner_id,
              row.paris_date,
              row.revision,
              row.state,
              JSON.stringify(row),
            ],
          )
        ).length === 1,
    );
  }
  async dailyBriefingReplace(
    expected: number,
    row: DailyBriefingRow,
  ): Promise<boolean> {
    this.owner(row.owner_id);
    return this.run(async (s) => {
      const current = await s.dailyBriefingGet(row.owner_id, row.paris_date);
      if (!current || current.revision !== expected) return false;
      validateDailyBriefingTransition(current, expected, row);
      return (
        (
          await s.q(
            "UPDATE live_daily_briefings SET revision=$3,state=$4,data=$5 WHERE owner_id=$1 AND paris_date=$2 AND revision=$6 RETURNING owner_id",
            [
              row.owner_id,
              row.paris_date,
              row.revision,
              row.state,
              JSON.stringify(row),
              expected,
            ],
          )
        ).length === 1
      );
    });
  }
  async privateContacts(
    owner: string,
    query: string,
    after: string,
    limit: number,
  ): Promise<(Contact & { emails: string[] })[]> {
    this.owner(owner);
    if (!Number.isInteger(limit) || limit < 1 || limit > 51)
      throw new Error("Invalid page limit");
    return this.run(async (s) => {
      const rows = await s.q<Contact & QueryResultRow>(
        "SELECT c.* FROM live_contacts c WHERE c.owner_id=$1 AND c.contact_id<>'OWNER' AND c.contact_id>$2 AND (position(lower($3) in lower(c.name))>0 OR EXISTS(SELECT 1 FROM live_identities i WHERE i.owner_id=c.owner_id AND i.contact_id=c.contact_id AND position(lower($3) in lower(i.identity))>0)) ORDER BY c.contact_id LIMIT $4",
        [owner, after, query, Math.min(51, limit)],
      );
      const out: (Contact & { emails: string[] })[] = [];
      for (const c of rows)
        out.push({
          ...c,
          emails: (
            await s.q<{ identity: string }>(
              "SELECT identity FROM live_identities WHERE owner_id=$1 AND contact_id=$2 ORDER BY identity",
              [owner, c.contact_id],
            )
          ).map((i) => i.identity),
        });
      return out;
    });
  }
  async privateHistory(
    owner: string,
    query: PrivateHistoryQuery,
  ): Promise<PrivateHistoryPage> {
    this.owner(owner);
    if (query.social_start !== undefined && !exactTimestamp(query.social_start))
      throw new Error("invalid social history range");
    return this.run(async (s) => {
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 51)
        throw new Error("Invalid page limit");
      const values: unknown[] = [owner];
      let where =
        "r.owner_id=$1 AND NOT r.cancelled AND r.ingestion_mode IN ('live','snapshot')";
      const value = (v: unknown): string => {
        values.push(v);
        return "$" + values.length;
      };
      if (query.contact_ids.length)
        where +=
          " AND (r.contact_id=ANY(" +
          value(query.contact_ids) +
          "::text[]) OR r.contact_ids && " +
          value(query.contact_ids) +
          "::text[])";
      where +=
        " AND (EXISTS(SELECT 1 FROM jsonb_array_elements(" +
        value(JSON.stringify(query.accounts)) +
        "::jsonb) a WHERE a->>'source'=r.source AND a->>'account_id'=r.account_id) OR (r.source='calendar' AND EXISTS(SELECT 1 FROM jsonb_array_elements(" +
        value(JSON.stringify(query.snapshots ?? [])) +
        "::jsonb) snap WHERE snap->>'calendar_id'=r.account_id AND snap->>'event_id'=r.source_record_id)))";
      if (query.members)
        where +=
          " AND EXISTS(SELECT 1 FROM jsonb_array_elements(" +
          value(JSON.stringify(query.members)) +
          "::jsonb) m WHERE m->>'source'=r.source AND m->>'account_id'=r.account_id AND (m->>'contact_id'=r.contact_id OR m->>'contact_id'=ANY(r.contact_ids)))";
      where +=
        " AND EXISTS(SELECT 1 FROM live_accounts a WHERE a.owner_id=r.owner_id AND a.source=r.source AND a.account_id=r.account_id AND a.state->>'status'<>'revoked')";
      const calendarStart = value(query.calendar_start ?? query.now);
      const now = value(query.now),
        end = value(query.calendar_end),
        start = value(query.message_start),
        socialStart = value(query.social_start ?? query.message_start);
      where +=
        " AND ((r.source='calendar' AND coalesce(r.end_at,r.occurred_at)>" +
        calendarStart +
        " AND r.occurred_at<" +
        end +
        ") OR (r.source<>'calendar' AND r.occurred_at>=CASE WHEN r.source='gmail' THEN " +
        start +
        " ELSE " +
        socialStart +
        " END" +
        " AND r.occurred_at<=" +
        now +
        "))";
      for (const term of query.terms ?? [])
        where +=
          " AND position(lower(" + value(term) + ") in lower(r.body_text))>0";
      if (query.source) where += " AND r.source=" + value(query.source);
      if (query.direction)
        where += " AND r.direction=" + value(query.direction);
      if (query.from) where += " AND r.occurred_at>=" + value(query.from);
      if (query.to) where += " AND r.occurred_at<" + value(query.to);
      const summary = (
        await s.q<{ total: string; revision: string }>(
          "SELECT count(*)::text total,md5(coalesce(string_agg(r.record_key || ':' || r.content_hash,'|' ORDER BY r.record_key),'')) revision FROM live_records r WHERE " +
            where,
          values,
        )
      )[0]!;
      let activity: Record<string, PrivateContactActivity> | undefined;
      if (query.activity_for) {
        if (query.activity_for.length > 50)
          throw new Error("Too many activity selectors");
        activity = Object.fromEntries(
          query.activity_for.map((a) => [
            a.selector,
            { count: 0, last_at: null, sources: [] },
          ]),
        );
        const aggregate = await s.q<{
          selector: string;
          count: string;
          last_at: string;
          sources: Source[];
        }>(
          "SELECT a->>'selector' selector,count(*)::text count,max(r.occurred_at) last_at,array_agg(DISTINCT r.source ORDER BY r.source) sources FROM live_records r JOIN jsonb_array_elements($" +
            (values.length + 1) +
            "::jsonb) a ON (r.contact_id IN (SELECT jsonb_array_elements_text(a->'contact_ids')) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(a->'contact_ids') ids WHERE ids=ANY(r.contact_ids))) AND (NOT a ? 'members' OR EXISTS(SELECT 1 FROM jsonb_array_elements(a->'members') m WHERE m->>'source'=r.source AND m->>'account_id'=r.account_id AND (m->>'contact_id'=r.contact_id OR m->>'contact_id'=ANY(r.contact_ids)))) WHERE " +
            where +
            " GROUP BY a->>'selector'",
          [...values, JSON.stringify(query.activity_for)],
        );
        for (const row of aggregate)
          activity[row.selector] = {
            count: Number(row.count),
            last_at: row.last_at,
            sources: row.sources,
          };
      }
      if (query.after) {
        const t = value(query.after.occurred_at);
        where +=
          " AND (r.occurred_at<" +
          t +
          " OR (r.occurred_at=" +
          t +
          " AND r.record_key>" +
          value(query.after.record_key) +
          "))";
      }
      const rows = await s.q(
        "SELECT r.* FROM live_records r WHERE " +
          where +
          " ORDER BY r.occurred_at DESC,r.record_key LIMIT " +
          value(Math.min(51, query.limit)),
        values,
      );
      return {
        records: rows.map((r) => s.record(r)),
        total: Number(summary.total),
        revision: summary.revision,
        ...(activity ? { activity } : {}),
      };
    });
  }
  async contacts(
    owner: string,
    query = "",
  ): Promise<(Contact & { emails: string[] })[]> {
    this.owner(owner);
    return this.run(async (s) => {
      const contacts = await s.q<Contact & QueryResultRow>(
          "SELECT * FROM live_contacts WHERE owner_id=$1 ORDER BY name,contact_id",
          [owner],
        ),
        identities = await s.identities(owner),
        needle = query.toLowerCase();
      return contacts
        .map((c) => ({
          ...c,
          emails: identities
            .filter((i) => i.contact_id === c.contact_id)
            .map((i) => i.identity),
        }))
        .filter(
          (c) =>
            !query ||
            c.name.toLowerCase().includes(needle) ||
            c.contact_id === query ||
            c.emails.some((i) => i.toLowerCase().includes(needle)),
        );
    });
  }
  async resolveContact(owner: string, query: string): Promise<Contact> {
    this.owner(owner);
    return this.run(async (s) => {
      if (query.includes("@")) {
        const identity = (await s.identities(owner)).find(
          (x) => x.identity === canonicalEmail(query),
        );
        if (!identity || identity.contact_id === "OWNER")
          throw new Error("unknown contact");
        query = identity.contact_id;
      }
      const rows = await s.q<Contact & QueryResultRow>(
        "SELECT * FROM live_contacts WHERE owner_id=$1 AND (contact_id=$2 OR name=$2)",
        [owner, query],
      );
      if (rows.length !== 1)
        throw new Error(
          rows.length ? "ambiguous contact: use ID" : "unknown contact",
        );
      return rows[0]!;
    });
  }
  async commitments(owner: string): Promise<ThreadedCommitment[]> {
    this.owner(owner);
    return this.run(async (s) =>
      annotateThreads(await s.obligations(owner), await s.threadRows(owner)),
    );
  }
  private obligations(owner: string): Promise<Commitment[]> {
    return this.q<Commitment & QueryResultRow>(
      "SELECT * FROM live_obligations WHERE owner_id=$1 ORDER BY commitment_id",
      [owner],
    );
  }
  // Promise threads (schema/007): same contract as TendStore, see src/promise-threads.ts.
  private threadGroups: readonly VerifiedContactGroup[] = [];
  async setThreadGroups(
    groups: readonly VerifiedContactGroup[],
  ): Promise<void> {
    this.threadGroups = groups;
    return Promise.resolve();
  }
  async threadRows(owner: string): Promise<ThreadRow[]> {
    this.owner(owner);
    return this.run(async (s) =>
      (
        await s.q<ThreadRow & QueryResultRow>(
          "SELECT thread_id,commitment_id,linked_by,similarity,created_at FROM commitment_thread_members WHERE owner_id=$1 ORDER BY thread_id,created_at,commitment_id",
          [owner],
        )
      ).map((r) => ({
        ...r,
        similarity: r.similarity === null ? null : Number(r.similarity),
      })),
    );
  }
  async linkPromiseThreads(
    owner: string,
    groups?: readonly VerifiedContactGroup[],
    cosine?: ActionCosine,
    only?: readonly string[],
  ): Promise<ThreadRow[]> {
    return (await this.linkBatch(owner, groups, cosine, only)).rows;
  }
  /**
   * One bounded link pass under the owner lock: SQL scoped to open obligations, a 2 s budget, and a
   * savepoint so a slow or failing link adds no thread without undoing the caller's work.
   */
  async linkBatch(
    owner: string,
    groups?: readonly VerifiedContactGroup[],
    cosine?: ActionCosine,
    only?: readonly string[],
  ): Promise<{ rows: ThreadRow[]; outcome: "ok" | "timed_out" }> {
    this.owner(owner);
    const remembered = groups ?? this.threadGroups;
    return this.run(async (s) => {
      await s.q("SAVEPOINT promise_link");
      try {
        await s.q(`SET LOCAL statement_timeout = ${OUTREACH_READ_BUDGET_MS}`);
        const rows = await s.linkWithin(
          owner,
          remembered,
          cosine,
          only,
          Date.now() + OUTREACH_READ_BUDGET_MS,
        );
        await s.q("SET LOCAL statement_timeout TO DEFAULT");
        await s.q("RELEASE SAVEPOINT promise_link");
        return { rows, outcome: "ok" as const };
      } catch (error) {
        await s.q("ROLLBACK TO SAVEPOINT promise_link");
        await s.q("RELEASE SAVEPOINT promise_link");
        // Only the time budget is absorbed (the backfill retries it); any other error is a bug and surfaces.
        if ((error as { code?: unknown } | null)?.code !== "57014") throw error;
        return { rows: [], outcome: "timed_out" as const };
      }
    });
  }
  /** Read only: open, valid obligations in no thread yet, for the operator backfill. */
  async unlinkedOpenIds(owner: string): Promise<string[]> {
    this.owner(owner);
    return this.run(async (s) => {
      await s.q(`SET LOCAL statement_timeout = ${OUTREACH_READ_BUDGET_MS}`);
      try {
        return (
          await s.q<{ commitment_id: string }>(
            "SELECT o.commitment_id FROM live_obligations o WHERE o.owner_id=$1 AND o.status IN ('pending','confirmed') AND o.evidence_valid AND NOT EXISTS(SELECT 1 FROM commitment_thread_members m WHERE m.owner_id=o.owner_id AND m.commitment_id=o.commitment_id) ORDER BY o.commitment_id",
            [owner],
          )
        ).map((r) => r.commitment_id);
      } finally {
        await s.q("SET LOCAL statement_timeout TO DEFAULT").catch(() => {});
      }
    });
  }
  private async linkWithin(
    owner: string,
    remembered: readonly VerifiedContactGroup[],
    cosine: ActionCosine | undefined,
    only: readonly string[] | undefined,
    deadline: number,
  ): Promise<ThreadRow[]> {
    // statement_timeout bounds each statement; this bounds the whole link to the same budget.
    const due = (): void => {
      if (Date.now() > deadline)
        throw Object.assign(new Error("promise link budget"), {
          code: "57014",
        });
    };
    // Open obligations plus current thread members: closed ones never link, so they are not read.
    const commitments = await this.q<Commitment & QueryResultRow>(
        "SELECT o.* FROM live_obligations o WHERE o.owner_id=$1 AND (o.status IN ('pending','confirmed') OR EXISTS(SELECT 1 FROM commitment_thread_members m WHERE m.owner_id=o.owner_id AND m.commitment_id=o.commitment_id)) ORDER BY o.commitment_id",
        [owner],
      ),
      keys = commitments.map((c) => c.record_key),
      times = keys.length
        ? await this.q<{ record_key: string; occurred_at: string }>(
            "SELECT record_key,occurred_at FROM live_records WHERE owner_id=$1 AND record_key=ANY($2::text[])",
            [owner, keys],
          )
        : [];
    due();
    const added = linkThreads({
      commitments,
      occurredAt: new Map(
        times.map((r) => [r.record_key, String(r.occurred_at)]),
      ),
      rows: await this.threadRows(owner),
      overrides: await this.q<ThreadOverride & QueryResultRow>(
        "SELECT commitment_id,other_commitment_id FROM commitment_thread_overrides WHERE owner_id=$1 ORDER BY commitment_id,other_commitment_id",
        [owner],
      ),
      groups: remembered,
      ...(cosine ? { cosine } : {}),
      ...(only ? { only } : {}),
      now: this.clock(),
    });
    const created = new Set(
      (await this.threadRows(owner)).map((r) => r.thread_id),
    );
    due();
    // Plain inserts: a conflict would mean a reused thread id or a double placement, which is a bug.
    for (const row of added) {
      due();
      if (!created.has(row.thread_id)) {
        await this.q("INSERT INTO commitment_threads VALUES($1,$2,$3)", [
          owner,
          row.thread_id,
          row.created_at,
        ]);
        created.add(row.thread_id);
      }
      await this.q(
        "INSERT INTO commitment_thread_members VALUES($1,$2,$3,$4,$5,$6)",
        [
          owner,
          row.thread_id,
          row.commitment_id,
          row.linked_by,
          row.similarity,
          row.created_at,
        ],
      );
    }
    return added;
  }
  private async separateCommitment(owner: string, id: string): Promise<void> {
    const split = separateFromThread(await this.threadRows(owner), id),
      at = this.clock().toISOString();
    for (const o of split.overrides)
      await this.q(
        "INSERT INTO commitment_thread_overrides VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [owner, o.commitment_id, o.other_commitment_id, at],
      );
    await this.q(
      "DELETE FROM commitment_thread_members WHERE owner_id=$1 AND commitment_id=ANY($2::text[])",
      [owner, split.remove],
    );
    await this.q(
      "DELETE FROM commitment_threads t WHERE owner_id=$1 AND NOT EXISTS(SELECT 1 FROM commitment_thread_members m WHERE m.owner_id=t.owner_id AND m.thread_id=t.thread_id)",
      [owner],
    );
  }
  private async put(c: Commitment): Promise<void> {
    await this.q(
      `INSERT INTO live_obligations(${obligationColumns.join(",")}) VALUES(${obligationColumns.map((_, i) => "$" + (i + 1)).join(",")}) ON CONFLICT(owner_id,commitment_id) DO UPDATE SET ${obligationColumns
        .filter((k) => !["owner_id", "commitment_id"].includes(k))
        .map((k) => `${k}=EXCLUDED.${k}`)
        .join(",")}`,
      obligationColumns.map((k) => c[k]),
    );
  }
  async addCandidate(raw: RawRecord, input: unknown): Promise<Commitment> {
    this.owner(raw.owner_id);
    // Transaction stores are fresh instances, so the groups are carried in from this one.
    const groups = this.threadGroups;
    return this.run(async (s) => {
      const normalized = normalizeLiveRecord(
          raw,
          await s.identities(raw.owner_id),
        ),
        validated = validateLiveCandidate(raw as LiveRecord, input),
        stored = await s.byKey(raw.owner_id, normalized.record_key);
      if (!stored || stored.content_hash !== normalized.content_hash)
        throw new Error("evidence not persisted/current");
      const id = "C" + normalized.record_key.slice(0, 12),
        current = (await s.commitments(raw.owner_id)).find(
          (c) => c.commitment_id === id,
        );
      if (current && current.status !== "invalidated") {
        if (current.status === "confirmed" && current.evidence_valid === false)
          return current;
        if (current.evidence_valid === false)
          throw new Error(
            "invalidated candidate requires external owner review; automatic reinstatement unsupported",
          );
        return current;
      }
      const c: Commitment = {
        ...validated,
        commitment_id: id,
        owner_id: raw.owner_id,
        contact_id: normalized.contact_id,
        source: raw.source,
        record_key: normalized.record_key,
        direction: raw.direction === "sent" ? "owed_by_me" : "owed_to_me",
        status: "pending",
        due_date: null,
        evidence_valid: true,
      };
      await s.put(c);
      await s.linkPromiseThreads(raw.owner_id, groups, undefined, [id]);
      return c;
    });
  }
  // Same rule as TendStore.extractionCandidates, filtered in SQL so the
  // per-minute extraction poll never loads every record for the owner.
  async extractionCandidates(
    owner: string,
    recordKey: string | null,
  ): Promise<NormalizedRecord[]> {
    this.owner(owner);
    return this.run(async (s) =>
      (
        await s.q(
          "SELECT r.* FROM live_records r WHERE r.owner_id=$1 AND r.kind='message' AND r.direction<>'event' AND r.attribution='direct' AND r.eligible_for_extraction AND NOT r.cancelled AND CASE WHEN $2::text IS NULL THEN NOT EXISTS(SELECT 1 FROM live_attempts a WHERE a.owner_id=r.owner_id AND a.record_key=r.record_key AND a.content_hash=r.content_hash) ELSE r.record_key=$2::text END ORDER BY r.source,r.source_record_id",
          [owner, recordKey],
        )
      ).map((x) => s.record(x)),
    );
  }
  async extractionAttempted(record: NormalizedRecord): Promise<boolean> {
    this.owner(record.owner_id);
    return this.run(
      async (s) =>
        (
          await s.q<{ content_hash: string }>(
            "SELECT content_hash FROM live_attempts WHERE owner_id=$1 AND record_key=$2",
            [record.owner_id, record.record_key],
          )
        )[0]?.content_hash === record.content_hash,
    );
  }
  async markExtractionAttempt(
    owner: string,
    key: string,
    hash: string,
  ): Promise<void> {
    this.owner(owner);
    return this.run(async (s) => {
      const record = await s.byKey(owner, key);
      if (
        !record ||
        record.content_hash !== hash ||
        eligiblePromiseSpans(record).length === 0
      )
        throw new Error("current eligible authored evidence required");
      await s.q(
        "INSERT INTO live_attempts VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,record_key) DO UPDATE SET content_hash=EXCLUDED.content_hash,attempted_at=EXCLUDED.attempted_at",
        [owner, key, hash, s.clock().toISOString()],
      );
    });
  }
  async extractionReviewCount(owner: string): Promise<number> {
    this.owner(owner);
    return this.run(async (s) =>
      Number(
        (
          await s.q<{ n: string }>(
            "SELECT count(*) n FROM live_attempts a JOIN live_records r USING(owner_id,record_key,content_hash) WHERE a.owner_id=$1 AND NOT EXISTS(SELECT 1 FROM live_obligations o WHERE o.owner_id=a.owner_id AND o.record_key=a.record_key)",
            [owner],
          )
        )[0]!.n,
      ),
    );
  }
  async revokeSource(owner: string, source: Source): Promise<void> {
    this.owner(owner);
    return this.run(async (s) => {
      for (const state of (await s.sourceStatus(owner)).filter(
        (x) => x.source === source,
      ))
        await s.putState({ ...state, status: "revoked" });
      for (const r of await s.q<{ record_key: string }>(
        "SELECT record_key FROM live_records WHERE owner_id=$1 AND source=$2",
        [owner, source],
      ))
        await s.invalidate(owner, r.record_key);
      await s.q("DELETE FROM live_records WHERE owner_id=$1 AND source=$2", [
        owner,
        source,
      ]);
      await s.q(
        "DELETE FROM live_review_quarantines WHERE owner_id=$1 AND source=$2",
        [owner, source],
      );
      await s.q("DELETE FROM live_seen WHERE owner_id=$1 AND source=$2", [
        owner,
        source,
      ]);
      await s.scrub(owner);
      await s.prune(owner);
    });
  }
  private authorize(auth: AuthCommand): void {
    if (
      auth.owner_id !== this.principal.owner_id ||
      auth.user_id !== this.principal.user_id ||
      auth.chat_id !== this.principal.chat_id ||
      auth.chat_type !== "private"
    )
      throw new Error("unauthorized");
  }
  private telegramKey(channel: string, update: number): void {
    if (
      !/^[a-z0-9-]{1,80}$/.test(channel) ||
      !Number.isSafeInteger(update) ||
      update < 0
    )
      throw new Error("invalid Telegram update key");
  }
  async telegramCommand(
    auth: AuthCommand,
    channel: string,
    update: number,
  ): Promise<{ accepted: boolean; reply?: Reply }> {
    this.authorize(auth);
    this.telegramKey(channel, update);
    return this.run(async (s) => {
      if (
        (
          await s.q(
            "SELECT 1 FROM live_reply_ledger WHERE owner_id=$1 AND channel_id=$2 AND update_id=$3",
            [auth.owner_id, channel, update],
          )
        ).length
      )
        return { accepted: false };
      let reply: Reply;
      await s.q("SAVEPOINT command_execution");
      try {
        reply = await s.command(auth);
        await s.q("RELEASE SAVEPOINT command_execution");
      } catch {
        await s.q("ROLLBACK TO SAVEPOINT command_execution");
        await s.q("RELEASE SAVEPOINT command_execution");
        reply = {
          outbound_sent: false,
          error: "Command failed. Use /help for examples.",
        };
      }
      await s.q(
        "INSERT INTO live_reply_ledger(owner_id,channel_id,update_id,payload_hash,reply_data,status) VALUES($1,$2,$3,$4,$5,$6)",
        [
          auth.owner_id,
          channel,
          update,
          createHash("sha256").update(auth.text).digest("hex"),
          JSON.stringify(reply),
          "reply_pending",
        ],
      );
      return { accepted: true, reply };
    });
  }
  async commitTelegramReply(
    auth: AuthCommand,
    channel: string,
    update: number,
    prepared: PreparedTelegramRead,
    signal?: AbortSignal,
    policy?: LivePolicy,
  ): Promise<{ accepted: boolean; reply?: Reply }> {
    signal?.throwIfAborted();
    this.authorize(auth);
    this.telegramKey(channel, update);
    return this.run(async (s) => {
      signal?.throwIfAborted();
      if (
        (
          await s.q(
            "SELECT 1 FROM live_reply_ledger WHERE owner_id=$1 AND channel_id=$2 AND update_id=$3",
            [auth.owner_id, channel, update],
          )
        ).length
      )
        return { accepted: false };
      const reply = validatePreparedTelegramReply(
        auth.owner_id,
        prepared,
        await s.interactions(auth.owner_id),
        await s.contacts(auth.owner_id),
        await s.commitments(auth.owner_id),
        await s.sourceStatus(auth.owner_id),
        s.clock(),
        policy,
      );
      signal?.throwIfAborted();
      await s.q(
        "INSERT INTO live_reply_ledger(owner_id,channel_id,update_id,payload_hash,reply_data,status) VALUES($1,$2,$3,$4,$5,$6)",
        [
          auth.owner_id,
          channel,
          update,
          createHash("sha256").update(auth.text).digest("hex"),
          JSON.stringify(reply),
          "reply_pending",
        ],
      );
      signal?.throwIfAborted();
      return { accepted: true, reply };
    });
  }
  async pendingTelegramReply(
    owner: string,
    channel: string,
    update: number,
  ): Promise<{ channel_id: string; update_id: number; reply: Reply } | null> {
    this.owner(owner);
    this.telegramKey(channel, update);
    return this.run(async (s) => {
      const row = (
        await s.q<{ reply_data: unknown; status: string }>(
          "SELECT reply_data,status FROM live_reply_ledger WHERE owner_id=$1 AND channel_id=$2 AND update_id=$3",
          [owner, channel, update],
        )
      )[0];
      if (
        !row ||
        row.status !== "reply_pending" ||
        !isRecord(row.reply_data) ||
        row.reply_data.outbound_sent !== false
      )
        return null;
      return {
        channel_id: channel,
        update_id: update,
        reply: { ...row.reply_data, outbound_sent: false },
      };
    });
  }
  async acknowledgeTelegramReply(
    auth: AuthCommand,
    channel: string,
    update: number,
    message: number,
  ): Promise<void> {
    this.authorize(auth);
    this.telegramKey(channel, update);
    if (!Number.isSafeInteger(message) || message <= 0)
      throw new Error("invalid Telegram message ID");
    return this.run(async (s) => {
      const rows = await s.q(
        "UPDATE live_reply_ledger SET status='sent',telegram_message_id=$4,reply_data='{}' WHERE owner_id=$1 AND channel_id=$2 AND update_id=$3 RETURNING update_id",
        [auth.owner_id, channel, update, message],
      );
      if (rows.length !== 1) throw new Error("unknown Telegram update");
    });
  }
  async command(auth: AuthCommand): Promise<Reply> {
    this.authorize(auth);
    return this.run(async (s) => {
      const extended = await s.extension?.(auth, s);
      if (extended) return extended;
      const tokens = auth.text.trim().split(/\s+/),
        [cmd, id, date, ...extra] = tokens,
        owner = auth.owner_id,
        mode = "PRIVATE LIVE GOOGLE";
      const expected =
        cmd === "/confirm"
          ? 3
          : ["/draft", "/done", "/cancel", "/dismiss", "/separate"].includes(
                cmd ?? "",
              )
            ? 2
            : 1;
      if (
        !["/prep", "/contacts"].includes(cmd ?? "") &&
        (tokens.length !== expected || extra.length)
      )
        throw new Error("invalid command arguments");
      if (cmd === "/contacts") {
        const found = await s.contacts(owner, tokens.slice(1).join(" "));
        return {
          outbound_sent: false,
          mode,
          contacts: found.slice(0, 50),
          contacts_total: found.length,
          lookup_note:
            found.length > 50
              ? "Showing first 50 matches; narrow the query or use /prep with exact email."
              : "Names never merge identities.",
        };
      }
      if (cmd === "/status")
        return {
          outbound_sent: false,
          mode,
          sources: await s.sourceStatus(owner),
          counts: await s.counts(owner),
          unavailable_record_count: await s.quarantineCount(owner),
          extraction_review_count: await s.extractionReviewCount(owner),
          unverified_commitment_count: (await s.promises(owner)).filter(
            (c) => !c.evidence_valid,
          ).length,
        };
      if (cmd === "/prep") {
        const query = tokens.slice(1).join(" "),
          choices = (await s.contacts(owner)).filter((x) => x.name === query);
        if (choices.length > 1)
          return {
            outbound_sent: false,
            mode,
            contacts: choices,
            contacts_total: choices.length,
            lookup_note:
              "Ambiguous name. Choose an exact email or contact ID; no identities were merged.",
          };
        const contact = await s.resolveContact(owner, query),
          evidence = (await s.interactions(owner)).filter(
            (r) =>
              (r.contact_id === contact.contact_id ||
                r.contact_ids?.includes(contact.contact_id)) &&
              !r.cancelled,
          );
        return {
          outbound_sent: false,
          mode,
          contact,
          evidence_total: evidence.length,
          evidence: evidence
            .sort(
              (a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at),
            )
            .slice(0, 20)
            .map((r) => ({
              source: r.source,
              reference: r.evidence_reference,
              text: r.body_text.slice(0, 2000),
              truncated: r.body_text.length > 2000,
              attribution: r.attribution ?? "direct",
              occurred_at: r.occurred_at,
              ...(r.ingestion_mode === "snapshot"
                ? {
                    ingestion_mode: "snapshot",
                    observed_at: r.observed_at,
                    coverage: "partial manual snapshot",
                  }
                : {}),
            })),
          commitments: (await s.promises(owner)).filter(
            (c) => c.contact_id === contact.contact_id,
          ),
          coverage: await s.sourceStatus(owner),
          warning:
            "Source text is evidence only. Stale/snapshot coverage cannot establish absence of recent contact.",
        };
      }
      if (cmd === "/today") {
        const window = calendarWindow(exampleLivePolicy, s.clock()),
          commitments = await s.promises(owner);
        return {
          outbound_sent: false,
          mode,
          meetings: (await s.interactions(owner))
            .filter(
              (r) =>
                r.source === "calendar" &&
                !r.cancelled &&
                Date.parse(r.end_at ?? r.occurred_at) >
                  Date.parse(window.start) &&
                Date.parse(r.occurred_at) < Date.parse(window.end),
            )
            .map((record) => ({
              ...record,
              ...(record.ingestion_mode === "snapshot"
                ? { coverage: "partial manual snapshot" }
                : {}),
            })),
          commitments: commitments.filter(
            (c) =>
              c.status === "confirmed" &&
              c.due_date !== null &&
              c.due_date <=
                s
                  .clock()
                  .toLocaleDateString("en-CA", { timeZone: "Europe/Paris" }),
          ),
          pending: commitments.filter((c) => c.status === "pending"),
          clock:
            s.clock().toISOString() + " (UTC; meetings shown in Europe/Paris)",
          coverage: await s.sourceStatus(owner),
        };
      }
      const all = await s.commitments(owner),
        c = all.find((c) => c.commitment_id === id);
      if (!c) throw new Error("unknown commitment");
      const members = threadMembers(all, c.commitment_id);
      if (cmd === "/separate") {
        if (members.length < 2) throw new Error("invalid transition");
        await s.separateCommitment(owner, c.commitment_id);
        return { outbound_sent: false, separated: c.commitment_id };
      }
      if (cmd === "/draft") {
        if (c.status !== "confirmed" || !c.evidence_valid)
          throw new Error("unconfirmed or unavailable evidence for draft");
        return {
          outbound_sent: false,
          preview:
            c.direction === "owed_by_me"
              ? `Review-only draft: Update on my promise "${c.quote}". [Add my actual progress before sending]`
              : `Review-only draft: Following up on "${c.quote}". Could you confirm progress?`,
          evidence: c.record_key,
        };
      }
      if (cmd === "/confirm") {
        if (!date || !exactTimestamp(`${date}T00:00:00Z`))
          throw new Error("explicit valid date required");
        if (!c.evidence_valid)
          throw new Error("invalid transition: evidence unavailable");
        // Confirming any sighting of a thread confirms and links every pending sighting once.
        const pending = members.filter(
          (m) => m.status === "pending" && m.evidence_valid,
        );
        if (c.status === "confirmed" && c.due_date === date && !pending.length)
          return { outbound_sent: false, ...c };
        if (
          c.status !== "pending" &&
          !(c.status === "confirmed" && pending.length)
        )
          throw new Error("invalid transition");
        for (const m of pending)
          await s.put(
            withoutThread({ ...m, status: "confirmed", due_date: date }),
          );
        if (members.length > 1)
          await s.q(
            "UPDATE commitment_thread_members SET linked_by='owner' WHERE owner_id=$1 AND thread_id=$2",
            [owner, c.thread_id],
          );
        const next =
          c.status === "pending"
            ? { ...c, status: "confirmed", due_date: date }
            : c;
        return {
          outbound_sent: false,
          ...next,
          ...(members.length > 1 ? { linked: members.length } : {}),
        };
      }
      if (cmd === "/dismiss") {
        if (c.status === "dismissed") return { outbound_sent: false, ...c };
        if (c.status !== "pending") throw new Error("invalid transition");
        for (const m of members.filter((m) => m.status === "pending"))
          await s.put(withoutThread({ ...m, status: "dismissed" }));
        return { outbound_sent: false, ...c, status: "dismissed" };
      }
      const target =
        cmd === "/done" ? "done" : cmd === "/cancel" ? "cancelled" : null;
      if (!target) throw new Error("unsupported command");
      if (c.status === target) return { outbound_sent: false, ...c };
      if (c.status !== "confirmed") throw new Error("invalid transition");
      // The promise is closed once, on every channel it was seen on.
      for (const m of members.filter(
        // Pending sightings close too, but never one whose evidence changed (same rule as /confirm).
        (m) =>
          m.status === "confirmed" ||
          (m.status === "pending" && m.evidence_valid !== false),
      ))
        await s.put(withoutThread({ ...m, status: target }));
      return { outbound_sent: false, ...c, status: target };
    });
  }
  /** One commitment per promise thread, for counts and lists. */
  async promises(owner: string): Promise<ThreadedCommitment[]> {
    this.owner(owner);
    return this.run(async (s) => {
      const all = await s.commitments(owner),
        keys = all.map((c) => c.record_key),
        times = keys.length
          ? await s.q<{ record_key: string; occurred_at: string }>(
              "SELECT record_key,occurred_at FROM live_records WHERE owner_id=$1 AND record_key=ANY($2::text[])",
              [owner, keys],
            )
          : [];
      return onePerThread(
        all,
        new Map(times.map((r) => [r.record_key, String(r.occurred_at)])),
      );
    });
  }
}
