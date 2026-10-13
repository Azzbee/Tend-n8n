import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const name = `tend-schema-check-${randomUUID().slice(0, 8)}`;
function run(args: string[], input?: string): string {
  const r = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 120000,
    ...(input === undefined ? {} : { input }),
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}
try {
  run([
    "run",
    "-d",
    "--name",
    name,
    "--network",
    "none",
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "pgvector/pgvector:pg16",
  ]);
  let ready = false;
  for (let i = 0; i < 50; i++) {
    const r = spawnSync(
      "docker",
      ["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
      { encoding: "utf8" },
    );
    if (r.status === 0) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error("Postgres did not start");
  const schema = readFileSync("schema/001-tend.sql", "utf8");
  const output = run(
    ["exec", "-i", name, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1"],
    schema,
  );
  const version = run([
    "exec",
    name,
    "psql",
    "-U",
    "postgres",
    "-Atc",
    "SELECT version()",
  ]);
  const tables = run([
    "exec",
    name,
    "psql",
    "-U",
    "postgres",
    "-Atc",
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
  ]).split("\n");
  if (tables.length !== 8 || !output.includes("COMMIT"))
    throw new Error("Schema assertions failed");
  const report = {
    checked_at: new Date().toISOString(),
    pass: true,
    runtime: version,
    network: "isolated container, no published port",
    schema_sha256: createHash("sha256").update(schema).digest("hex"),
    command: "psql -U postgres -v ON_ERROR_STOP=1 < schema/001-tend.sql",
    output: output.split("\n"),
    tables,
    scope:
      "Schema creation executed. Application demo uses SQLite; no production adapter or migration tested.",
  };
  mkdirSync("evidence", { recursive: true });
  writeFileSync(
    "evidence/schema-checks.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      pass: true,
      tables: tables.length,
      evidence: "evidence/schema-checks.json",
    }),
  );
} finally {
  spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" });
}
