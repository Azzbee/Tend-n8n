import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TendStore, isRecord } from "./engine.ts";
import type { LiveRecord } from "./google-records.ts";
import { InternalAuth, verificationHash } from "./internal-auth.ts";
import { createLiveServer } from "./live-api.ts";
import { exampleLivePolicy, gmailWindow } from "./live-policy.ts";

const draftCheck = process.argv[2] === "--draft";
if (process.argv.length > 3 || (process.argv[2] !== undefined && !draftCheck))
  throw new Error("Use only --draft or no options");
const purpose = draftCheck ? "draft" : "briefing";
const outputSuffix = draftCheck ? "-draft" : "";
const image =
  "docker.n8n.io/n8nio/n8n@sha256:c34ee9107a42b837e25cec0c8a927ab90a45b776aa2ccbf15e5b9cda466fad2c";
const name = `tend-ai16-fictional-${randomUUID().slice(0, 8)}`;
const liveAISourceHash = createHash("sha256")
  .update(readFileSync("src/live-ai.ts"))
  .digest("hex");
const scratch = mkdtempSync(join(tmpdir(), "tend-ai16-fictional-"));
const key = "fictional-test-only-abcdefghijklmnopqrstuvwxyz0123456789";
const now = new Date();
const policy = { ...exampleLivePolicy };
const store = new TendStore(":memory:", {
  mode: "live",
  principal: {
    owner_id: policy.principal_id,
    user_id: "live-owner",
    chat_id: "live-private",
  },
  clock: () => now,
});
const server = createLiveServer({
  policy,
  auth: new InternalAuth(undefined, verificationHash(key)),
  store,
  clock: () => now,
});
const paths: string[] = [];
server.prependListener("request", (req) =>
  paths.push((req.url ?? "").split("?")[0]!),
);
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function docker(args: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error("Isolated native AI command timed out"));
    }, 180000);
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      writeFileSync(join(scratch, "last-command.log"), output);
      if (status === 0) ok(output);
      else
        fail(
          new Error(
            `Isolated native AI command failed (exit ${status}): ${output.slice(-1800)}`,
          ),
        );
    });
  });
}
function executionData(output: string): Record<string, unknown> {
  for (const match of output.matchAll(/^\{/gm)) {
    try {
      const parsed: unknown = JSON.parse(output.slice(match.index));
      if (isRecord(parsed)) return parsed;
    } catch {
      /* n8n writes startup lines before the final execution JSON. */
    }
  }
  throw new Error("Native CLI execution JSON missing");
}
function recordMap(value: unknown, key: string): Record<string, unknown> {
  assert(isRecord(value) && isRecord(value[key]), `Missing native ${key}`);
  return value[key];
}
try {
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(18773, "0.0.0.0", () => {
      server.removeListener("error", fail);
      ok();
    });
  });
  const window = gmailWindow(policy, now);
  store.seed(
    [
      {
        owner_id: policy.principal_id,
        contact_id: "P1",
        name: "Fictional Mira",
      },
    ],
    [
      {
        owner_id: policy.principal_id,
        contact_id: "OWNER",
        identity: policy.account_email,
      },
      {
        owner_id: policy.principal_id,
        contact_id: "P1",
        identity: "mira@example.invalid",
      },
    ],
    [],
  );
  const text =
    "The robotics presentation is scheduled for Friday. We discussed the demonstration slides.";
  const raw: LiveRecord = {
    owner_id: policy.principal_id,
    source: "gmail",
    account_id: policy.account_email,
    source_record_id: "fictional-ai16-message",
    source_thread_id: "fictional-ai16-thread",
    kind: "message",
    direction: "received",
    actor_identity: "mira@example.invalid",
    participant_identities: [policy.account_email],
    occurred_at: new Date(now.getTime() - 60000).toISOString(),
    observed_at: now.toISOString(),
    body_text: text,
    authored_text: text,
    authored_spans: [{ start: 0, end: text.length, text }],
    contact_ids: ["P1"],
    attribution: "direct",
    eligible_for_extraction: false,
    evidence_reference:
      "https://mail.google.com/mail/u/0/#all/fictional-ai16-thread",
    ingestion_mode: "live",
    coverage_start: window.start,
    coverage_end: window.end,
    cancelled: false,
  };
  const normalized = store.ingest(raw);
  const workflowText = readFileSync("workflows/16-live-ai-review.json", "utf8");
  const workflow: unknown = JSON.parse(
    workflowText.replaceAll(":18768", ":18773"),
  );
  assert(
    isRecord(workflow) && Array.isArray(workflow.nodes),
    "Missing workflow16",
  );
  for (const value of workflow.nodes) {
    assert(isRecord(value), "Invalid native node");
    if (value.name === "Set explicit contact and review purpose") {
      const parameters = recordMap(value, "parameters");
      const assignments = recordMap(parameters, "assignments");
      assert(
        Array.isArray(assignments.assignments),
        "Missing native Set assignments",
      );
      for (const assignment of assignments.assignments) {
        assert(isRecord(assignment), "Invalid assignment");
        if (assignment.name === "contact_id") assignment.value = "P1";
        if (assignment.name === "purpose") assignment.value = purpose;
      }
    }
    if (
      isRecord(value.credentials) &&
      isRecord(value.credentials.httpHeaderAuth)
    )
      value.credentials.httpHeaderAuth = {
        id: "FictionalAI16Header",
        name: "Fictional AI16 header",
      };
  }
  assert(
    workflow.nodes.some(
      (value) =>
        isRecord(value) &&
        value.name === "Deliver validated review only to enrolled owner" &&
        value.disabled === true,
    ),
    "Default local review must not require an enabled Telegram credential",
  );
  writeFileSync(join(scratch, "workflow.json"), JSON.stringify(workflow));
  writeFileSync(
    join(scratch, "credentials.json"),
    JSON.stringify([
      {
        id: "FictionalAI16Header",
        name: "Fictional AI16 header",
        type: "httpHeaderAuth",
        data: { name: "Authorization", value: `Bearer ${key}` },
      },
      {
        id: "TendReviewLocalOllama",
        name: "Tend review local Ollama (no key)",
        type: "ollamaApi",
        data: { baseUrl: "http://host.docker.internal:11434" },
      },
    ]),
    { mode: 0o600 },
  );
  await docker([
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
    `${scratch}:/scratch`,
    "--entrypoint",
    "sh",
    image,
    "-c",
    "sleep infinity",
  ]);
  const version = (await docker(["exec", name, "n8n", "--version"])).trim();
  assert(version === "2.43.4", "Unexpected native n8n version");
  await docker([
    "exec",
    name,
    "n8n",
    "import:credentials",
    "--input=/scratch/credentials.json",
  ]);
  await docker([
    "exec",
    name,
    "n8n",
    "import:workflow",
    "--input=/scratch/workflow.json",
  ]);
  const output = await docker([
    "exec",
    name,
    "n8n",
    "execute",
    "--id",
    "TendLive16",
  ]);
  const execution = executionData(output);
  const data = recordMap(execution, "data");
  const resultData = recordMap(data, "resultData");
  const runData = recordMap(resultData, "runData");
  const modelRun = runData["Local cited review (Basic LLM Chain)"];
  assert(
    Array.isArray(modelRun) && modelRun.length === 1,
    "Native LLM chain did not execute",
  );
  assert(isRecord(modelRun[0]), "Native chain result missing");
  const chainData = recordMap(modelRun[0], "data");
  assert(
    Array.isArray(chainData.main) &&
      Array.isArray(chainData.main[0]) &&
      isRecord(chainData.main[0][0]),
    "Native chain result item missing",
  );
  const chainOutput = recordMap(chainData.main[0][0], "json");
  const modelNodeRuns = runData["Local review Ollama Chat Model"];
  assert(
    Array.isArray(modelNodeRuns) &&
      modelNodeRuns.some(
        (run: unknown) =>
          isRecord(run) &&
          run.executionStatus === "success" &&
          !Object.hasOwn(run, "error"),
      ),
    `Native Ollama node success not observed: ${JSON.stringify(
      Object.entries(runData).map(([node, runs]) => ({
        node,
        statuses: Array.isArray(runs)
          ? runs.map((run: unknown) =>
              isRecord(run) ? run.executionStatus : "invalid",
            )
          : [],
      })),
    )}`,
  );
  const finalRuns = runData["Return review only without delivery"];
  assert(
    Array.isArray(finalRuns) && isRecord(finalRuns[0]),
    "Native final result missing",
  );
  const finalData = recordMap(finalRuns[0], "data");
  assert(
    Array.isArray(finalData.main) &&
      Array.isArray(finalData.main[0]) &&
      isRecord(finalData.main[0][0]),
    "Native result item missing",
  );
  const result = recordMap(finalData.main[0][0], "json");
  assert(
    ["validated", "fallback"].includes(String(result.status)),
    "Native result was neither validated nor fallback",
  );
  assert(
    result.outbound_sent === false &&
      (draftCheck
        ? result.status === "validated" &&
          isRecord(result.draft) &&
          result.draft.pending_review === true &&
          result.draft.model === "qwen3:4b" &&
          result.draft.prose_fact_verified === false &&
          typeof result.draft.text === "string" &&
          result.draft.text.length > 0 &&
          result.draft.text !== text
        : result.draft === null) &&
      Array.isArray(result.items) &&
      result.items.length > 0,
    "Native review result violated delivery boundary",
  );
  for (const name of [
    "Prepare bounded validated owner review",
    "Deliver validated review only to enrolled owner",
    "Verify owner delivery receipt",
  ])
    assert(
      !Object.hasOwn(runData, name),
      "Default local review dispatched owner transport",
    );
  const localRuns = runData["Return local review without delivery"];
  assert(
    Array.isArray(localRuns) && isRecord(localRuns[0]),
    "Default local terminal output missing",
  );
  const localData = recordMap(localRuns[0], "data");
  assert(
    Array.isArray(localData.main) &&
      Array.isArray(localData.main[0]) &&
      isRecord(localData.main[0][0]),
    "Default local terminal result missing",
  );
  assert(
    JSON.stringify(recordMap(localData.main[0][0], "json")) ===
      JSON.stringify(result),
    "Default terminal output changed the reviewed result",
  );
  for (const item of result.items) {
    assert(
      isRecord(item) &&
        item.record_key === normalized.record_key &&
        item.content_hash === normalized.content_hash &&
        typeof item.quote === "string" &&
        text.includes(item.quote),
      "Native result citation not exact current evidence",
    );
  }
  assert(
    paths.includes("/api/live/ai/input") &&
      paths.includes("/api/live/ai/validate"),
    "Native protected endpoints were not both used",
  );
  assert(
    store.commitments(policy.principal_id).length === 0 &&
      store.telegramDeliveryCounts().sent === 0,
    "Native briefing caused a state action or send",
  );
  const report = {
    checked_at: new Date().toISOString(),
    pass: true,
    scope:
      "Fictional source data only; isolated native n8n container and in-memory private API. Actual local Ollama execution, no real-data claim.",
    runtime: {
      n8n: version,
      image,
      model: draftCheck ? "qwen3:4b" : "qwen3:0.6b",
    },
    purpose,
    workflow_sha256: createHash("sha256").update(workflowText).digest("hex"),
    live_ai_source_sha256: liveAISourceHash,
    model_node_executed: true,
    result_status: result.status,
    exact_current_citation_count: result.items.length,
    outbound_sent: false,
    commitments_created: 0,
    protected_input_and_validation_observed: true,
  };
  mkdirSync(resolve(".scratch"), { recursive: true });
  writeFileSync(
    resolve(`.scratch/live-ai-native-fictional-output${outputSuffix}.json`),
    JSON.stringify(
      { scope: "Fictional integration source only", chain_output: chainOutput },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    resolve(`.scratch/live-ai-native-check${outputSuffix}.json`),
    JSON.stringify(report, null, 2) + "\n",
  );
  mkdirSync(resolve("evidence"), { recursive: true });
  writeFileSync(
    resolve(`evidence/live-ai-runtime-checks${outputSuffix}.json`),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} catch (error: unknown) {
  mkdirSync(resolve(".scratch"), { recursive: true });
  writeFileSync(
    resolve(`.scratch/live-ai-native-last-failure${outputSuffix}.json`),
    JSON.stringify(
      {
        checked_at: new Date().toISOString(),
        pass: false,
        live_ai_source_sha256: liveAISourceHash,
        scope:
          "Fictional isolated native check; a previous success receipt is not proof of this attempt.",
        error:
          error instanceof Error ? error.message : "Unknown native check error",
      },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  await docker(["rm", "-f", name]).catch(() => undefined);
  if (server.listening)
    await new Promise<void>((ok) => server.close(() => ok()));
  store.close();
  rmSync(scratch, { recursive: true, force: true });
}
