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
} from "./engine.ts";
import type { PreparedTelegramRead } from "./telegram-normal.ts";
import type { LiveRecord } from "./google-records.ts";
import { canonicalEmail } from "./google-records.ts";
import { calendarWindow, exampleLivePolicy } from "./live-policy.ts";
import { eligiblePromiseSpans } from "./authored-promises.ts";
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
export class PostgresStore implements LiveStore {
  private readonly pool: Pool;
  private readonly principal: Principal;
  private readonly clock: () => Date;
  private readonly client: PoolClient | null;
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT owner_id FROM live_runtime_principal WHERE owner_id=$1 FOR UPDATE",
        [this.principal.owner_id],
      );
      const result = await operation(
        new PostgresStore(this.pool, this.principal, this.clock, client),
      );
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
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
          "SELECT (SELECT count(*) FROM live_records WHERE owner_id=$1) interactions,(SELECT count(*) FROM live_obligations WHERE owner_id=$1) commitments",
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
  private async write(raw: RawRecord): Promise<NormalizedRecord> {
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
      await this.q<{ content_hash: string }>(
        "SELECT content_hash FROM live_records WHERE owner_id=$1 AND record_key=$2",
        [raw.owner_id, normalized.record_key],
      )
    )[0];
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
      "UPDATE live_obligations SET status=CASE WHEN status IN ('confirmed','done','cancelled') THEN status ELSE 'invalidated' END,evidence_valid=false,quote='',action='',suggested_due=NULL,due_date=CASE WHEN status='confirmed' THEN due_date ELSE NULL END WHERE owner_id=$1 AND record_key=$2",
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
      for (const r of batch.records) {
        out.push(await s.write(r));
        await s.q(
          "DELETE FROM live_review_quarantines WHERE owner_id=$1 AND source=$2 AND account_id=$3 AND record_id=$4",
          [batch.owner_id, batch.source, batch.account_id, r.source_record_id],
        );
      }
      for (const q of batch.quarantines ?? [])
        await s.q(
          "INSERT INTO live_review_quarantines VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_id,source,account_id,record_id) DO UPDATE SET reason=EXCLUDED.reason,observed_at=EXCLUDED.observed_at",
          [
            batch.owner_id,
            batch.source,
            batch.account_id,
            q.source_record_id,
            q.reason,
            q.observed_at,
          ],
        );
      for (const id of batch.seen_record_ids)
        await s.q(
          "INSERT INTO live_seen VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [batch.owner_id, batch.source, batch.account_id, id],
        );
      for (const id of batch.removed_record_ids ?? [])
        await s.remove(batch.owner_id, batch.source, batch.account_id, id);
      if (completion.complete && batch.reconcile) {
        const missing = await s.q<{ source_record_id: string }>(
          "SELECT source_record_id FROM live_records r WHERE owner_id=$1 AND source=$2 AND account_id=$3 AND NOT EXISTS(SELECT 1 FROM live_seen v WHERE v.owner_id=r.owner_id AND v.source=r.source AND v.account_id=r.account_id AND v.record_id=r.source_record_id)",
          [batch.owner_id, batch.source, batch.account_id],
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
  ): Promise<void> {
    this.owner(owner);
    return this.run(async (s) => {
      const expired = await s.q<{
        source: Source;
        account_id: string;
        source_record_id: string;
      }>(
        "SELECT source,account_id,source_record_id FROM live_records WHERE owner_id=$1 AND ((source<>'calendar' AND occurred_at::timestamptz<$2::timestamptz) OR (source='calendar' AND (coalesce(end_at,occurred_at)::timestamptz<=$3::timestamptz OR occurred_at::timestamptz>=$4::timestamptz)))",
        [owner, messageStart, calendarStart, calendarEnd],
      );
      for (const r of expired)
        await s.remove(owner, r.source, r.account_id, r.source_record_id);
      await s.q(
        "DELETE FROM live_review_quarantines WHERE owner_id=$1 AND observed_at<$2",
        [owner, messageStart],
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
      ),
    );
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
      const now = value(query.now),
        end = value(query.calendar_end),
        start = value(query.message_start);
      where +=
        " AND ((r.source='calendar' AND coalesce(r.end_at,r.occurred_at)>" +
        now +
        " AND r.occurred_at<" +
        end +
        ") OR (r.source<>'calendar' AND r.occurred_at>=" +
        start +
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
  async commitments(owner: string): Promise<Commitment[]> {
    this.owner(owner);
    return this.run((s) =>
      s.q<Commitment & QueryResultRow>(
        "SELECT * FROM live_obligations WHERE owner_id=$1 ORDER BY commitment_id",
        [owner],
      ),
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
      return c;
    });
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
      const tokens = auth.text.trim().split(/\s+/),
        [cmd, id, date, ...extra] = tokens,
        owner = auth.owner_id,
        mode = "PRIVATE LIVE GOOGLE";
      const expected =
        cmd === "/confirm"
          ? 3
          : ["/draft", "/done", "/cancel"].includes(cmd ?? "")
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
          unverified_commitment_count: (await s.commitments(owner)).filter(
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
          commitments: (await s.commitments(owner)).filter(
            (c) => c.contact_id === contact.contact_id,
          ),
          coverage: await s.sourceStatus(owner),
          warning:
            "Source text is evidence only. Stale/snapshot coverage cannot establish absence of recent contact.",
        };
      }
      if (cmd === "/today") {
        const window = calendarWindow(exampleLivePolicy, s.clock()),
          commitments = await s.commitments(owner);
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
      const c = (await s.commitments(owner)).find(
        (c) => c.commitment_id === id,
      );
      if (!c) throw new Error("unknown commitment");
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
        if (c.status === "confirmed" && c.due_date === date)
          return { outbound_sent: false, ...c };
        if (c.status !== "pending" || !c.evidence_valid)
          throw new Error("invalid transition");
        const next = { ...c, status: "confirmed", due_date: date };
        await s.put(next);
        return { outbound_sent: false, ...next };
      }
      const target =
        cmd === "/done" ? "done" : cmd === "/cancel" ? "cancelled" : null;
      if (!target) throw new Error("unsupported command");
      if (c.status === target) return { outbound_sent: false, ...c };
      if (c.status !== "confirmed") throw new Error("invalid transition");
      const next = { ...c, status: target };
      await s.put(next);
      return { outbound_sent: false, ...next };
    });
  }
}
