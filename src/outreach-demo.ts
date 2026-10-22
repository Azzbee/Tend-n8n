import vm from "node:vm";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createLiveServer } from "./live-api.ts";
import { InternalAuth } from "./internal-auth.ts";
import { exampleLivePolicy } from "./live-policy.ts";
import { createDeskFixtureStore } from "./desk-fixture.ts";
import { demoAuth, fixtureRecords } from "./fixtures.ts";
import { buildOutreachWorkflows } from "./outreach-workflows.ts";
import { telegramReplyCode } from "./telegram.ts";
import type { DeskOutreachBackend, OutreachItem } from "./desk-model.ts";

// Fictional outreach walk-through for Chrome checks. `serve` starts the real
// fixture API (planner routes, Telegram command path, mock Gmail) and a Desk
// preview whose Outreach queue reads and writes that same API. The other
// commands drive it the way n8n and the owner would:
//   node --experimental-strip-types src/outreach-demo.ts serve
//   ... plan | telegram "/outreach" | gmail | status
// Never uses the live ports.
const reserved = [18767, 18768, 18769, 5678];
const apiPort = Number(process.env.OUTREACH_DEMO_API_PORT ?? 18831);
const deskPort = Number(process.env.OUTREACH_DEMO_DESK_PORT ?? 18832);
for (const p of [apiPort, deskPort])
  if (!Number.isInteger(p) || reserved.includes(p))
    throw new Error("Choose spare ports for the fictional outreach demo");
const api = `http://127.0.0.1:${apiPort}`;
const stateFile = ".scratch/outreach-demo/telegram-update.txt";

async function call(
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const r = await fetch(api + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await r.json()) as Record<string, unknown>;
  if (r.status !== 200)
    throw new Error(typeof json.error === "string" ? json.error : "failed");
  return json;
}
const flows = buildOutreachWorkflows();
const nodeCode = (file: string, name: string): string =>
  String(
    flows
      .find((f) => f.file === file)!
      .workflow.nodes.find((n) => n.name === name)!.parameters.jsCode,
  );
type Item = { json: Record<string, unknown> };
const run = (code: string, ctx: Record<string, unknown>): Item[] =>
  vm.runInNewContext(`(function(){${code}})()`, ctx) as Item[];

// Workflow 23 node by node: plan, local AI draft (Ollama if it answers,
// otherwise the template stays), save, mock Telegram notice.
async function plan(): Promise<void> {
  const planned = await call("/api/outreach/plan", {});
  const split = run(
    nodeCode("23-outreach-planner.json", "One item per proposal"),
    { $input: { first: () => ({ json: planned }) } },
  );
  const replies: Item[] = [];
  for (const item of split) {
    try {
      const r = await fetch("http://127.0.0.1:11434/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item.json.request),
        signal: AbortSignal.timeout(120000),
      });
      replies.push({ json: (await r.json()) as Record<string, unknown> });
    } catch {
      replies.push({ json: { error: { message: "local model unavailable" } } });
    }
  }
  const read = run(nodeCode("23-outreach-planner.json", "Read model text"), {
    $: () => ({ all: () => split }),
    $input: { all: () => replies },
  });
  for (const r of read) {
    const saved = await call("/api/outreach/draft", r.json);
    console.log(
      `${String(r.json.id)}: ${saved.accepted ? "model draft kept" : `template kept (${String(saved.problem)})`}`,
    );
  }
  if (read.length) {
    const notice = run(nodeCode("23-outreach-planner.json", "Owner notice"), {
      $input: { all: () => read },
    });
    await call(
      "/api/mock-telegram/botFIXTURE_ONLY/sendMessage",
      notice[0]!.json,
    );
  }
  console.log(
    `quiet_hours=${String(planned.quiet_hours)} created=${split.length} held_back=${JSON.stringify(planned.held_back)}`,
  );
}
// The same envelope workflow 10 sends after its owner guard, then the same
// reply formatter and mock Bot API send.
async function telegram(text: string): Promise<void> {
  mkdirSync(".scratch/outreach-demo", { recursive: true });
  let update = 1000;
  try {
    update = Number(readFileSync(stateFile, "utf8")) + 1;
  } catch {
    // First command of this demo run.
  }
  writeFileSync(stateFile, String(update));
  const result = await call("/api/telegram/command", {
    ...demoAuth,
    text,
    telegram_channel_id: "tend-course-control",
    telegram_update_id: update,
  });
  const rendered = run(telegramReplyCode, {
    $: () => ({
      first: () => ({ json: { reply_chat_id: "424242", help: false } }),
    }),
    $input: { first: () => ({ json: result.reply ?? { error: "duplicate" } }) },
  });
  await call(
    "/api/mock-telegram/botFIXTURE_ONLY/sendMessage",
    rendered[0]!.json,
  );
  console.log(String(rendered[0]!.json.text));
}
// Workflow 24 node by node: approved email only, mock drafts.create, ledger.
async function gmail(): Promise<void> {
  const approved = await call("/api/outreach/approved-email");
  const split = run(
    nodeCode("24-outreach-gmail-drafts.json", "One item per approved draft"),
    { $input: { first: () => ({ json: approved }) } },
  );
  const created: Item[] = [];
  for (const i of split)
    created.push({
      json: await call("/api/mock-gmail/gmail/v1/users/me/drafts", {
        message: i.json.message,
      }),
    });
  const receipts = run(
    nodeCode("24-outreach-gmail-drafts.json", "Read draft receipt"),
    { $: () => ({ all: () => split }), $input: { all: () => created } },
  );
  for (const r of receipts) await call("/api/outreach/gmail-draft", r.json);
  console.log(
    JSON.stringify((await call("/api/outreach/ledger")).mock_gmail_drafts),
  );
}
async function serve(): Promise<void> {
  const dir = `.scratch/outreach-demo/${Date.now()}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(stateFile, "999");
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "src/server.ts"],
    {
      env: {
        ...process.env,
        TEND_SERVER_MODE: "",
        TEND_DEMO_PORT: String(apiPort),
        TEND_DEMO_DB: `${dir}/demo.sqlite`,
        TEND_OUTREACH_DB: `${dir}/outreach.sqlite`,
        // Pinned at start so Desk expiry times read against today's clock.
        TEND_OUTREACH_CLOCK: new Date().toISOString(),
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      child.kill("SIGTERM");
      process.exit(0);
    });
  child.on("exit", (code) => {
    console.error(`Fixture API stopped (${String(code)}); demo ends.`);
    process.exit(1);
  });
  // Seed only once our own fictional fixture API answers on that port.
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    try {
      ready = (await call("/api/status")).fictional === true;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!ready) throw new Error(`No fictional fixture API on ${api}`);
  await call("/api/ingest", { records: fixtureRecords, cursor: "demo" });
  for (const [id, action, due] of [
    ["g1", "send the demo", "2026-10-15"],
    ["g2", "review your demo", "2026-10-16"],
  ] as const) {
    const record = fixtureRecords.find((r) => r.source_record_id === id)!;
    const { candidate } = (await call("/api/candidates", {
      record,
      candidate: { quote: record.body_text, action, suggested_due: due },
    })) as { candidate: { commitment_id: string } };
    await call("/api/command", {
      ...demoAuth,
      text: `/confirm ${candidate.commitment_id} ${due}`,
    });
  }
  const outreach: DeskOutreachBackend = {
    list: async () =>
      (await call("/api/outreach")) as unknown as { items: OutreachItem[] },
    approve: async (id) => (await call("/api/outreach/approve", { id })).item,
    edit: async (id, text) =>
      (await call("/api/outreach/edit", { id, text })).item,
    skip: async (id) => (await call("/api/outreach/skip", { id })).item,
  };
  const meetingAt = new Date();
  meetingAt.setUTCDate(meetingAt.getUTCDate() + 2);
  meetingAt.setUTCHours(10, 0, 0, 0);
  createLiveServer({
    policy: exampleLivePolicy,
    auth: new InternalAuth(),
    store: createDeskFixtureStore(() => new Date(), meetingAt),
    outreach: { service: outreach, route: () => Promise.resolve(null) },
  }).listen(deskPort, "127.0.0.1", () =>
    console.log(
      `Fictional outreach demo: Desk http://127.0.0.1:${deskPort}/private, fixture API ${api}`,
    ),
  );
}
const [command = "serve", ...rest] = process.argv.slice(2);
if (command === "serve") await serve();
else if (command === "plan") await plan();
else if (command === "telegram") await telegram(rest.join(" "));
else if (command === "gmail") await gmail();
else if (command === "status")
  console.log(JSON.stringify(await call("/api/outreach/ledger"), null, 2));
else throw new Error("Use serve, plan, telegram, gmail or status");
