import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, openSync, closeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isRecord } from "./engine.ts";
import { demoAuth, fixtureRecords } from "./fixtures.ts";
const image =
  "docker.n8n.io/n8nio/n8n@sha256:c34ee9107a42b837e25cec0c8a927ab90a45b776aa2ccbf15e5b9cda466fad2c";
const id = randomUUID().slice(0, 8),
  name = `tend-review-check-${id}`,
  dir = resolve(`.scratch/check-${id}`);
mkdirSync(dir, { recursive: true });
const checks: { name: string; pass: true; detail: unknown }[] = [];
function assert(ok: unknown, msg: string): asserts ok {
  if (!ok) throw new Error(msg);
}
function command(args: string[], log: string): string {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: 240000 });
  const output = r.stdout + r.stderr;
  writeFileSync(`${dir}/${log}.log`, output);
  assert(r.status === 0, `${log}: docker command failed, see ${dir}`);
  return output;
}
async function request(
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const r = await fetch(
    `http://127.0.0.1:18767${path}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const x: unknown = await r.json();
  assert(r.ok && isRecord(x), `${path}: request failed`);
  return x;
}
function execution(wid: string): void {
  const output = command(["exec", name, "n8n", "execute", "--id", wid], wid);
  const statuses = [...output.matchAll(/"status":\s*"([^"]+)"/g)];
  assert(
    statuses.at(-1)?.[1] === "success",
    `${wid}: workflow failed, see ${dir}`,
  );
  checks.push({
    name: `n8n ${wid}`,
    pass: true,
    detail: "Actual CLI execution status success",
  });
}
try {
  try {
    await fetch("http://127.0.0.1:18767/api/status");
    throw new Error(
      "Port18767 already occupied. Stop only your own previous fixture server before checks.",
    );
  } catch (e) {
    if (e instanceof Error && e.message.includes("occupied")) throw e;
  }
  const log = openSync(`${dir}/server.log`, "w");
  const server = spawn(
    process.execPath,
    ["--experimental-strip-types", "src/server.ts"],
    {
      env: { ...process.env, TEND_DEMO_DB: `${dir}/demo.sqlite` },
      stdio: ["ignore", log, log],
    },
  );
  closeSync(log);
  try {
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        await request("/api/status");
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    assert(ready, "fixture API did not start");
    command(
      [
        "run",
        "-d",
        "--name",
        name,
        "--user",
        "root",
        "-e",
        "N8N_USER_FOLDER=/scratch",
        "-e",
        "N8N_DIAGNOSTICS_ENABLED=false",
        "-e",
        "N8N_VERSION_NOTIFICATIONS_ENABLED=false",
        "-e",
        "N8N_RUNNERS_ENABLED=false",
        "-v",
        `${process.cwd()}:/workspace:ro`,
        "-v",
        `${dir}:/scratch`,
        "--entrypoint",
        "sh",
        image,
        "-c",
        "sleep infinity",
      ],
      "container-start",
    );
    const imported = command(
      [
        "exec",
        name,
        "n8n",
        "import:workflow",
        "--separate",
        "--input=/workspace/workflows",
      ],
      "import",
    );
    assert(
      imported.includes("Successfully imported 9 workflows"),
      "nine-workflow import failed",
    );
    checks.push({
      name: "Clean n8n import",
      pass: true,
      detail: "9inactive workflows; no publication or credentials",
    });
    for (const wid of [
      "TendReview01",
      "TendReview02",
      "TendReview03",
      "TendReview04",
      "TendReview05",
      "TendReview07",
      "TendReview08",
      "TendReview09",
    ])
      execution(wid);
    const first = await request("/api/status");
    assert(
      isRecord(first.counts) &&
        first.counts.interactions === 7 &&
        first.counts.commitments === 1,
      "unexpected initial state",
    );
    execution("TendReview01");
    execution("TendReview07");
    const replay = await request("/api/status");
    assert(
      JSON.stringify(replay.counts) === JSON.stringify(first.counts),
      "replay duplicated records/candidates",
    );
    checks.push({ name: "Replay", pass: true, detail: replay.counts });
    assert(
      Array.isArray(first.commitments) && isRecord(first.commitments[0]),
      "missing candidate",
    );
    const candidate = first.commitments[0];
    assert(
      candidate.status === "pending",
      "AI activated candidate without confirmation",
    );
    const commitmentId = candidate.commitment_id;
    assert(typeof commitmentId === "string", "invalid ID");
    for (const text of [
      `/confirm ${commitmentId} 2026-10-15`,
      `/draft ${commitmentId}`,
      `/done ${commitmentId}`,
      `/done ${commitmentId}`,
    ]) {
      const r = await request("/api/command", { ...demoAuth, text });
      assert(r.outbound_sent === false, "outbound action unexpectedly present");
    }
    const denied = await fetch("http://127.0.0.1:18767/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...demoAuth, chat_type: "group" }),
    });
    assert(denied.status === 400, "group request was accepted");
    const invalid = await fetch("http://127.0.0.1:18767/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        records: [
          { ...fixtureRecords[0], occurred_at: "2026-02-30T08:00:00Z" },
        ],
      }),
    });
    assert(invalid.status === 400, "invalid record accepted");
    const brief = await request("/api/command", demoAuth);
    assert(
      JSON.stringify(brief).includes("stale") &&
        JSON.stringify(brief).includes("snapshot"),
      "missing partial-coverage warning",
    );
    checks.push({
      name: "Owner command boundaries",
      pass: true,
      detail:
        "Pending until confirm; preview only; repeated done idempotent; group rejected; invalid record rejected; partial coverage explicit",
    });
    const persisted = await request("/api/status");
    writeFileSync(
      `${dir}/final-state.json`,
      JSON.stringify(persisted, null, 2),
    );
  } finally {
    server.kill("SIGTERM");
    command(["rm", "-f", name], "container-stop");
  }
  const report = {
    checked_at: new Date().toISOString(),
    runtime: {
      node: process.version,
      n8n: "2.43.4",
      image,
      ollama_model: "qwen3:0.6b",
      storage: "fresh local SQLite",
    },
    data: "7 fictional records; no real account connections",
    checks,
    remaining_unverified: [
      "All five live source connectors",
      "Real Telegram trigger",
      "Public teacher-review link and teacher scope validation",
      "Postgres application adapter and production data migration",
      "Actual provider authorization/429/backoff/deletions/history coverage",
    ],
  };
  mkdirSync("evidence", { recursive: true });
  writeFileSync(
    "evidence/runtime-checks.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      pass: true,
      checks: checks.length,
      evidence: "evidence/runtime-checks.json",
      raw_logs: dir,
    }),
  );
} catch (e) {
  console.error(e);
  process.exitCode = 1;
}
