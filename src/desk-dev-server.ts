import { createServer } from "node:http";
import { createPrivateWebHandler } from "./private-web.ts";
import { exampleLivePolicy } from "./live-policy.ts";
import {
  createDeskFixtureStore,
  deskFixtureFailures,
  deskFixtureOutreach,
} from "./desk-fixture.ts";
import type {
  DeskOutreachBackend,
  DeskWorkflowRun,
  OutreachItem,
} from "./desk-model.ts";

// Fictional-only Desk preview for visual checks. Never point it at the private store or port 18768.
const port = Number(process.env.DESK_DEV_PORT ?? 18795);
if (!Number.isInteger(port) || [18767, 18768, 18769, 5678].includes(port))
  throw new Error("Choose a spare port for the fictional Desk preview");
const now = new Date();
const meetingAt = new Date(now);
meetingAt.setUTCDate(meetingAt.getUTCDate() + 2);
meetingAt.setUTCHours(10, 0, 0, 0);
const store = createDeskFixtureStore(() => new Date(), meetingAt);
let items: OutreachItem[] = deskFixtureOutreach(now);
const change = (id: string, patch: Partial<OutreachItem>): OutreachItem => {
  const item = items.find((i) => i.id === id);
  if (!item || item.status !== "pending") throw new Error("not pending");
  const next = { ...item, ...patch };
  items = items.map((i) => (i.id === id ? next : i));
  return next;
};
const outreach: DeskOutreachBackend = {
  list: () => Promise.resolve({ items }),
  approve: (id) =>
    Promise.resolve(
      change(id, {
        status:
          items.find((i) => i.id === id)?.channel === "email"
            ? "gmail_draft_created"
            : "approved",
      }),
    ),
  edit: (id, text) => Promise.resolve(change(id, { draft_text: text })),
  skip: (id) => Promise.resolve(change(id, { status: "skipped" })),
};
const handler = createPrivateWebHandler({
  store,
  policy: exampleLivePolicy,
  ...(process.env.DESK_DEV_OUTREACH === "off" ? {} : { outreach }),
  failureLog: () => Promise.resolve(deskFixtureFailures),
  workflowRuns: () =>
    Promise.resolve(
      ["01", "02", "03", "04", "05", "06", "07", "08", "09"].map(
        (id): DeskWorkflowRun => ({
          id,
          name: id,
          lane: "classroom",
          last_status: id === "07" ? "error" : "success",
          last_run_at: now.toISOString(),
        }),
      ),
    ),
});
createServer((req, res) => {
  void handler(req, res).then((handled) => {
    if (handled) return;
    // A redirect here would let /favicon.ico mint a new unlock cookie and void the page nonce.
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found. Open /private.");
  });
}).listen(port, "127.0.0.1", () =>
  console.log(`Fictional Desk preview at http://127.0.0.1:${port}/private`),
);
