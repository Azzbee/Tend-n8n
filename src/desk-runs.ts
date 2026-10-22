import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import type { DeskWorkflowRun } from "./desk-model.ts";

// Last-run status for How it runs, read from n8n's insights tables. Read-only, no new secrets,
// names only: the reader never sees execution data, and live workflow IDs never leave the container.
export interface RunRow {
  name: string;
  last_success: string | null;
  last_failure: string | null;
}
export type RunRunner = (script: string, timeoutMs: number) => Promise<string>;

// n8n insights types: 0 time saved, 1 runtime, 2 success, 3 failure (checked against tend-nocode-live:
// types 2 and 3 add up to the runtime count). Raw rows are compacted into periods, so both are read.
export const insightsScript = (dbPath: string): string => `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(${JSON.stringify(dbPath)}, { readOnly: true });
const rows = db.prepare(\`
  SELECT m.workflowName AS name,
    MAX(CASE WHEN x.type = 2 THEN x.at END) AS last_success,
    MAX(CASE WHEN x.type = 3 THEN x.at END) AS last_failure
  FROM insights_metadata m
  JOIN (
    SELECT metaId, type, timestamp AS at FROM insights_raw WHERE type IN (2, 3)
    UNION ALL
    SELECT metaId, type, periodStart AS at FROM insights_by_period WHERE type IN (2, 3) AND value > 0
  ) x ON x.metaId = m.metaId
  GROUP BY m.metaId\`).all();
db.close();
process.stdout.write(JSON.stringify(rows));
`;

export function dockerRunner(container: string): RunRunner {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(container))
    throw new Error("Invalid n8n container name");
  return (script, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(
        "docker",
        ["exec", container, "node", "--no-warnings", "-e", script],
        { timeout: timeoutMs, maxBuffer: 1 << 20, encoding: "utf8" },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
}

// The live editor runs the social read pages 17-19 as scheduled pollers under these names
// (same node shapes as the exports; checked read-only on 22 Oct).
export const deployedWorkflowNames: Record<string, string> = {
  "Tend private scheduled personal bounded polling": "17",
  "Tend private scheduled linkedin bounded polling": "18",
  "Tend private scheduled business bounded polling": "19",
};
// Exported workflow names map to catalog IDs; probes and copies with other names are ignored.
export function exportedWorkflowNames(dir = "workflows"): Map<string, string> {
  const names = new Map<string, string>(Object.entries(deployedWorkflowNames));
  for (const file of readdirSync(dir))
    if (/^\d\d-.*\.json$/.test(file)) {
      const value: unknown = JSON.parse(readFileSync(`${dir}/${file}`, "utf8"));
      const name =
        value !== null && typeof value === "object" && "name" in value
          ? value.name
          : null;
      if (typeof name === "string") names.set(name, file.slice(0, 2));
    }
  return names;
}

const instant = (value: unknown): number | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  // SQLite stores insights timestamps as UTC without a zone.
  const parsed = Date.parse(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text)
      ? text.replace(" ", "T") + "Z"
      : text,
  );
  return Number.isFinite(parsed) ? parsed : null;
};

export function runsFromRows(
  rows: unknown,
  names: Map<string, string>,
): DeskWorkflowRun[] {
  if (!Array.isArray(rows)) throw new Error("Unexpected insights output");
  const latest = new Map<string, { at: number; status: "success" | "error" }>();
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const { name, last_success, last_failure } = row as Record<string, unknown>;
    const id = typeof name === "string" ? names.get(name) : undefined;
    if (!id) continue;
    for (const [at, status] of [
      [instant(last_success), "success"],
      [instant(last_failure), "error"],
    ] as const)
      if (at !== null && at > (latest.get(id)?.at ?? -Infinity))
        latest.set(id, { at, status });
  }
  return [...latest].map(([id, run]) => ({
    id,
    name: id,
    lane: "private",
    last_status: run.status,
    last_run_at: new Date(run.at).toISOString(),
  }));
}

export function createWorkflowRunsReader(options: {
  run: RunRunner;
  names: Map<string, string>;
  dbPath?: string;
  ttlMs?: number;
  timeoutMs?: number;
  clock?: () => number;
}): () => Promise<DeskWorkflowRun[]> {
  const ttl = options.ttlMs ?? 60_000,
    timeout = options.timeoutMs ?? 5_000,
    clock = options.clock ?? Date.now,
    script = insightsScript(
      options.dbPath ?? "/home/node/.n8n/database.sqlite",
    );
  let cached: { at: number; runs: DeskWorkflowRun[] } | null = null;
  let pending: Promise<DeskWorkflowRun[]> | null = null;
  return () => {
    if (cached && clock() - cached.at < ttl)
      return Promise.resolve(cached.runs);
    // One read at a time; failures are cached too so a broken container is not hammered.
    pending ??= options
      .run(script, timeout)
      .then((out) => runsFromRows(JSON.parse(out) as unknown, options.names))
      .catch(() => [] as DeskWorkflowRun[])
      .then((runs) => {
        cached = { at: clock(), runs };
        pending = null;
        return runs;
      });
    return pending;
  };
}
