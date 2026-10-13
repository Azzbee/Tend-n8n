import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { isRecord } from "./engine.ts";
import { demoAuth, fixtureRecords } from "./fixtures.ts";
import { configuredGuard } from "./telegram.ts";
const image =
  "docker.n8n.io/n8nio/n8n@sha256:c34ee9107a42b837e25cec0c8a927ab90a45b776aa2ccbf15e5b9cda466fad2c";
const id = randomUUID().slice(0, 8),
  name = `tend-review-check-${id}`,
  dir = resolve(`.scratch/check-${id}`);
mkdirSync(dir, { recursive: true });
let n8nVersion: string;
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
  // Synchronous Docker CLI checks block this process's socket-close events.
  // Use a fresh socket for each fixture call rather than an idle fetch pool.
  return new Promise((resolveResult, reject) => {
    const req = httpRequest(
      `http://127.0.0.1:18767${path}`,
      {
        agent: false,
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          try {
            const value: unknown = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            );
            assert(
              res.statusCode === 200 && isRecord(value),
              `${path}: request failed`,
            );
            resolveResult(value);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(10000, () =>
      req.destroy(new Error(`${path}: request timed out`)),
    );
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
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
    const missing = await fetch(
      "http://127.0.0.1:18767/workflows/01-missing.json",
    );
    assert(
      missing.status === 400,
      "missing static file did not return a controlled error",
    );
    await request("/api/status");
    checks.push({
      name: "Missing-file survival",
      pass: true,
      detail:
        "Missing allowlisted artifact returns an error; server remains available",
    });
    for (const runId of ["stray-review", "another-review"]) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await fetch(
          `http://127.0.0.1:18767/api/transient?run_id=${runId}`,
        );
        const body: unknown = await result.json();
        assert(
          result.status === (attempt === 3 ? 200 : 429) &&
            isRecord(body) &&
            body.attempt === attempt,
          "retry scenarios leaked shared state",
        );
      }
    }
    checks.push({
      name: "Isolated synthetic retries",
      pass: true,
      detail:
        "Two independent request scenarios each return 429,429,200 before workflow retry execution",
    });
    command(
      [
        "run",
        "-d",
        "--name",
        name,
        "-p",
        "127.0.0.1::5678",
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
        "-e",
        "WEBHOOK_URL=http://localhost:5678/",
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
    n8nVersion = command(["exec", name, "n8n", "--version"], "version").trim();
    command(
      [
        "exec",
        name,
        "n8n",
        "import:credentials",
        "--input=/workspace/fixtures/local-ollama.json",
      ],
      "local-model-config",
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
      imported.includes("Successfully imported 10 workflows"),
      "ten-workflow import failed",
    );
    checks.push({
      name: "Clean n8n import",
      pass: true,
      detail:
        "10 inactive workflows; local Ollama configuration, no private account secret; live Telegram template remains inactive",
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
    const outgoing = JSON.parse(
      readFileSync("workflows/07-extract-commitments.json", "utf8"),
    ) as {
      id: string;
      name: string;
      nodes: { name: string; parameters: Record<string, unknown> }[];
    };
    outgoing.id = "TendReview07OutgoingCheck";
    outgoing.name += " (outgoing verification)";
    const selector = outgoing.nodes.find(
      (n) => n.name === "Select fictional record",
    );
    assert(selector, "missing extraction selector");
    selector.parameters.jsCode = 'return [{json:{source_record_id:"g2"}}];';
    writeFileSync(`${dir}/outgoing.json`, JSON.stringify(outgoing));
    command(
      [
        "exec",
        name,
        "n8n",
        "import:workflow",
        "--input=/scratch/outgoing.json",
      ],
      "import-outgoing",
    );
    execution(outgoing.id);
    // Exercise the actual native Telegram Trigger and Send node against a local
    // mock Bot API. This never connects to Telegram or a human recipient.
    const telegram = JSON.parse(
      readFileSync("workflows/10-telegram-private.json", "utf8"),
    ) as {
      id: string;
      name: string;
      nodes: {
        id: string;
        name: string;
        type: string;
        webhookId?: string;
        parameters: Record<string, unknown>;
        credentials?: Record<string, { id: string; name: string }>;
      }[];
    };
    telegram.id = "TendTelegramFixtureCheck";
    telegram.name = "Synthetic Telegram trigger and private reply check";
    const trigger = telegram.nodes.find(
      (n) => n.type === "n8n-nodes-base.telegramTrigger",
    )!;
    trigger.webhookId = "tend-telegram-fixture-check";
    trigger.parameters.additionalFields = { download: false };
    telegram.nodes.find(
      (n) => n.name === "Authorize Telegram owner",
    )!.parameters.jsCode = configuredGuard("424242", "424242");
    for (const node of telegram.nodes)
      if (node.credentials)
        node.credentials = {
          telegramApi: {
            id: "TendTelegramFixtureCredential",
            name: "Fictional local Bot API",
          },
        };
    writeFileSync(`${dir}/telegram-fixture.json`, JSON.stringify(telegram));
    writeFileSync(
      `${dir}/telegram-fixture-credential.json`,
      JSON.stringify([
        {
          id: "TendTelegramFixtureCredential",
          name: "Fictional local Bot API",
          type: "telegramApi",
          data: {
            accessToken: "FIXTURE_ONLY",
            baseUrl: "http://host.docker.internal:18767/api/mock-telegram",
          },
        },
      ]),
    );
    command(
      [
        "exec",
        name,
        "n8n",
        "import:credentials",
        "--input=/scratch/telegram-fixture-credential.json",
      ],
      "telegram-mock-credential",
    );
    command(
      [
        "exec",
        name,
        "n8n",
        "import:workflow",
        "--input=/scratch/telegram-fixture.json",
      ],
      "telegram-mock-import",
    );
    command(
      ["exec", name, "n8n", "publish:workflow", "--id", telegram.id],
      "telegram-fixture-publish",
    );
    command(["exec", "-d", name, "n8n", "start"], "telegram-fixture-start");
    const portLine = command(
      ["port", name, "5678/tcp"],
      "telegram-fixture-port",
    );
    const port = portLine.match(/:(\d+)\s*$/)?.[1];
    assert(port, "missing local n8n webhook port");
    const base = `http://127.0.0.1:${port}`;
    let webhookReady = false;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(base + "/healthz");
        if (r.status === 200) {
          webhookReady = true;
          break;
        }
      } catch {
        // The isolated n8n process may still be starting.
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    assert(webhookReady, "native Telegram fixture server did not start");
    await new Promise((r) => setTimeout(r, 800));
    const webhook = `${base}/webhook/${trigger.webhookId}/webhook`;
    const fixtureUpdate = {
      update_id: 100,
      message: {
        message_id: 1,
        from: { id: 424242, is_bot: false },
        chat: { id: 424242, type: "private" },
        text: "/status",
      },
    };
    const sendUpdate = (update: unknown, authenticated = true) =>
      fetch(webhook, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authenticated
            ? {
                "x-telegram-bot-api-secret-token":
                  `${telegram.id}_${trigger.id}`.replace(/[^a-zA-Z0-9_-]/g, ""),
              }
            : {}),
        },
        body: JSON.stringify(update),
      });
    assert(
      (await sendUpdate(fixtureUpdate, false)).status === 403,
      "native Telegram accepted a forged webhook without its secret header",
    );
    for (const message of [
      { ...fixtureUpdate.message, from: { id: 999, is_bot: false } },
      { ...fixtureUpdate.message, chat: { id: 424242, type: "group" } },
    ]) {
      assert(
        (await sendUpdate({ ...fixtureUpdate, message })).ok,
        "native fixture rejected transport unexpectedly",
      );
    }
    await new Promise((r) => setTimeout(r, 800));
    assert(
      (await request("/api/status")).mock_telegram_replies instanceof Array,
      "missing mock reply ledger",
    );
    assert(
      ((await request("/api/status")).mock_telegram_replies as unknown[])
        .length === 0,
      "unauthorized Telegram update reached a reply",
    );
    for (const text of [
      "/status",
      "/prep F17",
      "/today",
      "/help",
      "/unknown",
    ]) {
      assert(
        (
          await sendUpdate({
            ...fixtureUpdate,
            update_id: ++fixtureUpdate.update_id,
            message: { ...fixtureUpdate.message, text },
          })
        ).ok,
        "native Telegram owner update rejected",
      );
    }
    let replyCount = 0;
    for (let i = 0; i < 60; i++) {
      const state = await request("/api/status");
      replyCount = Array.isArray(state.mock_telegram_replies)
        ? state.mock_telegram_replies.length
        : 0;
      if (replyCount === 5) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert(
      replyCount === 5,
      "native Telegram owner commands did not produce all five replies",
    );
    const mockReplies = (await request("/api/status")).mock_telegram_replies;
    assert(
      Array.isArray(mockReplies) &&
        mockReplies.every(
          (r) =>
            isRecord(r) &&
            r.chat_id === "424242" &&
            typeof r.text === "string" &&
            r.text.startsWith("Course demo • fictional data") &&
            r.text.length <= 3900,
        ),
      "invalid private Telegram response formatting/recipient",
    );
    checks.push({
      name: "Native Telegram trigger and owner replies (local mock)",
      pass: true,
      detail:
        "Actual webhook rejects forged header; foreign user/group produces no reply; status/prep/today/help/unknown execute five readable owner-only native Send-node replies to a local mock, no Telegram account",
    });
    const first = await request("/api/status");
    assert(
      isRecord(first.counts) &&
        first.counts.interactions === 7 &&
        first.counts.commitments === 2,
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
    assert(
      first.commitments.every((c) => isRecord(c) && c.status === "pending"),
      "model activated an obligation",
    );
    assert(
      first.commitments.some(
        (c) => isRecord(c) && c.direction === "owed_by_me",
      ) &&
        first.commitments.some(
          (c) => isRecord(c) && c.direction === "owed_to_me",
        ),
      "both directions not demonstrated",
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
      if (text.startsWith("/confirm"))
        assert(
          r.status === "confirmed" && r.due_date === "2026-10-15",
          "confirm did not persist",
        );
      if (text.startsWith("/draft"))
        assert(
          typeof r.preview === "string" && r.preview.length > 0,
          "missing preview",
        );
      if (text.startsWith("/done"))
        assert(r.status === "done", "done did not persist");
    }
    const denied = await fetch("http://127.0.0.1:18767/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...demoAuth, chat_type: "group" }),
    });
    const deniedBody: unknown = await denied.json();
    assert(
      denied.status === 400 &&
        isRecord(deniedBody) &&
        deniedBody.error === "unauthorized",
      "group request did not hit owner boundary",
    );
    for (const headers of [
      { "Content-Type": "text/plain" },
      {
        "Content-Type": "application/json",
        Origin: "https://untrusted.example.invalid",
      },
    ]) {
      const r = await fetch("http://127.0.0.1:18767/api/command", {
        method: "POST",
        headers,
        body: JSON.stringify(demoAuth),
      });
      assert(r.status === 400, "browser-origin/content-type guard bypassed");
    }
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
      Array.isArray(brief.coverage) &&
        brief.coverage.some(
          (s) =>
            isRecord(s) &&
            s.source === "whatsapp_personal" &&
            s.status === "stale",
        ) &&
        brief.coverage.some(
          (s) =>
            isRecord(s) && s.source === "linkedin" && s.mode === "snapshot",
        ),
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
    workflow_sha256: Object.fromEntries(
      readdirSync("workflows")
        .filter((f) => f.endsWith(".json"))
        .map((f) => [
          f,
          createHash("sha256")
            .update(readFileSync(`workflows/${f}`))
            .digest("hex"),
        ]),
    ),
    source_sha256: Object.fromEntries(
      [
        "engine.ts",
        "server.ts",
        "build-workflows.ts",
        "fixtures.ts",
        "integration.ts",
      ].map((f) => [
        f,
        createHash("sha256")
          .update(readFileSync(`src/${f}`))
          .digest("hex"),
      ]),
    ),
    runtime: {
      node: process.version,
      n8n: n8nVersion,
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
