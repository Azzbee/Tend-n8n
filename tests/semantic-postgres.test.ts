import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import {
  LocalModelCoordinator,
  SemanticSearchService,
} from "../src/semantic-search.ts";
import type { NormalizedRecord, SourceState } from "../src/engine.ts";

const directory = mkdtempSync(join(tmpdir(), "tend-semantic-test-"));
const now = new Date("2026-10-20T10:00:00Z"),
  digest = "a".repeat(64),
  fingerprint = "b".repeat(64);
let pool: Pool;
let started = false;
function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000 });
  if (result.status !== 0)
    throw new Error(`${command} failed: ${result.stderr}`);
}
function hash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}
const state: SourceState = {
  owner_id: "owner",
  source: "gmail",
  account_id: "owner@example.invalid",
  mode: "live",
  status: "fresh",
  last_success: now.toISOString(),
  coverage_start: "2026-10-01T00:00:00Z",
  coverage_end: now.toISOString(),
  cursor: null,
};
async function record(
  key: string,
  body: string,
  owner = "owner",
): Promise<void> {
  await pool.query(
    `INSERT INTO live_records(owner_id,record_key,source,account_id,source_record_id,source_thread_id,kind,direction,actor_identity,participant_identities,occurred_at,observed_at,body_text,evidence_reference,ingestion_mode,coverage_start,coverage_end,cancelled,contact_id,content_hash,contact_ids,authored_text,authored_spans,attribution,eligible_for_extraction) VALUES($1,$2,'gmail','owner@example.invalid',$2,$2,'message','received','friend@example.invalid',ARRAY['friend@example.invalid'],'2026-10-19T10:00:00Z','2026-10-20T09:00:00Z',$3,'tend-source:fictional','live','2026-10-01T00:00:00Z','2026-10-20T10:00:00Z',false,'contact',$4,ARRAY['contact'],$3,'[]','direct',true)`,
    [owner, key, body, hash(body)],
  );
}
function vector(input: string): number[] {
  return Array.from({ length: 768 }, (_, i) =>
    i === (input.includes("backup") ? 1 : 0) ? 1 : 0,
  );
}
function service(
  options: {
    embed?: (text: string) => Promise<number[]>;
    freeBytes?: number;
    eligible?: (
      record: NormalizedRecord,
      states: SourceState[],
      now: Date,
    ) => boolean;
    scope?: string;
  } = {},
): SemanticSearchService {
  return new SemanticSearchService({
    owner: "owner",
    digest,
    pool,
    clock: () => now,
    scope: {
      fingerprint: options.scope ?? fingerprint,
      eligible:
        options.eligible ??
        ((r, s) =>
          r.owner_id === "owner" &&
          !r.cancelled &&
          s.some(
            (a) => a.account_id === r.account_id && a.status !== "revoked",
          )),
      expiresAt: () => new Date("2026-11-01T00:00:00Z"),
    },
    embedding: { embed: options.embed ?? (async (text) => vector(text)) },
    coordinator: new LocalModelCoordinator(),
    resources: async () => ({ freeBytes: options.freeBytes ?? 10 * 1024 ** 3 }),
  });
}
beforeAll(async () => {
  run("initdb", [
    "-D",
    join(directory, "data"),
    "-U",
    "semantic_test",
    "--auth-local=trust",
    "--auth-host=reject",
    "--no-locale",
    "--encoding=UTF8",
  ]);
  run("pg_ctl", [
    "-D",
    join(directory, "data"),
    "-l",
    join(directory, "postgres.log"),
    "-o",
    `-k ${directory} -h '' -p 19587 -F`,
    "-w",
    "start",
  ]);
  started = true;
  pool = new Pool({
    host: directory,
    port: 19587,
    user: "semantic_test",
    database: "postgres",
    max: 4,
  });
  await pool.query(
    readFileSync(
      new URL("../schema/002-live-runtime.sql", import.meta.url),
      "utf8",
    ),
  );
  await pool.query(
    readFileSync(
      new URL("../schema/004-semantic-search.sql", import.meta.url),
      "utf8",
    ),
  );
}, 30000);
afterAll(async () => {
  await pool?.end();
  if (started)
    run("pg_ctl", ["-D", join(directory, "data"), "-m", "fast", "-w", "stop"]);
  rmSync(directory, { recursive: true, force: true });
});
async function reset(): Promise<void> {
  await pool.query("TRUNCATE live_runtime_principal CASCADE");
  for (const owner of ["owner", "other"]) {
    await pool.query(
      "INSERT INTO live_runtime_principal VALUES($1,'user','chat')",
      [owner],
    );
    await pool.query(
      "INSERT INTO live_accounts VALUES($1,'gmail','owner@example.invalid',$2)",
      [owner, JSON.stringify({ ...state, owner_id: owner })],
    );
  }
}
async function indexAll(s: SemanticSearchService): Promise<void> {
  await s.initialiseSnapshot("owner");
  for (let i = 0; i < 20; i++) {
    const p = await s.indexBatch("owner");
    if (p.pending === 0) return;
  }
  throw new Error("fixture indexing did not finish");
}

describe("isolated PostgreSQL semantic index", () => {
  it("enables only available vector version and stores vectors without copying canonical text", async () => {
    await reset();
    await record("hotel", "We booked accommodation for the conference.");
    await record("backup", "The database backup is ready.");
    await record("private", "Other person's accommodation", "other");
    const s = service();
    await indexAll(s);
    expect(
      (
        await pool.query(
          "SELECT extversion FROM pg_extension WHERE extname='vector'",
        )
      ).rows[0]?.extversion,
    ).toBe("0.8.2");
    const progress = await s.progress("owner");
    expect(progress).toMatchObject({
      total: 2,
      complete: 2,
      pending: 0,
      state: "complete",
      passages: 2,
    });
    const result = await s.search({
      owner: "owner",
      query: "hotel reservations",
    });
    expect(result.hits.map((h) => h.record.record_key)).toEqual(["hotel"]);
    expect(result.hits[0]?.passage.text).toBe(
      "We booked accommodation for the conference.",
    );
    expect(
      (
        await pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name='live_semantic_chunks'",
        )
      ).rows.map((r) => r.column_name),
    ).not.toContain("body_text");
    await expect(s.search({ owner: "other", query: "hotel" })).rejects.toThrow(
      "unauthorized",
    );
  });
  it("resumes idempotently and freezes the initial watermark", async () => {
    await reset();
    await record("a", "Accommodation");
    await record("b", "Flights");
    const s = service();
    await s.initialiseSnapshot("owner");
    await s.indexBatch("owner");
    const resumed = service();
    await resumed.initialiseSnapshot("owner");
    await resumed.indexBatch("owner");
    await resumed.indexBatch("owner");
    expect(await resumed.progress("owner")).toMatchObject({
      total: 2,
      complete: 2,
      pending: 0,
      passages: 2,
    });
    await pool.query(
      "UPDATE live_records SET observed_at='2026-10-20T11:00:00Z' WHERE record_key='a'",
    );
    expect(
      (await resumed.search({ owner: "owner", query: "hotel" })).hits,
    ).toHaveLength(2);
    await expect(
      service({ scope: "c".repeat(64) }).initialiseSnapshot("owner"),
    ).rejects.toThrow("scope mismatch");
  });
  it("withdraws all derived passages on natural content edit, cancellation, deletion and source revoke", async () => {
    await reset();
    for (const key of ["edit", "cancel", "remove", "revoke"])
      await record(key, "Accommodation");
    const s = service();
    await indexAll(s);
    await pool.query(
      "UPDATE live_records SET body_text='changed',content_hash=$1 WHERE record_key='edit'",
      [hash("changed")],
    );
    await pool.query(
      "UPDATE live_records SET cancelled=true WHERE record_key='cancel'",
    );
    await pool.query("DELETE FROM live_records WHERE record_key='remove'");
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM live_semantic_chunks"))
        .rows[0]?.n,
    ).toBe(1);
    await pool.query(
      "UPDATE live_accounts SET state=jsonb_set(state,'{status}','\"revoked\"') WHERE owner_id='owner'",
    );
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM live_semantic_chunks"))
        .rows[0]?.n,
    ).toBe(0);
    expect(
      (await s.search({ owner: "owner", query: "hotel" })).hits,
    ).toHaveLength(0);
  });
  it("does not publish embeddings if a canonical record changes during inference", async () => {
    await reset();
    await record("race", "Accommodation");
    let changed = false;
    const s = service({
      embed: async (text) => {
        if (!changed) {
          changed = true;
          await pool.query(
            "UPDATE live_records SET body_text='changed',content_hash=$1 WHERE record_key='race'",
            [hash("changed")],
          );
        }
        return vector(text);
      },
    });
    await indexAll(s);
    expect(await s.progress("owner")).toMatchObject({
      complete: 0,
      withdrawn: 1,
      passages: 0,
    });
  });
  it("keeps a failed record pending, then can resume without changing canonical rows", async () => {
    await reset();
    await record("retry", "Accommodation");
    const failing = service({
      embed: async () => {
        throw new Error("offline");
      },
    });
    await failing.initialiseSnapshot("owner");
    await expect(failing.indexBatch("owner")).rejects.toThrow("offline");
    expect(await failing.progress("owner")).toMatchObject({
      pending: 1,
      complete: 0,
      state: "paused",
    });
    await service().indexBatch("owner");
    expect(await service().progress("owner")).toMatchObject({
      pending: 0,
      complete: 1,
      state: "complete",
    });
  });
  it("filters owner/contact/source/date before returning results and rechecks current eligibility", async () => {
    await reset();
    await record("eligible", "Accommodation");
    await indexAll(service());
    expect(
      (
        await service().search({
          owner: "owner",
          query: "hotel",
          sources: ["linkedin"],
        })
      ).hits,
    ).toHaveLength(0);
    expect(
      (
        await service().search({
          owner: "owner",
          query: "hotel",
          contactIds: ["missing"],
        })
      ).hits,
    ).toHaveLength(0);
    expect(
      (
        await service().search({
          owner: "owner",
          query: "hotel",
          from: "2026-10-20T00:00:00Z",
        })
      ).hits,
    ).toHaveLength(0);
    expect(
      (
        await service({ eligible: () => false }).search({
          owner: "owner",
          query: "hotel",
        })
      ).hits,
    ).toHaveLength(0);
    await pool.query(
      "UPDATE live_semantic_chunks SET expires_at='2026-10-20T09:59:59Z',created_at='2026-10-20T09:00:00Z'",
    );
    expect(
      (await service().search({ owner: "owner", query: "hotel" })).hits,
    ).toHaveLength(0);
  });
  it("pauses at the disk floor without deleting or replacing existing content", async () => {
    await reset();
    await record("floor", "Accommodation");
    const s = service({ freeBytes: 1024 ** 3 });
    await s.initialiseSnapshot("owner");
    await expect(s.indexBatch("owner")).rejects.toThrow("disk floor");
    expect(await s.progress("owner")).toMatchObject({
      state: "paused",
      pending: 1,
      reason: "semantic indexing paused: disk floor",
    });
    expect(
      (await pool.query("SELECT body_text FROM live_records")).rows[0]
        ?.body_text,
    ).toBe("Accommodation");
  });
  it("rolls a malformed migration back transactionally", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE TABLE semantic_rollback_probe(id integer)");
      await expect(
        client.query("SELECT vector_dims('[1,2]'::vector(768))"),
      ).rejects.toThrow();
      await client.query("ROLLBACK");
      expect(
        (
          await client.query(
            "SELECT to_regclass('semantic_rollback_probe') AS table",
          )
        ).rows[0]?.table,
      ).toBeNull();
    } finally {
      client.release();
    }
  });
  it("resumes a long record by passage after an interrupted batch and never calls it complete early", async () => {
    await reset();
    const text = "é😀 Accommodation ".repeat(150);
    await record("long", text);
    let calls = 0;
    const s = service({
      embed: async (input) => {
        if (++calls === 3) throw new Error("interrupted");
        return vector(input);
      },
    });
    await s.initialiseSnapshot("owner");
    await expect(s.indexBatch("owner")).rejects.toThrow("interrupted");
    expect(await s.progress("owner")).toMatchObject({
      pending: 1,
      complete: 0,
      partial: 1,
      passages: 2,
    });
    const resumed = service();
    for (let i = 0; i < 10; i++) {
      if ((await resumed.indexBatch("owner")).pending === 0) break;
    }
    expect(await resumed.progress("owner")).toMatchObject({
      pending: 0,
      complete: 1,
    });
    const passages = (
      await pool.query<{ passage_start: number; passage_end: number }>(
        "SELECT passage_start,passage_end FROM live_semantic_chunks ORDER BY passage_index",
      )
    ).rows;
    expect(
      passages.map((p) => text.slice(p.passage_start, p.passage_end)).join(""),
    ).toBe(text);
  });
  it("adds new and edited records after the fixed initial snapshot without re-embedding unchanged observations", async () => {
    await reset();
    await record("first", "Accommodation");
    const s = service();
    await indexAll(s);
    await record("new", "More accommodation");
    await pool.query(
      "UPDATE live_records SET observed_at='2026-10-20T09:59:00Z' WHERE record_key='first'",
    );
    expect(await s.refreshSnapshot("owner")).toMatchObject({
      total: 2,
      pending: 1,
      complete: 1,
      watermark: now.toISOString(),
    });
    await s.indexBatch("owner");
    expect(await s.progress("owner")).toMatchObject({
      total: 2,
      complete: 2,
      passages: 2,
    });
    await pool.query(
      "UPDATE live_records SET body_text='New accommodation',content_hash=$1 WHERE record_key='first'",
      [hash("New accommodation")],
    );
    await s.refreshSnapshot("owner");
    await s.indexBatch("owner");
    expect(await s.progress("owner")).toMatchObject({
      complete: 2,
      passages: 2,
    });
  });
  it("applies verified account/contact tuples before ranking", async () => {
    await reset();
    await record("one", "Accommodation");
    await indexAll(service());
    expect(
      (
        await service().search({
          owner: "owner",
          query: "hotel",
          accounts: [
            {
              source: "gmail",
              account_id: "other@example.invalid",
              contact_id: "contact",
            },
          ],
        })
      ).hits,
    ).toHaveLength(0);
    expect(
      (
        await service().search({
          owner: "owner",
          query: "hotel",
          accounts: [
            {
              source: "gmail",
              account_id: "owner@example.invalid",
              contact_id: "contact",
            },
          ],
        })
      ).hits,
    ).toHaveLength(1);
  });
});
