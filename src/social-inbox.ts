import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow,
} from "pg";
import { isRecord } from "./engine.ts";
import type { Principal } from "./live-store.ts";
import {
  normalizeMetaWebhook,
  verifyMetaSignature,
  type MessagingResult,
} from "./messaging-records.ts";
import {
  socialAccount,
  type BusinessWhatsAppAccount,
  type SocialPolicy,
} from "./social-policy.ts";

export interface FilteredMetaPayload {
  results: MessagingResult[];
  progress: { entries: number; changes: number; fields: string[] };
}
export interface SocialInboxReceipt {
  event_id: string;
  status: string;
  duplicate: boolean;
}
export interface SocialInboxLease {
  event_id: string;
  lease_id: string;
  payload: FilteredMetaPayload;
  lease_until: string;
}
export interface SocialInboxOptions extends PoolConfig {
  principal: Principal;
  policy: SocialPolicy;
  account_id: string;
  max_body_bytes: number;
  clock?: () => Date;
}
export class SocialInboxError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  constructor(code: string, status: number, retryable = false) {
    super(code);
    this.name = "SocialInboxError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}
interface QueueRow extends QueryResultRow {
  event_id: string;
  status: string;
  payload: FilteredMetaPayload;
  attempts: number;
}
const supportedFields = new Set(["messages", "history", "smb_message_echoes"]);
function boundEnvelope(
  value: unknown,
  account: BusinessWhatsAppAccount,
): FilteredMetaPayload["progress"] {
  if (
    !isRecord(value) ||
    value.object !== "whatsapp_business_account" ||
    !Array.isArray(value.entry) ||
    value.entry.length < 1 ||
    value.entry.length > 100
  )
    throw new SocialInboxError("invalid_envelope", 400);
  let changes = 0;
  const fields = new Set<string>();
  for (const entry of value.entry) {
    if (
      !isRecord(entry) ||
      entry.id !== account.account_id ||
      !Array.isArray(entry.changes) ||
      entry.changes.length < 1 ||
      entry.changes.length > 100
    )
      throw new SocialInboxError("foreign_or_invalid_account", 403);
    for (const change of entry.changes) {
      if (
        !isRecord(change) ||
        typeof change.field !== "string" ||
        !isRecord(change.value) ||
        !isRecord(change.value.metadata) ||
        change.value.metadata.phone_number_id !==
          account.business_phone_number_id
      )
        throw new SocialInboxError("foreign_or_invalid_phone", 403);
      fields.add(
        supportedFields.has(change.field) ? change.field : "unsupported",
      );
      changes++;
    }
  }
  return { entries: value.entry.length, changes, fields: [...fields].sort() };
}

export class SocialInbox {
  private readonly pool: Pool;
  private readonly principal: Principal;
  private readonly account: BusinessWhatsAppAccount;
  private readonly maxBodyBytes: number;
  private readonly clock: () => Date;
  private constructor(
    pool: Pool,
    options: SocialInboxOptions,
    account: BusinessWhatsAppAccount,
  ) {
    this.pool = pool;
    this.principal = { ...options.principal };
    this.account = account;
    this.maxBodyBytes = options.max_body_bytes;
    this.clock = options.clock ?? (() => new Date());
  }
  static async open(options: SocialInboxOptions): Promise<SocialInbox> {
    const { principal, policy, account_id, max_body_bytes, clock, ...config } =
      options;
    if (
      Object.values(principal).some(
        (item) => typeof item !== "string" || !item.trim(),
      ) ||
      !Number.isSafeInteger(max_body_bytes) ||
      max_body_bytes < 1 ||
      max_body_bytes > 1048576
    )
      throw new SocialInboxError("invalid_inbox_configuration", 400);
    const account = socialAccount(policy, "whatsapp_business", account_id);
    if (account.provider !== "meta" || account.source !== "whatsapp_business")
      throw new SocialInboxError("unapproved_meta_account", 403);
    const pool = new Pool(config);
    try {
      const binding = await pool.query<{ user_id: string; chat_id: string }>(
        "SELECT user_id,chat_id FROM live_runtime_principal WHERE owner_id=$1",
        [principal.owner_id],
      );
      if (
        binding.rows.length !== 1 ||
        binding.rows[0]?.user_id !== principal.user_id ||
        binding.rows[0]?.chat_id !== principal.chat_id
      )
        throw new SocialInboxError("principal_mismatch", 403);
      await pool.query(
        readFileSync(
          new URL("../schema/003-social-inbox.sql", import.meta.url),
          "utf8",
        ),
      );
      return new SocialInbox(
        pool,
        { ...options, clock: clock ?? (() => new Date()) },
        account,
      );
    } catch (error: unknown) {
      await pool.end();
      if (error instanceof SocialInboxError) throw error;
      throw new SocialInboxError("storage_unavailable", 503, true);
    }
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
  private now(): Date {
    const now = this.clock();
    if (!Number.isFinite(now.getTime()))
      throw new SocialInboxError("invalid_clock", 500);
    return now;
  }
  private async transaction<T>(
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect().catch(() => {
      throw new SocialInboxError("storage_unavailable", 503, true);
    });
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof SocialInboxError) throw error;
      throw new SocialInboxError("storage_unavailable", 503, true);
    } finally {
      client.release();
    }
  }
  private async source(client: PoolClient): Promise<void> {
    const owner = await client.query<{ user_id: string; chat_id: string }>(
      "SELECT user_id,chat_id FROM live_runtime_principal WHERE owner_id=$1 FOR UPDATE",
      [this.principal.owner_id],
    );
    if (
      owner.rows[0]?.user_id !== this.principal.user_id ||
      owner.rows[0]?.chat_id !== this.principal.chat_id
    )
      throw new SocialInboxError("principal_mismatch", 403);
    const row = await client.query<{
      state: { mode?: string; status?: string };
    }>(
      "SELECT state FROM live_accounts WHERE owner_id=$1 AND source='whatsapp_business' AND account_id=$2 FOR UPDATE",
      [this.principal.owner_id, this.account.account_id],
    );
    const state = row.rows[0]?.state;
    if (state?.status === "revoked")
      throw new SocialInboxError("source_revoked", 403);
    if (
      state?.mode !== "live" ||
      !["current", "partial", "stale"].includes(state.status ?? "")
    )
      throw new SocialInboxError("unregistered_live_account", 403);
  }
  async expire(): Promise<number> {
    return this.transaction(async (client) => {
      const result = await client.query<{ n: number }>(
        "SELECT expire_live_social_inbox($1,$2::timestamptz) AS n",
        [this.principal.owner_id, this.now()],
      );
      return result.rows[0]?.n ?? 0;
    });
  }
  /** Authenticate exact bytes, then retain only normalized evidence inside the approved window. */
  async acceptMeta(
    rawBody: Buffer,
    signature: string | undefined,
    secret: string,
  ): Promise<SocialInboxReceipt> {
    if (!Buffer.isBuffer(rawBody))
      throw new SocialInboxError("invalid_body", 400);
    if (rawBody.length > this.maxBodyBytes)
      throw new SocialInboxError("body_over_budget", 413);
    if (!verifyMetaSignature(rawBody, signature, secret))
      throw new SocialInboxError("invalid_signature", 403);
    let envelope: unknown;
    try {
      envelope = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(rawBody),
      ) as unknown;
    } catch {
      throw new SocialInboxError("invalid_json", 400);
    }
    const progress = boundEnvelope(envelope, this.account);
    const bodyHash = createHash("sha256").update(rawBody).digest("hex");
    const now = this.now();
    return this.transaction(async (client) => {
      await this.source(client);
      await client.query(
        "SELECT expire_live_social_inbox($1,$2::timestamptz)",
        [this.principal.owner_id, now],
      );
      const prior = await client.query<QueueRow>(
        "SELECT event_id,status FROM live_social_inbox WHERE owner_id=$1 AND account_id=$2 AND body_hash=$3",
        [this.principal.owner_id, this.account.account_id, bodyHash],
      );
      if (prior.rows[0])
        return {
          event_id: prior.rows[0].event_id,
          status: prior.rows[0].status,
          duplicate: true,
        };
      const count = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM live_social_inbox WHERE owner_id=$1 AND account_id=$2 AND status IN ('pending','leased')",
        [this.principal.owner_id, this.account.account_id],
      );
      if (Number(count.rows[0]?.n) >= 500)
        throw new SocialInboxError("inbox_full", 503, true);
      const original = await client.query<{
        source_record_id: string;
        occurred_at: string;
      }>(
        "SELECT source_record_id,occurred_at FROM live_records WHERE owner_id=$1 AND source='whatsapp_business' AND account_id=$2",
        [this.principal.owner_id, this.account.account_id],
      );
      const results = normalizeMetaWebhook(envelope, {
        principal_id: this.principal.owner_id,
        account_id: this.account.account_id,
        owner_identity: this.account.owner_identity,
        now,
        authenticated: {
          provider: "meta",
          account_id: this.account.account_id,
        },
        business_phone_number_id: this.account.business_phone_number_id,
        max_body_bytes: Math.min(this.maxBodyBytes, 262144),
        original_message_times: Object.fromEntries(
          original.rows.map((row) => [row.source_record_id, row.occurred_at]),
        ),
      });
      let expires = now.getTime() + 86400000;
      for (const result of results)
        if (result.kind === "accepted")
          expires = Math.min(
            expires,
            Date.parse(result.record.occurred_at) + 30 * 86400000,
          );
      const payload: FilteredMetaPayload = { results, progress };
      const encoded = JSON.stringify(payload);
      if (Buffer.byteLength(encoded, "utf8") > this.maxBodyBytes)
        throw new SocialInboxError("filtered_payload_over_budget", 413);
      await client.query(
        "INSERT INTO live_social_inbox(owner_id,account_id,event_id,body_hash,payload,received_at,expires_at,status,available_at) VALUES($1,$2,$3,$3,$4::jsonb,$5,$6,'pending',$5)",
        [
          this.principal.owner_id,
          this.account.account_id,
          bodyHash,
          encoded,
          now,
          new Date(expires),
        ],
      );
      return { event_id: bodyHash, status: "pending", duplicate: false };
    });
  }
  async claim(leaseSeconds = 60): Promise<SocialInboxLease | null> {
    if (
      !Number.isSafeInteger(leaseSeconds) ||
      leaseSeconds < 1 ||
      leaseSeconds > 300
    )
      throw new SocialInboxError("invalid_lease", 400);
    const now = this.now();
    return this.transaction(async (client) => {
      await this.source(client);
      await client.query(
        "SELECT expire_live_social_inbox($1,$2::timestamptz)",
        [this.principal.owner_id, now],
      );
      await client.query(
        "UPDATE live_social_inbox SET status='failed',payload=NULL,lease_id=NULL,lease_until=NULL,finished_at=$3,needs_resync=true,error_code='retry_exhausted' WHERE owner_id=$1 AND account_id=$2 AND attempts>=5 AND status='leased' AND lease_until<=$3",
        [this.principal.owner_id, this.account.account_id, now],
      );
      const result = await client.query<QueueRow>(
        "SELECT event_id,payload,attempts FROM live_social_inbox WHERE owner_id=$1 AND account_id=$2 AND expires_at>$3 AND available_at<=$3 AND attempts<5 AND (status='pending' OR (status='leased' AND lease_until<=$3)) ORDER BY received_at,event_id LIMIT 1 FOR UPDATE SKIP LOCKED",
        [this.principal.owner_id, this.account.account_id, now],
      );
      const row = result.rows[0];
      if (!row) return null;
      const lease_id = randomUUID();
      const until = new Date(
        Math.min(now.getTime() + leaseSeconds * 1000, now.getTime() + 300000),
      );
      await client.query(
        "UPDATE live_social_inbox SET status='leased',attempts=attempts+1,lease_id=$4,lease_until=$5 WHERE owner_id=$1 AND account_id=$2 AND event_id=$3",
        [
          this.principal.owner_id,
          this.account.account_id,
          row.event_id,
          lease_id,
          until,
        ],
      );
      return {
        event_id: row.event_id,
        lease_id,
        lease_until: until.toISOString(),
        payload: row.payload,
      };
    });
  }
  private async leased(
    client: PoolClient,
    lease: Pick<SocialInboxLease, "event_id" | "lease_id">,
    now: Date,
  ): Promise<QueueRow> {
    const result = await client.query<QueueRow>(
      "SELECT event_id,payload,attempts FROM live_social_inbox WHERE owner_id=$1 AND account_id=$2 AND event_id=$3 AND status='leased' AND lease_id=$4 AND lease_until>$5 AND expires_at>$5 FOR UPDATE",
      [
        this.principal.owner_id,
        this.account.account_id,
        lease.event_id,
        lease.lease_id,
        now,
      ],
    );
    if (!result.rows[0]) throw new SocialInboxError("lease_lost", 409, true);
    return result.rows[0];
  }
  /** Trusted callback must perform SQL only on this client; its writes and the receipt commit together. */
  async complete(
    lease: Pick<SocialInboxLease, "event_id" | "lease_id">,
    consume: (
      client: PoolClient,
      payload: FilteredMetaPayload,
    ) => Promise<void>,
  ): Promise<void> {
    const now = this.now();
    await this.transaction(async (client) => {
      await this.source(client);
      const row = await this.leased(client, lease, now);
      await consume(client, row.payload);
      const finished = this.now();
      await this.leased(client, lease, finished);
      await client.query(
        "UPDATE live_social_inbox SET status='processed',payload=NULL,lease_id=NULL,lease_until=NULL,finished_at=$4,error_code=NULL WHERE owner_id=$1 AND account_id=$2 AND event_id=$3",
        [
          this.principal.owner_id,
          this.account.account_id,
          row.event_id,
          finished,
        ],
      );
    });
  }
  async fail(
    lease: Pick<SocialInboxLease, "event_id" | "lease_id">,
  ): Promise<void> {
    const now = this.now();
    await this.transaction(async (client) => {
      await this.source(client);
      const row = await this.leased(client, lease, now);
      const terminal = row.attempts >= 5;
      await client.query(
        "UPDATE live_social_inbox SET status=$4,payload=CASE WHEN $5 THEN NULL ELSE payload END,lease_id=NULL,lease_until=NULL,available_at=$6,finished_at=CASE WHEN $5 THEN $7::timestamptz ELSE NULL END,needs_resync=$5,error_code=$8 WHERE owner_id=$1 AND account_id=$2 AND event_id=$3",
        [
          this.principal.owner_id,
          this.account.account_id,
          row.event_id,
          terminal ? "failed" : "pending",
          terminal,
          new Date(
            now.getTime() + Math.min(60000, 1000 * 2 ** (row.attempts - 1)),
          ),
          now,
          terminal ? "retry_exhausted" : "consumer_failed",
        ],
      );
    });
  }
  async audit(): Promise<{
    pending: number;
    leased: number;
    processed: number;
    expired: number;
    revoked: number;
    failed: number;
    needs_resync: number;
  }> {
    const result = await this.pool.query<{
      status: string;
      n: string;
      resync: string;
    }>(
      "SELECT status,count(*) AS n,count(*) FILTER(WHERE needs_resync) AS resync FROM live_social_inbox WHERE owner_id=$1 AND account_id=$2 GROUP BY status",
      [this.principal.owner_id, this.account.account_id],
    );
    const summary = {
      pending: 0,
      leased: 0,
      processed: 0,
      expired: 0,
      revoked: 0,
      failed: 0,
      needs_resync: 0,
    };
    for (const row of result.rows) {
      if (Object.hasOwn(summary, row.status) && row.status !== "needs_resync")
        summary[row.status as Exclude<keyof typeof summary, "needs_resync">] =
          Number(row.n);
      summary.needs_resync += Number(row.resync);
    }
    return summary;
  }
}
