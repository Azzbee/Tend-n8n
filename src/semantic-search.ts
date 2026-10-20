import { createHash } from "node:crypto";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { NormalizedRecord, Source, SourceState } from "./engine.ts";

export const SEMANTIC_MODEL = "granite-embedding:278m";
export const SEMANTIC_DIMENSIONS = 768;
const GiB = 1024 ** 3;
const INDEX_BUDGET = 512 * 1024 ** 2;
export interface SemanticPassage {
  index: number;
  start: number;
  end: number;
  text: string;
}
export function splitSemanticPassages(
  text: string,
  maxCodePoints = 256,
): SemanticPassage[] {
  if (
    !Number.isInteger(maxCodePoints) ||
    maxCodePoints < 1 ||
    maxCodePoints > 512
  )
    throw new Error("invalid semantic passage bound");
  const result: SemanticPassage[] = [];
  let start = 0,
    end = 0,
    count = 0;
  for (const character of text) {
    end += character.length;
    if (++count === maxCodePoints) {
      result.push({
        index: result.length,
        start,
        end,
        text: text.slice(start, end),
      });
      start = end;
      count = 0;
    }
  }
  if (end > start)
    result.push({
      index: result.length,
      start,
      end,
      text: text.slice(start, end),
    });
  return result;
}
export function validateEmbedding(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== SEMANTIC_DIMENSIONS ||
    value.some(
      (x: unknown) =>
        typeof x !== "number" ||
        !Number.isFinite(x) ||
        !Number.isFinite(Math.fround(x)),
    ) ||
    !value.some((x: unknown) => typeof x === "number" && Math.fround(x) !== 0)
  )
    throw new Error("invalid 768-dimensional embedding");
  const numbers = value as number[];
  if (!Number.isFinite(Math.hypot(...numbers)))
    throw new Error("invalid embedding magnitude");
  return numbers;
}
export class EmbeddingContextError extends Error {
  constructor() {
    super("embedding context limit");
    this.name = "EmbeddingContextError";
  }
}
export interface EmbeddingClient {
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
}
async function boundedJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (length > maxBytes) throw new Error("embedding response exceeds bound");
  if (!response.body) throw new Error("empty embedding response");
  const reader = response.body.getReader(),
    pieces: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("embedding response exceeds bound");
      pieces.push(value);
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const piece of pieces) {
      buffer.set(piece, offset);
      offset += piece.byteLength;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(buffer),
    ) as unknown;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid embedding response");
  return value as Record<string, unknown>;
}
export class OllamaEmbeddingClient implements EmbeddingClient {
  readonly digest: string;
  private readonly fetcher: (
    input: string,
    init?: RequestInit,
  ) => Promise<Response>;
  constructor(options: {
    digest: string;
    fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  }) {
    if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(options.digest))
      throw new Error("full embedding model digest required");
    this.digest = options.digest.replace(/^sha256:/, "");
    this.fetcher = options.fetch ?? fetch;
  }
  async unload(signal?: AbortSignal): Promise<void> {
    const boundedSignal = AbortSignal.any([
      AbortSignal.timeout(10_000),
      ...(signal ? [signal] : []),
    ]);
    const response = await this.fetcher("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      redirect: "error",
      signal: boundedSignal,
      body: JSON.stringify({
        model: SEMANTIC_MODEL,
        prompt: "",
        keep_alive: 0,
        stream: false,
      }),
    });
    const body = object(await boundedJson(response, 4096));
    if (!response.ok || body.done !== true || body.done_reason !== "unload")
      throw new Error("embedding model unload failed");
  }
  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    if (!text.trim() || text.length > 4000)
      throw new Error("invalid embedding input");
    const boundedSignal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(signal ? [signal] : []),
    ]);
    boundedSignal.throwIfAborted();
    const tags = await this.fetcher("http://127.0.0.1:11434/api/tags", {
      signal: boundedSignal,
      redirect: "error",
    });
    if (!tags.ok) throw new Error("embedding model unavailable");
    const models = object(await boundedJson(tags, 64 * 1024)).models;
    if (
      !Array.isArray(models) ||
      !models.some((m: unknown) => {
        const value = object(m);
        return (
          value.name === SEMANTIC_MODEL &&
          typeof value.digest === "string" &&
          value.digest.replace(/^sha256:/, "") === this.digest
        );
      })
    )
      throw new Error("embedding model digest mismatch");
    const response = await this.fetcher("http://127.0.0.1:11434/api/embed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      redirect: "error",
      signal: boundedSignal,
      body: JSON.stringify({
        model: SEMANTIC_MODEL,
        input: text,
        truncate: false,
        keep_alive: "30s",
      }),
    });
    const value = object(await boundedJson(response, 64 * 1024));
    if (!response.ok) {
      if (
        response.status === 400 &&
        typeof value.error === "string" &&
        /(?:input (?:length |is )?(?:too long|exceeds)|exceeds (?:the )?context|context (?:length|window).*(?:exceed|limit))/i.test(
          value.error,
        )
      )
        throw new EmbeddingContextError();
      throw new Error(`embedding request failed (${response.status})`);
    }
    if (value.model !== undefined && value.model !== SEMANTIC_MODEL)
      throw new Error("embedding model mismatch");
    if (!Array.isArray(value.embeddings) || value.embeddings.length !== 1)
      throw new Error("one embedding required");
    return validateEmbedding(value.embeddings[0]);
  }
}
export interface EmbeddedPassage extends SemanticPassage {
  embedding: number[];
}
export async function embedPassages(
  text: string,
  client: EmbeddingClient,
  signal: AbortSignal,
): Promise<EmbeddedPassage[]> {
  if (text.length > 1_048_576)
    throw new Error("semantic record exceeds input bound");
  const pending = splitSemanticPassages(text),
    result: EmbeddedPassage[] = [];
  while (pending.length) {
    signal.throwIfAborted();
    const passage = pending.shift();
    if (!passage) break;
    if (!passage.text.trim()) {
      // Whitespace still has a recorded passage and cannot drop the tail.
      const embedding = await client.embed("[whitespace]", signal);
      result.push({
        ...passage,
        index: result.length,
        embedding: validateEmbedding(embedding),
      });
      continue;
    }
    try {
      result.push({
        ...passage,
        index: result.length,
        embedding: validateEmbedding(await client.embed(passage.text, signal)),
      });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "EmbeddingContextError")
        throw error;
      const points = Array.from(passage.text);
      if (points.length < 2)
        throw new Error("embedding context cannot fit one code point", {
          cause: error,
        });
      const left = points.slice(0, Math.floor(points.length / 2)).join(""),
        middle = passage.start + left.length;
      pending.unshift(
        { ...passage, text: left, end: middle },
        { ...passage, text: passage.text.slice(left.length), start: middle },
      );
    }
    if (result.length + pending.length > 16_384)
      throw new Error("semantic passage count exceeds bound");
  }
  return result;
}
interface ModelWork {
  priority: "foreground" | "background";
  run: () => Promise<void>;
  reject: (error: Error) => void;
  signal?: AbortSignal;
}
export class LocalModelCoordinator {
  private active = false;
  private readonly queue: ModelWork[] = [];
  private readonly maxQueue: number;
  constructor(maxQueue = 16) {
    this.maxQueue = maxQueue;
    if (!Number.isInteger(maxQueue) || maxQueue < 1 || maxQueue > 64)
      throw new Error("invalid model queue bound");
  }
  run<T>(
    priority: "foreground" | "background",
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted)
      return Promise.reject(new Error("model request cancelled"));
    if (this.queue.length >= this.maxQueue)
      return Promise.reject(new Error("local model queue full"));
    return new Promise<T>((resolve, reject) => {
      const work: ModelWork = {
        priority,
        ...(signal ? { signal } : {}),
        reject,
        run: async () => {
          try {
            resolve(await operation());
          } catch (error) {
            reject(error);
          }
        },
      };
      const abort = (): void => {
        const index = this.queue.indexOf(work);
        if (index >= 0) {
          this.queue.splice(index, 1);
          reject(new Error("model request cancelled"));
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      const original = work.run;
      work.run = async () => {
        signal?.removeEventListener("abort", abort);
        await original();
      };
      this.queue.push(work);
      this.drain();
    });
  }
  private drain(): void {
    if (this.active) return;
    const foreground = this.queue.findIndex((x) => x.priority === "foreground"),
      index = foreground < 0 ? 0 : foreground;
    const work = this.queue.splice(index, 1)[0];
    if (!work) return;
    if (work.signal?.aborted) {
      work.reject(new Error("model request cancelled"));
      this.drain();
      return;
    }
    this.active = true;
    void work.run().finally(() => {
      this.active = false;
      this.drain();
    });
  }
}

export interface SemanticFilter {
  owner: string;
  query: string;
  contactIds?: string[];
  accounts?: { source: Source; account_id: string; contact_id?: string }[];
  sources?: Source[];
  from?: string;
  to?: string;
  limit?: number;
  signal?: AbortSignal;
}
export interface SemanticHit {
  record: NormalizedRecord;
  passage: { start: number; end: number; text: string };
  similarity: number;
}
export interface SemanticProgress {
  watermark: string | null;
  total: number;
  complete: number;
  withdrawn: number;
  pending: number;
  passages: number;
  partial?: number;
  state: "not_started" | "indexing" | "complete" | "paused";
  reason: string | null;
}
export interface SemanticSearchResult {
  mode: "semantic";
  hits: SemanticHit[];
  coverage: SemanticProgress;
  duration_ms: number;
}
export interface SemanticScope {
  fingerprint: string;
  eligible: (
    record: NormalizedRecord,
    states: SourceState[],
    now: Date,
  ) => boolean;
  expiresAt: (record: NormalizedRecord, now: Date) => Date;
}
export interface SemanticServiceOptions {
  owner: string;
  digest: string;
  scope: SemanticScope;
  pool: Pool;
  embedding: EmbeddingClient;
  coordinator: LocalModelCoordinator;
  resources: () => Promise<{ freeBytes: number; indexBytes?: number }>;
  clock?: () => Date;
}
interface SnapshotRow {
  record_key: string;
  content_hash: string;
  status: string;
}
interface ChunkRow {
  record_key: string;
  content_hash: string;
  passage_start: number;
  passage_end: number;
  distance: number;
}
const digestText = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
export class SemanticSearchService {
  private readonly options: SemanticServiceOptions;
  private readonly clock: () => Date;
  private readonly digest: string;
  private indexing = false;
  constructor(options: SemanticServiceOptions) {
    if (
      !options.owner.trim() ||
      !/^(?:sha256:)?[a-f0-9]{64}$/.test(options.digest) ||
      !/^[a-f0-9]{64}$/.test(options.scope.fingerprint)
    )
      throw new Error("semantic owner/model/scope required");
    this.options = options;
    this.clock = options.clock ?? (() => new Date());
    this.digest = options.digest.replace(/^sha256:/, "");
  }
  static pool(config: PoolConfig): Pool {
    return new Pool(config);
  }
  private owner(owner: string): void {
    if (owner !== this.options.owner)
      throw new Error("unauthorized semantic owner");
  }
  private async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
    fixedSnapshot = false,
  ): Promise<T> {
    const client = await this.options.pool.connect();
    try {
      await client.query(
        fixedSnapshot ? "BEGIN ISOLATION LEVEL REPEATABLE READ" : "BEGIN",
      );
      await client.query("SET LOCAL statement_timeout='15s'");
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('tend-semantic-index'))",
      );
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  private async states(client: PoolClient): Promise<SourceState[]> {
    return (
      await client.query<{ state: SourceState }>(
        "SELECT state FROM live_accounts WHERE owner_id=$1 ORDER BY source,account_id FOR SHARE",
        [this.options.owner],
      )
    ).rows.map((r) => r.state);
  }
  private async binding(client: PoolClient): Promise<void> {
    const row = (
      await client.query<{ model_digest: string; scope_fingerprint: string }>(
        "SELECT model_digest,scope_fingerprint FROM live_semantic_snapshots WHERE owner_id=$1 FOR UPDATE",
        [this.options.owner],
      )
    ).rows[0];
    if (
      row &&
      (row.model_digest !== this.digest ||
        row.scope_fingerprint !== this.options.scope.fingerprint)
    )
      throw new Error(
        "semantic index model/scope mismatch; deliberate reindex required",
      );
  }
  async initialiseSnapshot(
    owner: string,
    watermark = this.clock().toISOString(),
  ): Promise<SemanticProgress> {
    this.owner(owner);
    if (
      !Number.isFinite(Date.parse(watermark)) ||
      Date.parse(watermark) > this.clock().getTime()
    )
      throw new Error("invalid semantic watermark");
    await this.transaction(async (client) => {
      await this.binding(client);
      const current = (
        await client.query<{ state: string }>(
          "SELECT state FROM live_semantic_snapshots WHERE owner_id=$1",
          [owner],
        )
      ).rows[0];
      if (current) return;
      const states = await this.states(client),
        now = this.clock();
      await client.query(
        "INSERT INTO live_semantic_snapshots(owner_id,model_digest,scope_fingerprint,watermark,state) VALUES($1,$2,$3,$4,'indexing')",
        [owner, this.digest, this.options.scope.fingerprint, watermark],
      );
      let after = "",
        total = 0;
      for (;;) {
        const rows = (
          await client.query<NormalizedRecord>(
            "SELECT * FROM live_records WHERE owner_id=$1 AND observed_at<=$2 AND record_key>$3 ORDER BY record_key LIMIT 500 FOR SHARE",
            [owner, watermark, after],
          )
        ).rows;
        if (!rows.length) break;
        for (const record of rows) {
          after = record.record_key;
          if (
            !record.body_text.trim() ||
            !this.options.scope.eligible(record, states, now)
          )
            continue;
          await client.query(
            "INSERT INTO live_semantic_snapshot_records(owner_id,record_key,content_hash,status) VALUES($1,$2,$3,'pending')",
            [owner, record.record_key, record.content_hash],
          );
          total++;
        }
      }
      await client.query(
        "UPDATE live_semantic_snapshots SET total_records=$2,state=CASE WHEN $2=0 THEN 'complete' ELSE 'indexing' END WHERE owner_id=$1",
        [owner, total],
      );
    }, true);
    return this.progress(owner);
  }
  async refreshSnapshot(owner: string): Promise<SemanticProgress> {
    this.owner(owner);
    await this.resources();
    await this.transaction(async (client) => {
      await this.binding(client);
      const snapshot = (
        await client.query<{ state: string }>(
          "SELECT state FROM live_semantic_snapshots WHERE owner_id=$1",
          [owner],
        )
      ).rows[0];
      if (!snapshot) throw new Error("semantic snapshot not initialised");
      if (
        (
          await client.query(
            "SELECT 1 FROM live_semantic_snapshot_records WHERE owner_id=$1 AND status='pending' LIMIT 1",
            [owner],
          )
        ).rowCount
      )
        return;
      const states = await this.states(client),
        now = this.clock();
      let after = "";
      for (;;) {
        const records = (
          await client.query<NormalizedRecord>(
            `SELECT r.* FROM live_records r LEFT JOIN live_semantic_snapshot_records s ON s.owner_id=r.owner_id AND s.record_key=r.record_key
          WHERE r.owner_id=$1 AND r.record_key>$2 AND r.observed_at<=$3
          AND (s.record_key IS NULL OR s.content_hash<>r.content_hash OR s.status='withdrawn' OR NOT EXISTS(SELECT 1 FROM live_semantic_chunks c WHERE c.owner_id=r.owner_id AND c.record_key=r.record_key AND c.expires_at>$3::timestamptz))
          ORDER BY r.record_key LIMIT 500 FOR SHARE OF r`,
            [owner, after, now.toISOString()],
          )
        ).rows;
        if (!records.length) break;
        for (const record of records) {
          after = record.record_key;
          if (
            !record.body_text.trim() ||
            !this.options.scope.eligible(record, states, now)
          )
            continue;
          await client.query(
            "INSERT INTO live_semantic_snapshot_records(owner_id,record_key,content_hash,status) VALUES($1,$2,$3,'pending') ON CONFLICT(owner_id,record_key) DO UPDATE SET content_hash=EXCLUDED.content_hash,status='pending'",
            [owner, record.record_key, record.content_hash],
          );
        }
      }
      await client.query(
        "UPDATE live_semantic_snapshot_records s SET status='withdrawn' WHERE s.owner_id=$1 AND s.status='complete' AND NOT EXISTS(SELECT 1 FROM live_semantic_chunks c WHERE c.owner_id=s.owner_id AND c.record_key=s.record_key AND c.expires_at>$2)",
        [owner, now.toISOString()],
      );
      await client.query(
        "UPDATE live_semantic_snapshots SET total_records=(SELECT count(*) FROM live_semantic_snapshot_records WHERE owner_id=$1),state=CASE WHEN EXISTS(SELECT 1 FROM live_semantic_snapshot_records WHERE owner_id=$1 AND status='pending') THEN 'indexing' ELSE 'complete' END,reason=NULL WHERE owner_id=$1",
        [owner],
      );
    });
    return this.progress(owner);
  }
  async progress(owner: string): Promise<SemanticProgress> {
    this.owner(owner);
    const result = (
      await this.options.pool.query<{
        watermark: Date;
        state: SemanticProgress["state"];
        reason: string | null;
        total_records: number;
        complete: string;
        withdrawn: string;
        pending: string;
        passages: string;
        partial: string;
      }>(
        `SELECT s.watermark,s.state,s.reason,s.total_records,
      (SELECT count(*) FROM live_semantic_snapshot_records r WHERE r.owner_id=s.owner_id AND r.status='complete' AND EXISTS(SELECT 1 FROM live_semantic_chunks c WHERE c.owner_id=r.owner_id AND c.record_key=r.record_key AND c.expires_at>$2)) AS complete,
      (SELECT count(*) FROM live_semantic_snapshot_records r WHERE r.owner_id=s.owner_id AND (r.status='withdrawn' OR (r.status='complete' AND NOT EXISTS(SELECT 1 FROM live_semantic_chunks c WHERE c.owner_id=r.owner_id AND c.record_key=r.record_key AND c.expires_at>$2)))) AS withdrawn,
      (SELECT count(*) FROM live_semantic_snapshot_records r WHERE r.owner_id=s.owner_id AND r.status='pending') AS pending,
      (SELECT count(*) FROM live_semantic_chunks c WHERE c.owner_id=s.owner_id AND c.expires_at>$2) AS passages,
      (SELECT count(*) FROM live_semantic_snapshot_records r WHERE r.owner_id=s.owner_id AND r.status='pending' AND EXISTS(SELECT 1 FROM live_semantic_chunks c WHERE c.owner_id=r.owner_id AND c.record_key=r.record_key AND c.expires_at>$2)) AS partial
      FROM live_semantic_snapshots s WHERE s.owner_id=$1`,
        [owner, this.clock().toISOString()],
      )
    ).rows[0];
    if (!result)
      return {
        watermark: null,
        total: 0,
        complete: 0,
        withdrawn: 0,
        pending: 0,
        passages: 0,
        state: "not_started",
        reason: null,
      };
    return {
      watermark: new Date(result.watermark).toISOString(),
      total: result.total_records,
      complete: Number(result.complete),
      withdrawn: Number(result.withdrawn),
      pending: Number(result.pending),
      passages: Number(result.passages),
      partial: Number(result.partial),
      state: result.state,
      reason: result.reason,
    };
  }
  private async resources(estimatedBytes = 0): Promise<void> {
    const stats = await this.options.resources();
    const bytes =
      stats.indexBytes ??
      Number(
        (
          await this.options.pool.query<{ bytes: string }>(
            "SELECT pg_total_relation_size('live_semantic_chunks')+pg_total_relation_size('live_semantic_snapshot_records') AS bytes",
          )
        ).rows[0]?.bytes,
      );
    if (
      !Number.isFinite(stats.freeBytes) ||
      stats.freeBytes < 2 * GiB + estimatedBytes
    )
      throw new Error("semantic indexing paused: disk floor");
    if (!Number.isFinite(bytes) || bytes + estimatedBytes > INDEX_BUDGET)
      throw new Error("semantic indexing paused: index budget");
  }
  async indexBatch(
    owner: string,
    signal?: AbortSignal,
  ): Promise<SemanticProgress> {
    this.owner(owner);
    if (this.indexing) throw new Error("semantic indexing already active");
    this.indexing = true;
    const boundedSignal = AbortSignal.any([
      AbortSignal.timeout(60_000),
      ...(signal ? [signal] : []),
    ]);
    try {
      await this.resources();
      await this.transaction(async (client) => {
        await this.binding(client);
        await client.query(
          "DELETE FROM live_semantic_chunks WHERE (owner_id,record_key,passage_index) IN (SELECT owner_id,record_key,passage_index FROM live_semantic_chunks WHERE owner_id=$1 AND expires_at<=$2 LIMIT 500)",
          [owner, this.clock().toISOString()],
        );
      });
      const pending = (
        await this.options.pool.query<SnapshotRow>(
          "SELECT record_key,content_hash,status FROM live_semantic_snapshot_records WHERE owner_id=$1 AND status='pending' ORDER BY record_key LIMIT 1",
          [owner],
        )
      ).rows[0];
      if (pending) {
        const record = (
          await this.options.pool.query<NormalizedRecord>(
            "SELECT * FROM live_records WHERE owner_id=$1 AND record_key=$2",
            [owner, pending.record_key],
          )
        ).rows[0];
        const states = (
          await this.options.pool.query<{ state: SourceState }>(
            "SELECT state FROM live_accounts WHERE owner_id=$1",
            [owner],
          )
        ).rows.map((r) => r.state);
        if (
          !record ||
          record.content_hash !== pending.content_hash ||
          !this.options.scope.eligible(record, states, this.clock())
        ) {
          await this.options.pool.query(
            "UPDATE live_semantic_snapshot_records SET status='withdrawn' WHERE owner_id=$1 AND record_key=$2 AND content_hash=$3",
            [owner, pending.record_key, pending.content_hash],
          );
        } else {
          if (record.body_text.length > 1_048_576)
            throw new Error("semantic record exceeds input bound");
          await this.options.pool.query(
            "DELETE FROM live_semantic_chunks WHERE owner_id=$1 AND record_key=$2 AND EXISTS(SELECT 1 FROM live_semantic_chunks expired WHERE expired.owner_id=$1 AND expired.record_key=$2 AND expired.expires_at<=$3)",
            [owner, record.record_key, this.clock().toISOString()],
          );
          const existing = (
            await this.options.pool.query<{
              passage_end: number;
              passage_index: number;
            }>(
              "SELECT passage_end,passage_index FROM live_semantic_chunks WHERE owner_id=$1 AND record_key=$2 AND content_hash=$3 AND model_digest=$4 AND scope_fingerprint=$5 AND expires_at>$6 ORDER BY passage_index DESC LIMIT 1",
              [
                owner,
                record.record_key,
                record.content_hash,
                this.digest,
                this.options.scope.fingerprint,
                this.clock().toISOString(),
              ],
            )
          ).rows[0];
          let offset = existing?.passage_end ?? 0,
            nextIndex = (existing?.passage_index ?? -1) + 1;
          const units = splitSemanticPassages(
            record.body_text.slice(offset),
          ).slice(0, 4);
          for (const unit of units) {
            boundedSignal.throwIfAborted();
            const baseOffset = offset;
            const passages = await embedPassages(
              unit.text,
              {
                embed: (text, s) =>
                  this.options.coordinator.run(
                    "background",
                    () => this.options.embedding.embed(text, s),
                    s,
                  ),
              },
              boundedSignal,
            );
            const estimated = passages.length * 4096;
            await this.resources(estimated);
            const accepted = await this.transaction(async (client) => {
              await this.binding(client);
              const currentStates = await this.states(client);
              const current = (
                await client.query<NormalizedRecord>(
                  "SELECT * FROM live_records WHERE owner_id=$1 AND record_key=$2 FOR SHARE",
                  [owner, record.record_key],
                )
              ).rows[0];
              const now = this.clock();
              if (
                !current ||
                current.content_hash !== record.content_hash ||
                current.body_text !== record.body_text ||
                !this.options.scope.eligible(current, currentStates, now)
              ) {
                await client.query(
                  "UPDATE live_semantic_snapshot_records SET status='withdrawn' WHERE owner_id=$1 AND record_key=$2",
                  [owner, record.record_key],
                );
                return false;
              }
              const size = Number(
                (
                  await client.query<{ bytes: string }>(
                    "SELECT pg_total_relation_size('live_semantic_chunks')+pg_total_relation_size('live_semantic_snapshot_records') AS bytes",
                  )
                ).rows[0]?.bytes,
              );
              if (!Number.isFinite(size) || size + estimated > INDEX_BUDGET)
                throw new Error("semantic indexing paused: index budget");
              const expires = this.options.scope.expiresAt(current, now);
              if (!Number.isFinite(expires.getTime()) || expires <= now)
                throw new Error("invalid semantic expiry");
              for (const passage of passages) {
                const start = baseOffset + passage.start,
                  end = baseOffset + passage.end;
                if (current.body_text.slice(start, end) !== passage.text)
                  throw new Error("semantic passage changed");
                await client.query(
                  `INSERT INTO live_semantic_chunks(owner_id,record_key,content_hash,passage_index,passage_start,passage_end,passage_hash,model_digest,scope_fingerprint,embedding,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector,$11,$12) ON CONFLICT(owner_id,record_key,passage_index) DO UPDATE SET content_hash=EXCLUDED.content_hash,passage_start=EXCLUDED.passage_start,passage_end=EXCLUDED.passage_end,passage_hash=EXCLUDED.passage_hash,model_digest=EXCLUDED.model_digest,scope_fingerprint=EXCLUDED.scope_fingerprint,embedding=EXCLUDED.embedding,created_at=EXCLUDED.created_at,expires_at=EXCLUDED.expires_at`,
                  [
                    owner,
                    current.record_key,
                    current.content_hash,
                    nextIndex + passage.index,
                    start,
                    end,
                    digestText(passage.text),
                    this.digest,
                    this.options.scope.fingerprint,
                    JSON.stringify(validateEmbedding(passage.embedding)),
                    now.toISOString(),
                    expires.toISOString(),
                  ],
                );
              }
              const last = passages.at(-1);
              if (last && baseOffset + last.end === current.body_text.length)
                await client.query(
                  "UPDATE live_semantic_snapshot_records SET status='complete' WHERE owner_id=$1 AND record_key=$2 AND content_hash=$3",
                  [owner, current.record_key, current.content_hash],
                );
              return true;
            });
            if (!accepted) break;
            offset = baseOffset + unit.text.length;
            nextIndex += passages.length;
          }
        }
      }
      await this.options.pool.query(
        "UPDATE live_semantic_snapshots SET state=CASE WHEN EXISTS(SELECT 1 FROM live_semantic_snapshot_records r WHERE r.owner_id=$1 AND r.status='pending') THEN 'indexing' ELSE 'complete' END,reason=NULL WHERE owner_id=$1",
        [owner],
      );
      return await this.progress(owner);
    } catch (error) {
      await this.options.pool.query(
        "UPDATE live_semantic_snapshots SET state='paused',reason=$2 WHERE owner_id=$1",
        [
          owner,
          error instanceof Error &&
          /disk floor|index budget/.test(error.message)
            ? error.message
            : "semantic inference/index unavailable",
        ],
      );
      throw error;
    } finally {
      this.indexing = false;
    }
  }
  async search(input: SemanticFilter): Promise<SemanticSearchResult> {
    this.owner(input.owner);
    if (
      !input.query.trim() ||
      input.query.length > 500 ||
      (input.limit !== undefined &&
        (!Number.isInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 30)) ||
      (input.contactIds &&
        (input.contactIds.length > 20 ||
          input.contactIds.some((x) => !x || x.length > 128))) ||
      (input.accounts &&
        (input.accounts.length > 20 ||
          input.accounts.some(
            (a) =>
              !a.account_id ||
              a.account_id.length > 1024 ||
              ![
                "gmail",
                "calendar",
                "whatsapp_personal",
                "whatsapp_business",
                "linkedin",
              ].includes(a.source) ||
              (a.contact_id !== undefined &&
                (!a.contact_id || a.contact_id.length > 128)),
          ))) ||
      (input.sources &&
        (input.sources.length > 5 ||
          input.sources.some(
            (x) =>
              ![
                "gmail",
                "calendar",
                "whatsapp_personal",
                "whatsapp_business",
                "linkedin",
              ].includes(x),
          ))) ||
      (input.from !== undefined &&
        input.to !== undefined &&
        Date.parse(input.from) > Date.parse(input.to)) ||
      [input.from, input.to].some(
        (d) => d !== undefined && !Number.isFinite(Date.parse(d)),
      )
    )
      throw new Error("invalid semantic search");
    const start = performance.now(),
      now = this.clock(),
      limit = input.limit ?? 10;
    const signal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(input.signal ? [input.signal] : []),
    ]);
    const vector = await this.options.coordinator.run(
      "foreground",
      () => this.options.embedding.embed(input.query, signal),
      signal,
    );
    const hits = await this.transaction(async (client) => {
      await this.binding(client);
      const states = await this.states(client);
      // Current owner/hash/account/date/contact predicates are applied before vector ranking.
      const candidates = (
        await client.query<ChunkRow>(
          `SELECT * FROM (SELECT DISTINCT ON (ranked.record_key) ranked.* FROM (
        SELECT c.record_key,c.content_hash,c.passage_start,c.passage_end,(c.embedding <=> $2::vector) AS distance
        FROM live_semantic_chunks c JOIN live_records r ON r.owner_id=c.owner_id AND r.record_key=c.record_key AND r.content_hash=c.content_hash
        JOIN live_accounts a ON a.owner_id=r.owner_id AND a.source=r.source AND a.account_id=r.account_id
        WHERE c.owner_id=$1 AND c.model_digest=$3 AND c.scope_fingerprint=$4 AND c.expires_at>$5 AND NOT r.cancelled AND a.state->>'status'<>'revoked'
        AND ($6::text[] IS NULL OR r.contact_id=ANY($6) OR r.contact_ids && $6)
        AND ($7::text[] IS NULL OR r.source=ANY($7))
        AND ($8::text IS NULL OR r.occurred_at >= $8) AND ($9::text IS NULL OR r.occurred_at <= $9)
        AND ($10::jsonb IS NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements($10::jsonb) allowed WHERE allowed->>'source'=r.source AND allowed->>'account_id'=r.account_id AND (NOT allowed ? 'contact_id' OR r.contact_id=allowed->>'contact_id' OR allowed->>'contact_id'=ANY(r.contact_ids))))
      ) ranked ORDER BY ranked.record_key,ranked.distance) distinct_records WHERE distance<=0.35 ORDER BY distance,record_key LIMIT 500`,
          [
            input.owner,
            JSON.stringify(validateEmbedding(vector)),
            this.digest,
            this.options.scope.fingerprint,
            now.toISOString(),
            input.contactIds ?? null,
            input.sources ?? null,
            input.from ? new Date(input.from).toISOString() : null,
            input.to ? new Date(input.to).toISOString() : null,
            input.accounts ? JSON.stringify(input.accounts) : null,
          ],
        )
      ).rows;
      const sorted = candidates.sort(
        (a, b) =>
          a.distance - b.distance || a.record_key.localeCompare(b.record_key),
      );
      const result: SemanticHit[] = [];
      for (const candidate of sorted) {
        if (candidate.distance > 0.35) break;
        signal.throwIfAborted();
        const record = (
          await client.query<NormalizedRecord>(
            "SELECT * FROM live_records WHERE owner_id=$1 AND record_key=$2 FOR SHARE",
            [input.owner, candidate.record_key],
          )
        ).rows[0];
        if (
          !record ||
          record.content_hash !== candidate.content_hash ||
          !this.options.scope.eligible(record, states, now)
        )
          continue;
        const passage = record.body_text.slice(
          candidate.passage_start,
          candidate.passage_end,
        );
        result.push({
          record,
          passage: {
            start: candidate.passage_start,
            end: candidate.passage_end,
            text: passage,
          },
          similarity: 1 - candidate.distance,
        });
        if (result.length >= limit) break;
      }
      return result;
    });
    return {
      mode: "semantic",
      hits,
      coverage: await this.progress(input.owner),
      duration_ms: Math.round(performance.now() - start),
    };
  }
}
