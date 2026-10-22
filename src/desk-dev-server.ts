import { createLiveServer } from "./live-api.ts";
import { InternalAuth } from "./internal-auth.ts";
import { exampleLivePolicy } from "./live-policy.ts";
import { createPrivateOutreach } from "./outreach-service.ts";
import { createDeskFixtureStore } from "./desk-fixture.ts";
import type { LiveStore } from "./live-store.ts";
import {
  createWorkflowRunsReader,
  dockerRunner,
  exportedWorkflowNames,
} from "./desk-runs.ts";

// Fictional-only Desk preview through the production live server and outreach wiring.
// Never point it at the private store or the live ports.
const port = Number(process.env.DESK_DEV_PORT ?? 18795);
if (!Number.isInteger(port) || [18767, 18768, 18769, 5678].includes(port))
  throw new Error("Choose a spare port for the fictional Desk preview");
const meetingAt = new Date();
meetingAt.setUTCDate(meetingAt.getUTCDate() + 2);
meetingAt.setUTCHours(10, 0, 0, 0);
const store = createDeskFixtureStore(() => new Date(), meetingAt);
// Outreach awaits each store call, so the synchronous fixture store works as in tests/outreach-api.test.ts.
const outreach = createPrivateOutreach(
  store as unknown as LiveStore,
  exampleLivePolicy.principal_id,
  {
    TEND_OUTREACH_DB: ":memory:",
    OUTREACH_ENABLED: "false",
  },
);
const plan = await outreach.route("POST", "/api/live/outreach/plan", {});
createLiveServer({
  policy: exampleLivePolicy,
  auth: new InternalAuth(),
  store,
  outreach,
  // DESK_DEV_RUNS=live reads last-run status (names, outcomes, times only) from the n8n container.
  ...(process.env.DESK_DEV_RUNS === "live"
    ? {
        workflowRuns: createWorkflowRunsReader({
          run: dockerRunner("tend-nocode-live"),
          names: exportedWorkflowNames(),
        }),
      }
    : {}),
}).listen(port, "127.0.0.1", () =>
  console.log(
    `Fictional Desk preview at http://127.0.0.1:${port}/private (planner: ${JSON.stringify(plan?.body).slice(0, 200)})`,
  ),
);
