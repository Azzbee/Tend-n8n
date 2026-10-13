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
import { request as httpRequest, createServer, type Server } from "node:http";
import { TendStore } from "./engine.ts";
import { createLiveServer } from "./live-api.ts";
import { InternalAuth, verificationHash } from "./internal-auth.ts";
import { exampleLivePolicy } from "./live-policy.ts";
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
async function listen(server: Server): Promise<number> {
  await new Promise<void>((ok) => server.listen(0, "0.0.0.0", ok));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing test port");
  return address.port;
}
const reservation = createServer();
const fixturePort = await listen(reservation);
await new Promise<void>((ok) => reservation.close(() => ok()));
const fixtureBase = `http://127.0.0.1:${fixturePort}`;
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
      `${fixtureBase}${path}`,
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
async function asyncDocker(args: string[], log: string): Promise<string> {
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
      fail(new Error(`${log}: timeout`));
    }, 240000);
    child.on("error", fail);
    child.on("close", (status) => {
      clearTimeout(timer);
      writeFileSync(`${dir}/${log}.log`, output);
      if (status === 0) ok(output);
      else fail(new Error(`${log}: native check failed; inspect scratch log`));
    });
  });
}
async function googleIntegration(): Promise<void> {
  const now = new Date(),
    clock = () => now;
  const policy = {
    ...exampleLivePolicy,
    calendar_ids: [
      exampleLivePolicy.account_email,
      "fictional-timetable@example.invalid",
    ],
    limits: {
      ...exampleLivePolicy.limits,
      max_page_size: 2,
      max_records_per_run: 2,
      max_run_ms: 60000,
    },
  };
  const key = randomUUID() + randomUUID();
  const auth = new InternalAuth(undefined, verificationHash(key));
  const store = new TendStore(`${dir}/live-mock.sqlite`, {
    mode: "live",
    principal: {
      owner_id: policy.principal_id,
      user_id: "live-owner",
      chat_id: "live-private",
    },
    clock,
  });
  const live = createLiveServer({ policy, auth, store, clock });
  const livePort = await listen(live);
  let wrongProfile = false,
    pageRequests = 0,
    profileRequests = 0,
    retryCount = 0;
  let throttle = true;
  const observed: {
    method: string;
    path: string;
    query: Record<string, string>;
  }[] = [];
  const mock = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    observed.push({
      method: req.method ?? "",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
    });
    const reply = (
      status: number,
      body: unknown,
      headers: Record<string, string> = {},
    ) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (
      req.method !== "GET" ||
      !req.headers.authorization?.startsWith("Bearer ")
    ) {
      reply(403, { error: "fixture GET authorization required" });
      return;
    }
    if (url.pathname.endsWith("/profile")) {
      profileRequests++;
      reply(200, {
        emailAddress: wrongProfile
          ? "foreign@example.invalid"
          : policy.account_email,
      });
      return;
    }
    if (url.pathname === "/gmail/v1/users/me/messages") {
      pageRequests++;
      if (throttle) {
        throttle = false;
        retryCount++;
        reply(429, { error: "fixture rate limit" }, { "Retry-After": "1" });
        return;
      }
      reply(
        200,
        url.searchParams.has("pageToken")
          ? { messages: [{ id: "m3" }], resultSizeEstimate: 3 }
          : {
              messages: [{ id: "m1" }, { id: "m2" }],
              nextPageToken: "mail-next",
              resultSizeEstimate: 3,
            },
      );
      return;
    }
    const message = /\/messages\/(m[123])$/.exec(url.pathname)?.[1];
    if (message) {
      const outgoing = message === "m1";
      const date = new Date(now.getTime() + 86400000)
        .toISOString()
        .slice(0, 10);
      const text = outgoing
        ? `I will send the demo by ${date}.`
        : "Thank you for the meeting.";
      reply(200, {
        id: message,
        threadId: `thread-${message}`,
        internalDate: String(now.getTime() - 3600000),
        labelIds: outgoing ? ["SENT"] : ["INBOX"],
        payload: {
          mimeType: "text/plain",
          headers: [
            {
              name: "From",
              value: outgoing
                ? policy.account_email
                : "Mira <mira@example.invalid>",
            },
            {
              name: "To",
              value: outgoing
                ? "Mira <mira@example.invalid>"
                : policy.account_email,
            },
            { name: "Subject", value: "Fictional Google runtime test" },
          ],
          body: { data: Buffer.from(text).toString("base64url") },
        },
      });
      return;
    }
    if (url.pathname.startsWith("/calendar/v3/users/me/calendarList/")) {
      const selected = decodeURIComponent(url.pathname.split("/").at(-1)!);
      reply(200, {
        id: selected,
        primary: selected === policy.account_email,
        accessRole: selected === policy.account_email ? "owner" : "reader",
      });
      return;
    }
    if (url.pathname.endsWith("/events")) {
      const selected = decodeURIComponent(url.pathname.split("/").at(-2)!);
      const start = new Date(now.getTime() + 86400000).toISOString(),
        end = new Date(now.getTime() + 90000000).toISOString();
      reply(200, {
        kind: "calendar#events",
        items:
          selected === policy.account_email
            ? url.searchParams.has("pageToken")
              ? [{ id: "deleted-event", status: "cancelled" }]
              : [
                  {
                    id: "event-1",
                    status: "confirmed",
                    summary: "Fictional review meeting",
                    start: { dateTime: start },
                    end: { dateTime: end },
                    organizer: { email: policy.account_email },
                    attendees: [
                      { email: policy.account_email, self: true },
                      { email: "mira@example.invalid" },
                    ],
                    htmlLink:
                      "https://calendar.google.com/calendar/event?eid=fictional",
                  },
                ]
            : [],
        ...(selected === policy.account_email &&
        !url.searchParams.has("pageToken")
          ? { nextPageToken: "cal-next" }
          : {}),
      });
      return;
    }
    reply(404, { error: "unallowlisted fixture provider path" });
  });
  const providerPort = await listen(mock);
  const credentials = [
    {
      id: "GoogleCheckInternal",
      name: "Isolated test header",
      type: "httpHeaderAuth",
      data: { name: "Authorization", value: `Bearer ${key}` },
    },
    ...(["gmailOAuth2", "googleCalendarOAuth2Api"] as const).map(
      (type, index) => ({
        id: `GoogleCheck${index}`,
        name: `Isolated ${type}`,
        type,
        data: {
          clientId: "fixture-only",
          clientSecret: randomUUID(),
          customScopes: true,
          enabledScopes:
            type === "gmailOAuth2"
              ? "https://www.googleapis.com/auth/gmail.readonly"
              : "https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly",
          oauthTokenData: {
            access_token: randomUUID(),
            token_type: "Bearer",
            expires_in: 3600,
            scope: "readonly",
          },
          allowedHttpRequestDomains: "all",
        },
      }),
    ),
  ];
  writeFileSync(
    `${dir}/google-check-credentials.json`,
    JSON.stringify(credentials),
    { mode: 0o600 },
  );
  command(
    [
      "exec",
      name,
      "n8n",
      "import:credentials",
      "--input=/scratch/google-check-credentials.json",
    ],
    "google-mock-credentials",
  );
  mkdirSync(`${dir}/google-workflows`);
  for (const file of readdirSync("workflows").filter((f) =>
    /^(11|12|13|15)-/.test(f),
  )) {
    const raw = readFileSync(`workflows/${file}`, "utf8")
      .replaceAll(
        "https://gmail.googleapis.com/gmail/v1",
        `http://host.docker.internal:${providerPort}/gmail/v1`,
      )
      .replaceAll(
        "https://www.googleapis.com/calendar/v3",
        `http://host.docker.internal:${providerPort}/calendar/v3`,
      )
      .replaceAll(":18768", `:${livePort}`)
      .replaceAll("CONFIGURE_INTERNAL_API_CREDENTIAL_ID", "GoogleCheckInternal")
      .replaceAll("CONFIGURE_GMAIL_READONLY_CREDENTIAL_ID", "GoogleCheck0")
      .replaceAll("CONFIGURE_CALENDAR_READONLY_CREDENTIAL_ID", "GoogleCheck1");
    writeFileSync(`${dir}/google-workflows/${file}`, raw);
  }
  command(
    [
      "exec",
      name,
      "n8n",
      "import:workflow",
      "--separate",
      "--input=/scratch/google-workflows",
    ],
    "google-mock-import",
  );
  const execute = async (wid: string, label: string) => {
    const output = await asyncDocker(
      [
        "exec",
        "-e",
        "N8N_RUNNERS_BROKER_PORT=5680",
        name,
        "n8n",
        "execute",
        "--id",
        wid,
      ],
      label,
    );
    assert(
      [...output.matchAll(/"status":\s*"([^"]+)"/g)].at(-1)?.[1] === "success",
      `${label}: workflow did not succeed`,
    );
  };
  const googleChecks: { name: string; pass: true; detail: unknown }[] = [];
  const sourceState = (source: string, account: string) =>
    store
      .sourceStatus(policy.principal_id)
      .find((s) => s.source === source && s.account_id === account);
  try {
    await execute("TendGoogle11", "google-mail-page-one");
    const partial = sourceState("gmail", policy.account_email);
    assert(
      partial?.status !== "current" && partial?.cursor === "mail-next",
      "first page falsely complete or cursor lost",
    );
    assert(
      store.counts(policy.principal_id).interactions === 2,
      "native child did not store both first-page records",
    );
    googleChecks.push({
      name: "Native Google GET, retry and callable storage",
      pass: true,
      detail:
        "Predefined OAuth credential with fictional token, actual HTTP nodes, provider429/Retry-After then page1 of2, native child commits2 records; coverage partial.",
    });
    await execute("TendGoogle11", "google-mail-page-two");
    assert(
      sourceState("gmail", policy.account_email)?.status === "current" &&
        store.counts(policy.principal_id).interactions === 3,
      "resumed Gmail snapshot did not complete",
    );
    googleChecks.push({
      name: "Resumable anchored Gmail pagination",
      pass: true,
      detail:
        "Second operator invocation resumes committed cursor; last page completes3 fictional messages; no absent-record inference on page1.",
    });
    await execute("TendGoogle12", "google-calendar-empty-selected");
    assert(
      sourceState("calendar", "fictional-timetable@example.invalid")?.status ===
        "current",
      "empty selected timetable did not complete",
    );
    await execute("TendGoogle12", "google-calendar-page-one");
    assert(
      sourceState("calendar", policy.account_email)?.cursor === "cal-next" &&
        sourceState("calendar", policy.account_email)?.status !== "current",
      "Calendar first page incorrectly current",
    );
    await execute("TendGoogle12", "google-calendar-page-two");
    assert(
      store
        .sourceStatus(policy.principal_id)
        .filter((s) => s.source === "calendar")
        .every((s) => s.status === "current"),
      "selected Calendar snapshots incomplete",
    );
    googleChecks.push({
      name: "Exact chosen calendars and empty/tombstone pages",
      pass: true,
      detail:
        "Primary account metadata bound to profile, selected timetable validated; two primary pages including cancellation, then empty timetable page completes without invented events.",
    });
    await execute("TendGoogle15", "google-native-authored-ai");
    assert(
      store.counts(policy.principal_id).commitments === 1,
      "native authored-span LLM did not create pending commitment",
    );
    googleChecks.push({
      name: "Native local AI on newly authored Google span",
      pass: true,
      detail:
        "Actual LLM Chain + local qwen3:0.6b output exact first-person quote; protected API validates and stores one pending owner commitment. No contact send.",
    });
    const priorPageRequests = pageRequests;
    wrongProfile = true;
    await execute("TendGoogle11", "google-profile-mismatch");
    assert(
      pageRequests === priorPageRequests &&
        sourceState("gmail", policy.account_email)?.status === "revoked",
      "wrong Google account reached mail listing or failed to require reconnect",
    );
    googleChecks.push({
      name: "Account mismatch stops provider reads",
      pass: true,
      detail:
        "Wrong profile never lists messages and marks reconnect-required; prior record ledger retained.",
    });
    const before = profileRequests;
    await execute("TendGoogle11", "google-revoked-deferred");
    assert(profileRequests === before, "revoked grant still polled provider");
    assert(
      retryCount === 1 && observed.every((r) => r.method === "GET"),
      "provider operations mutated or retry fixture not observed",
    );
    assert(
      observed
        .filter((r) => r.path === "/gmail/v1/users/me/messages")
        .every(
          (r) =>
            r.query.q?.includes("-is:draft") &&
            r.query.includeSpamTrash === "false",
        ),
      "draft/spam/trash query exclusions missing",
    );
    googleChecks.push({
      name: "Revoked grants stay deferred and reads remain GET",
      pass: true,
      detail:
        "Scheduled continuation does not call provider after mismatch. Observed mock GET requests exclude drafts/spam/trash; only exact configured calendar IDs requested.",
    });
    writeFileSync(
      "evidence/google-runtime-checks.json",
      JSON.stringify(
        {
          checked_at: new Date().toISOString(),
          scope:
            "Isolated n8n native-node tests with fictional Google provider and OAuth tokens. No real inbox or Calendar reads; no actual Google authorization claim.",
          runtime: { n8n: n8nVersion, image, model: "qwen3:0.6b" },
          workflow_sha256: Object.fromEntries(
            readdirSync("workflows")
              .filter((f) => /^(11|12|13|14|15)-/.test(f))
              .map((f) => [
                f,
                createHash("sha256")
                  .update(readFileSync(`workflows/${f}`))
                  .digest("hex"),
              ]),
          ),
          checks: googleChecks,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await new Promise<void>((ok) => mock.close(() => ok()));
    await new Promise<void>((ok) => live.close(() => ok()));
    store.close();
  }
}

try {
  const log = openSync(`${dir}/server.log`, "w");
  const server = spawn(
    process.execPath,
    ["--experimental-strip-types", "src/server.ts"],
    {
      env: {
        ...process.env,
        TEND_DEMO_DB: `${dir}/demo.sqlite`,
        TEND_DEMO_PORT: String(fixturePort),
      },
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
    const missing = await fetch(`${fixtureBase}/workflows/01-missing.json`);
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
    const guide = await (await fetch(fixtureBase + "/")).text();
    const artifactLinks = [
      ...new Set(
        [...guide.matchAll(/href="([^"]+)"/g)]
          .map((m) => m[1]!)
          .filter((link) => !link.includes(":") && !link.startsWith("#")),
      ),
    ];
    for (const link of artifactLinks)
      assert(
        (await fetch(new URL(link, fixtureBase))).status === 200,
        `review artifact unavailable: ${link}`,
      );
    for (const privatePath of [
      "/.scratch/live-private/policy.json",
      "/.scratch/live-private/auth.json",
      "/.scratch/live-google/header-configured.json",
    ])
      assert(
        (await fetch(fixtureBase + privatePath)).status === 404,
        "private operator artifact exposed",
      );
    checks.push({
      name: "Review artifact links and private path isolation",
      pass: true,
      detail: {
        working_local_links: artifactLinks.length,
        private_paths_denied: 3,
      },
    });
    for (const runId of ["stray-review", "another-review"]) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await fetch(
          `${fixtureBase}/api/transient?run_id=${runId}`,
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
    mkdirSync(`${dir}/workspace/fixtures`, { recursive: true });
    writeFileSync(
      `${dir}/workspace/fixtures/local-ollama.json`,
      readFileSync("fixtures/local-ollama.json"),
    );
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
        `${dir}/workspace:/workspace:ro`,
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
    mkdirSync(`${dir}/workflows`);
    for (const file of readdirSync("workflows").filter((f) =>
      f.endsWith(".json"),
    )) {
      const prepared = readFileSync(`workflows/${file}`, "utf8").replaceAll(
        ":18767",
        `:${fixturePort}`,
      );
      assert(
        !prepared.includes("host.docker.internal:18767"),
        "fixture export still targets preserved API",
      );
      writeFileSync(`${dir}/workflows/${file}`, prepared);
    }
    const imported = command(
      [
        "exec",
        name,
        "n8n",
        "import:workflow",
        "--separate",
        "--input=/scratch/workflows",
      ],
      "import",
    );
    assert(
      imported.includes("Successfully imported 15 workflows"),
      "fifteen-workflow import failed",
    );
    checks.push({
      name: "Clean n8n import",
      pass: true,
      detail:
        "15 inactive workflows; local Ollama configuration, no private account secret; live Telegram template remains inactive",
    });
    if (process.env.TEND_GOOGLE_CHECK_ONLY !== "1") {
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
        readFileSync(`${dir}/workflows/07-extract-commitments.json`, "utf8"),
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
      const preTelegram = await request("/api/status");
      execution("TendReview01");
      execution("TendReview07");
      const fixtureReplay = await request("/api/status");
      assert(
        JSON.stringify(preTelegram.counts) ===
          JSON.stringify(fixtureReplay.counts),
        "replay duplicated records/candidates",
      );
      checks.push({ name: "Replay", pass: true, detail: fixtureReplay.counts });
      // Exercise the actual native Telegram Trigger and Send node against a local
      // mock Bot API. This never connects to Telegram or a human recipient.
      const telegram = JSON.parse(
        readFileSync(`${dir}/workflows/10-telegram-private.json`, "utf8"),
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
              baseUrl: `http://host.docker.internal:${fixturePort}/api/mock-telegram`,
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
      command(
        [
          "exec",
          "-d",
          name,
          "sh",
          "-c",
          "n8n start > /scratch/n8n-webhook.log 2>&1",
        ],
        "telegram-fixture-start",
      );
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
                    `${telegram.id}_${trigger.id}`.replace(
                      /[^a-zA-Z0-9_-]/g,
                      "",
                    ),
                }
              : {}),
          },
          body: JSON.stringify(update),
        });
      let forgedStatus = 0;
      for (let i = 0; i < 50; i++) {
        forgedStatus = (await sendUpdate(fixtureUpdate, false)).status;
        if (forgedStatus !== 404) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert(
        forgedStatus === 403,
        `native Telegram secret-header check returned ${forgedStatus}, expected 403; inspect isolated webhook log`,
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
      const repeated = {
        ...fixtureUpdate,
        update_id: 101,
        message: { ...fixtureUpdate.message, text: "/status" },
      };
      assert(
        (await sendUpdate(repeated)).ok,
        "repeated authenticated update rejected at transport",
      );
      await new Promise((r) => setTimeout(r, 800));
      assert(
        ((await request("/api/status")).mock_telegram_replies as unknown[])
          .length === 5,
        "duplicate authenticated update sent another reply",
      );
      let acknowledgements = 0;
      for (let i = 0; i < 30; i++) {
        const state = await request("/api/status");
        acknowledgements = isRecord(state.telegram_delivery)
          ? Number(state.telegram_delivery.sent)
          : 0;
        if (acknowledgements === 5) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert(
        acknowledgements === 5,
        "native replies did not reach durable send acknowledgement",
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
      const replay = await request("/api/status");
      assert(
        JSON.stringify(replay.counts) === JSON.stringify(first.counts),
        "replay duplicated records/candidates",
      );
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
        assert(
          r.outbound_sent === false,
          "outbound action unexpectedly present",
        );
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
      const denied = await fetch(`${fixtureBase}/api/command`, {
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
        const r = await fetch(`${fixtureBase}/api/command`, {
          method: "POST",
          headers,
          body: JSON.stringify(demoAuth),
        });
        assert(r.status === 400, "browser-origin/content-type guard bypassed");
      }
      const invalid = await fetch(`${fixtureBase}/api/ingest`, {
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
    }
    await googleIntegration();
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
  if (process.env.TEND_GOOGLE_CHECK_ONLY !== "1")
    writeFileSync(
      "evidence/runtime-checks.json",
      JSON.stringify(report, null, 2) + "\n",
    );
  console.log(
    JSON.stringify({
      pass: true,
      checks: checks.length,
      evidence:
        process.env.TEND_GOOGLE_CHECK_ONLY === "1"
          ? "evidence/google-runtime-checks.json"
          : "evidence/runtime-checks.json",
      scope:
        process.env.TEND_GOOGLE_CHECK_ONLY === "1"
          ? "Google-only check; historical runtime report preserved"
          : "Full original + Google runtime checks",
      raw_logs: dir,
    }),
  );
} catch (e) {
  console.error(e);
  process.exitCode = 1;
}
