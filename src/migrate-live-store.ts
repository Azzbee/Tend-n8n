import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolConfig, type PoolClient } from "pg";
import type { Principal } from "./live-store.ts";
import type { NormalizedRecord, Commitment } from "./engine.ts";
export interface MigrationProof {
  counts: Record<string, number>;
  hashes: Record<string, string>;
  verified: true;
}
const tables = [
  "contacts",
  "identities",
  "live_sources",
  "interactions",
  "commitments",
  "live_quarantines",
  "live_sync_seen",
  "live_extraction_attempts",
  "live_telegram_updates",
] as const;
type Table = (typeof tables)[number];
type Row = Record<string, unknown>;
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
}
function digest(rows: Row[]): string {
  return createHash("sha256")
    .update(JSON.stringify(rows.map((r) => JSON.stringify(stable(r))).sort()))
    .digest("hex");
}
async function insert(
  client: PoolClient,
  table: string,
  row: Row,
): Promise<void> {
  const keys = Object.keys(row);
  if (!/^[a-z_]+$/.test(table) || keys.some((k) => !/^[a-z_]+$/.test(k)))
    throw new Error("invalid migration schema");
  await client.query(
    `INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map((_, i) => "$" + (i + 1)).join(",")})`,
    keys.map((k) =>
      ["authored_spans", "state", "reply_data"].includes(k)
        ? JSON.stringify(row[k])
        : row[k],
    ),
  );
}
function converted(table: Table, row: Row): Row {
  if (table === "live_sources")
    return {
      owner_id: row.owner_id,
      source: row.source,
      account_id: row.account_id,
      state: JSON.parse(String(row.data)) as unknown,
    };
  if (table === "interactions") {
    const r = JSON.parse(String(row.data)) as NormalizedRecord;
    return {
      ...r,
      contact_id: r.contact_id || null,
      contact_ids: r.contact_ids ?? [],
      authored_text: r.authored_text ?? "",
      authored_spans: r.authored_spans ?? [],
      attribution: r.attribution ?? "unknown",
      eligible_for_extraction: r.eligible_for_extraction ?? false,
      end_at: r.end_at ?? null,
      all_day: r.all_day ?? null,
    };
  }
  if (table === "commitments")
    return { ...(JSON.parse(String(row.data)) as Commitment) };
  if (table === "live_telegram_updates")
    return {
      ...row,
      reply_data: JSON.parse(String(row.reply_data)) as unknown,
    };
  return row;
}
const target: Record<Table, string> = {
  contacts: "live_contacts",
  identities: "live_identities",
  live_sources: "live_accounts",
  interactions: "live_records",
  commitments: "live_obligations",
  live_quarantines: "live_review_quarantines",
  live_sync_seen: "live_seen",
  live_extraction_attempts: "live_attempts",
  live_telegram_updates: "live_reply_ledger",
};
/** Requires paused writers and an empty target; it never changes the source checkpoint. */
export async function migrateLiveStore(
  sourcePath: string,
  config: PoolConfig,
  principal: Principal,
): Promise<MigrationProof> {
  if (
    sourcePath === ":memory:" ||
    !Object.values(principal).every((x) => typeof x === "string" && x.trim())
  )
    throw new Error("checkpoint and principal required");
  const source = new DatabaseSync(sourcePath, { readOnly: true }),
    pool = new Pool(config);
  let client: PoolClient | undefined;
  try {
    source.exec("BEGIN");
    const binding = source
      .prepare("SELECT mode,principal_id FROM store_metadata WHERE singleton=1")
      .get();
    if (binding?.mode !== "live" || binding.principal_id !== principal.owner_id)
      throw new Error("checkpoint principal mismatch");
    if (source.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
      throw new Error("checkpoint integrity failure");
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(
      readFileSync(
        new URL("../schema/002-live-runtime.sql", import.meta.url),
        "utf8",
      ),
    );
    await client.query(
      "INSERT INTO live_runtime_principal VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [principal.owner_id, principal.user_id, principal.chat_id],
    );
    const bindingPg = (
      await client.query<{ user_id: string; chat_id: string }>(
        "SELECT user_id,chat_id FROM live_runtime_principal WHERE owner_id=$1 FOR UPDATE",
        [principal.owner_id],
      )
    ).rows[0];
    if (
      bindingPg?.user_id !== principal.user_id ||
      bindingPg.chat_id !== principal.chat_id
    )
      throw new Error("target principal mismatch");
    for (const table of tables)
      if (
        Number(
          (
            await client.query<{ n: string }>(
              `SELECT count(*) n FROM ${target[table]} WHERE owner_id=$1`,
              [principal.owner_id],
            )
          ).rows[0]!.n,
        ) !== 0
      )
        throw new Error("migration target is not empty");
    const counts: Record<string, number> = {},
      hashes: Record<string, string> = {};
    for (const table of tables) {
      const expected: Row[] = [];
      for (const raw of source
        .prepare(`SELECT * FROM ${table} WHERE owner_id=?`)
        .iterate(principal.owner_id)) {
        const row = converted(table, raw);
        expected.push(row);
        await insert(client, target[table], row);
        if (table === "interactions")
          for (const id of row.contact_ids as string[])
            await insert(client, "live_interaction_contacts", {
              owner_id: principal.owner_id,
              record_key: row.record_key,
              contact_id: id,
            });
      }
      const actual = (
        await client.query<Row>(
          `SELECT * FROM ${target[table]} WHERE owner_id=$1`,
          [principal.owner_id],
        )
      ).rows.map((r) =>
        table === "live_telegram_updates"
          ? {
              ...r,
              update_id: Number(r.update_id),
              telegram_message_id:
                r.telegram_message_id === null
                  ? null
                  : Number(r.telegram_message_id),
            }
          : r,
      );
      if (
        actual.length !== expected.length ||
        digest(actual) !== digest(expected)
      )
        throw new Error(`migration parity failed: ${table}`);
      counts[table] = actual.length;
      hashes[table] = digest(actual);
    }
    await client.query("COMMIT");
    return { counts, hashes, verified: true };
  } catch (e) {
    if (client) await client.query("ROLLBACK");
    throw e;
  } finally {
    client?.release();
    source.close();
    await pool.end();
  }
}
