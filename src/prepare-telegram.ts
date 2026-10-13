import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isRecord } from "./engine.ts";

// Native Telegram derives its webhook header secret from workflow and trigger IDs.
// Keep this deployment copy private. Never publish it with the review templates.
const workflow: unknown = JSON.parse(
  readFileSync("workflows/10-telegram-private.json", "utf8"),
);
if (!isRecord(workflow) || !Array.isArray(workflow.nodes))
  throw new Error("invalid Telegram template");
workflow.id = randomUUID();
workflow.versionId = randomUUID();
for (const node of workflow.nodes) {
  if (!isRecord(node)) throw new Error("invalid node");
  node.id = randomUUID();
  if (node.type === "n8n-nodes-base.telegramTrigger")
    node.webhookId = randomUUID();
}
mkdirSync(".scratch/live-telegram", { recursive: true, mode: 0o700 });
writeFileSync(
  ".scratch/live-telegram/workflow.json",
  JSON.stringify(workflow, null, 2) + "\n",
  { mode: 0o600, flag: "wx" },
);
console.log(
  "Prepared private deployment copy in .scratch/live-telegram/workflow.json. No token or owner ID was read. Import only this private copy for live setup.",
);
