import { GMAIL_DRAFTS_CREATE_URL } from "./outreach-gmail.ts";

// Workflows 22-25: outreach planner and Gmail-draft steps for both lanes.
// The fictional lane talks to the fixture API, Ollama and the mock Gmail and
// Telegram; the private lane is an inactive template with credential
// placeholders, gated by OUTREACH_ENABLED on the private API.
interface OutreachNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  onError?: "continueRegularOutput";
  notes?: string;
  notesInFlow?: boolean;
}
interface OutreachWorkflow {
  id: string;
  name: string;
  active: false;
  nodes: OutreachNode[];
  connections: Record<
    string,
    { main: { node: string; type: "main"; index: number }[][] }
  >;
  settings: {
    executionOrder: "v1";
    timezone: "Europe/Paris";
    saveDataSuccessExecution: "all" | "none";
    saveDataErrorExecution: "all" | "none";
    saveManualExecutions?: false;
    executionTimeout: number;
    errorWorkflow?: string;
  };
  tags: never[];
  pinData: Record<string, never>;
  versionId: string;
  meta: { templateCredsSetupCompleted: false };
}
type Lane = "fictional" | "private";
const lanes = {
  fictional: {
    base: "http://host.docker.internal:18767/api/outreach",
    label: "fictional lane",
  },
  private: {
    base: "http://host.docker.internal:18768/api/live/outreach",
    label: "private, inactive template",
  },
} as const;
const internalCredential = {
  httpHeaderAuth: {
    id: "CONFIGURE_INTERNAL_API_CREDENTIAL_ID",
    name: "CONFIGURE_INTERNAL_API_CREDENTIAL",
  },
};
const gmailComposeCredential = {
  gmailOAuth2: {
    id: "CONFIGURE_GMAIL_COMPOSE_CREDENTIAL_ID",
    name: "CONFIGURE_GMAIL_COMPOSE_CREDENTIAL",
  },
};
function builder(id: string, name: string, lane: Lane) {
  const nodes: OutreachNode[] = [];
  const connections: OutreachWorkflow["connections"] = {};
  const add = (
    nodeName: string,
    type: string,
    parameters: Record<string, unknown>,
    version: number,
    extra: Partial<OutreachNode> = {},
  ): OutreachNode => {
    const n: OutreachNode = {
      id: nodeName.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name: nodeName,
      type: `n8n-nodes-base.${type}`,
      typeVersion: version,
      position: [nodes.length * 260, 0],
      parameters,
      ...extra,
    };
    nodes.push(n);
    return n;
  };
  const link = (from: OutreachNode, to: OutreachNode): void => {
    connections[from.name] = {
      main: [
        [
          ...(connections[from.name]?.main[0] ?? []),
          { node: to.name, type: "main", index: 0 },
        ],
      ],
    };
  };
  const chain = (...list: OutreachNode[]): void => {
    for (let i = 0; i < list.length - 1; i++) link(list[i]!, list[i + 1]!);
  };
  const api = (nodeName: string, path: string, body?: string): OutreachNode =>
    add(
      nodeName,
      "httpRequest",
      {
        url: `${lanes[lane].base}${path}`,
        ...(body
          ? {
              method: "POST",
              sendBody: true,
              contentType: "raw",
              rawContentType: "application/json",
              body,
            }
          : {}),
        ...(lane === "private"
          ? {
              authentication: "genericCredentialType",
              genericAuthType: "httpHeaderAuth",
            }
          : {}),
        options: { timeout: 10000 },
      },
      4.2,
      lane === "private"
        ? {
            credentials: internalCredential,
            notes:
              "Bind the private Header Auth credential. No secret is included in this inactive export.",
            notesInFlow: true,
          }
        : {},
    );
  const triggers = (hours: number | null, minutes: number | null) => {
    const list = [
      add(
        hours ? "Every hour" : "Every 10 minutes",
        "scheduleTrigger",
        {
          rule: {
            interval: [
              hours
                ? { field: "hours", hoursInterval: hours }
                : { field: "minutes", minutesInterval: minutes },
            ],
          },
        },
        1.2,
      ),
    ];
    if (lane === "fictional")
      list.push(add("Run fictional demo", "manualTrigger", {}, 1));
    return list;
  };
  const finish = (): OutreachWorkflow => ({
    id,
    name,
    active: false,
    nodes,
    connections,
    settings: {
      executionOrder: "v1",
      timezone: "Europe/Paris",
      executionTimeout: 300,
      ...(lane === "private"
        ? {
            saveDataSuccessExecution: "none",
            saveDataErrorExecution: "none",
            saveManualExecutions: false,
            errorWorkflow: "TendPrivate22",
          }
        : {
            saveDataSuccessExecution: "all",
            saveDataErrorExecution: "all",
            errorWorkflow: "TendReview21",
          }),
    },
    tags: [],
    pinData: {},
    versionId: `${id.toLowerCase()}-v1`,
    meta: { templateCredsSetupCompleted: false },
  });
  return { add, api, chain, link, triggers, finish };
}
const splitPlan = `const x=$input.first().json;if(!x||!Array.isArray(x.created))throw new Error('invalid outreach plan');return x.created.map(i=>({json:{id:i.id,request:i.request}}));`;
// Pairs each model reply with its proposal by position; a failed or
// malformed reply becomes text:null so the API keeps the template draft.
const readModel = `const props=$('One item per proposal').all();return $input.all().map((it,i)=>{let text=null;try{const c=it.json&&it.json.message&&it.json.message.content;const o=typeof c==='string'?JSON.parse(c):null;if(o&&typeof o.text==='string')text=o.text.slice(0,1200);}catch(e){}return {json:{id:props[i].json.id,text}};});`;
const ownerNotice = `const n=$input.all().length;return [{json:{chat_id:'424242',text:'Course demo • fictional data\\n'+n+' outreach draft(s) wait for your approval. Reply /outreach to review. Nothing is sent until you approve.'}}];`;
const splitApproved = `const x=$input.first().json;if(!x||!Array.isArray(x.items))throw new Error('invalid approved list');return x.items.map(i=>({json:{id:i.id,approval_hash:i.approval_hash,message:{raw:i.message.raw}}}));`;
const receipt = `const sent=$('One item per approved draft').all();return $input.all().map((it,i)=>{if(!it.json||typeof it.json.id!=='string')throw new Error('Gmail draft receipt missing');return {json:{id:sent[i].json.id,approval_hash:sent[i].json.approval_hash,draft_id:it.json.id}};});`;

function planner(id: string, name: string, lane: Lane): OutreachWorkflow {
  const b = builder(id, name, lane);
  const starts = b.triggers(1, null);
  const plan = b.api(
    "Plan outreach (quiet hours, 3-day limit)",
    "/plan",
    "={{ JSON.stringify({}) }}",
  );
  plan.notes =
    "Proposes nudges, updates, meeting follow-ups and replies from confirmed promises and meetings. Instruction-like messages are held back, never drafted.";
  for (const s of starts) b.link(s, plan);
  const split = b.add(
    "One item per proposal",
    "code",
    { jsCode: splitPlan },
    2,
  );
  const model = b.add(
    "Local AI draft (Ollama, cited evidence only)",
    "httpRequest",
    {
      url: "http://host.docker.internal:11434/api/chat",
      method: "POST",
      sendBody: true,
      contentType: "raw",
      rawContentType: "application/json",
      body: "={{ JSON.stringify($json.request) }}",
      options: { timeout: 60000 },
    },
    4.2,
    { onError: "continueRegularOutput" },
  );
  const read = b.add("Read model text", "code", { jsCode: readModel }, 2);
  const save = b.api(
    "Save draft if every detail is cited",
    "/draft",
    "={{ JSON.stringify($json) }}",
  );
  b.chain(plan, split, model, read, save);
  if (lane === "fictional") {
    const notice = b.add("Owner notice", "code", { jsCode: ownerNotice }, 2);
    const telegram = b.add(
      "Tell owner on mock Telegram",
      "httpRequest",
      {
        url: "http://host.docker.internal:18767/api/mock-telegram/botFIXTURE_ONLY/sendMessage",
        method: "POST",
        sendBody: true,
        contentType: "raw",
        rawContentType: "application/json",
        body: "={{ JSON.stringify($json) }}",
        options: { timeout: 10000 },
      },
      4.2,
    );
    b.chain(save, notice, telegram);
  }
  return b.finish();
}
function gmailDrafts(id: string, name: string, lane: Lane): OutreachWorkflow {
  const b = builder(id, name, lane);
  const starts = b.triggers(null, 10);
  const list = b.api("Approved email only", "/approved-email");
  list.notes =
    "Returns only email items whose exact text the owner approved in the last 24 hours, with a re-verified recipient. Empty while OUTREACH_ENABLED is not true.";
  for (const s of starts) b.link(s, list);
  const split = b.add(
    "One item per approved draft",
    "code",
    { jsCode: splitApproved },
    2,
  );
  const create = b.add(
    "Create Gmail draft (drafts.create only)",
    "httpRequest",
    {
      url:
        lane === "fictional"
          ? "http://host.docker.internal:18767/api/mock-gmail/gmail/v1/users/me/drafts"
          : GMAIL_DRAFTS_CREATE_URL,
      method: "POST",
      sendBody: true,
      contentType: "raw",
      rawContentType: "application/json",
      body: "={{ JSON.stringify({ message: { raw: $json.message.raw } }) }}",
      ...(lane === "private"
        ? {
            authentication: "predefinedCredentialType",
            nodeCredentialType: "gmailOAuth2",
          }
        : {}),
      options: { timeout: 10000 },
    },
    4.2,
    {
      retryOnFail: false,
      notes:
        lane === "private"
          ? "Creates a draft in the owner's Gmail; the owner presses Send. Needs a Gmail credential with the gmail.compose scope only, re-consented by the owner. Never change this URL to a send endpoint."
          : "Mock Gmail on the fixture API: accepts drafts.create for example.invalid recipients only.",
      notesInFlow: true,
      ...(lane === "private" ? { credentials: gmailComposeCredential } : {}),
    },
  );
  const read = b.add("Read draft receipt", "code", { jsCode: receipt }, 2);
  const record = b.api(
    "Record draft in send ledger",
    "/gmail-draft",
    "={{ JSON.stringify($json) }}",
  );
  b.chain(list, split, create, read, record);
  return b.finish();
}
export function buildOutreachWorkflows(): {
  file: string;
  workflow: OutreachWorkflow;
}[] {
  return [
    {
      file: "23-outreach-planner.json",
      workflow: planner(
        "TendReview23",
        `Tend 23: Outreach planner (${lanes.fictional.label})`,
        "fictional",
      ),
    },
    {
      file: "24-outreach-gmail-drafts.json",
      workflow: gmailDrafts(
        "TendReview24",
        `Tend 24: Approved outreach to mock Gmail drafts (${lanes.fictional.label})`,
        "fictional",
      ),
    },
    {
      file: "25-private-outreach-planner.json",
      workflow: planner(
        "TendLiveOutreachPlanner",
        `Tend 25: Outreach planner (${lanes.private.label})`,
        "private",
      ),
    },
    {
      file: "26-private-outreach-gmail-drafts.json",
      workflow: gmailDrafts(
        "TendLiveOutreachGmail",
        `Tend 26: Approved outreach to Gmail drafts (${lanes.private.label})`,
        "private",
      ),
    },
  ];
}
// Canvas notes for improve/lead's withCanvasNote(), keyed by workflow ID.
export const outreachCanvasNotes: Record<
  string,
  { purpose: string; inputs: string; outputs: string; privacy: string }
> = {
  TendReview23: {
    purpose:
      "Hourly outreach planner: proposes nudges, status updates, meeting follow-ups and replies, then drafts each with local AI.",
    inputs:
      "Confirmed fictional promises, meetings and threads from the fixture API; Ollama for the draft text.",
    outputs:
      "Pending drafts in the outreach queue (Desk and Telegram /outreach) and one mock Telegram notice.",
    privacy:
      "Fictional data only. Quiet hours 21:00-08:00 Paris, one proposal per item per 3 days, instruction-like messages held back. Nothing is sent.",
  },
  TendReview24: {
    purpose:
      "Turns owner-approved email drafts into mock Gmail drafts and records them in the send ledger.",
    inputs:
      "Approved email items with their exact approved text from the fixture API.",
    outputs:
      "A mock Gmail draft per item and a gmail_draft_created ledger entry.",
    privacy:
      "Mock Gmail accepts drafts.create for example.invalid recipients only. No real account is reached.",
  },
  TendLiveOutreachPlanner: {
    purpose:
      "Private outreach planner template: the same rules as 23 against the private API.",
    inputs:
      "Private promises, meetings and threads through the internal API; local Ollama.",
    outputs:
      "Pending drafts for the owner to approve on the Desk or in Telegram.",
    privacy:
      "Inactive template, no saved execution data, internal credential placeholder. n8n cannot approve; nothing is sent.",
  },
  TendLiveOutreachGmail: {
    purpose:
      "Creates a Gmail draft for each owner-approved email so the owner presses Send in Gmail.",
    inputs:
      "Approved email items from the private API, returned only while OUTREACH_ENABLED=true.",
    outputs: "A draft in the owner's Gmail and a ledger receipt.",
    privacy:
      "Calls users.drafts.create only, with a gmail.compose credential placeholder; never a send endpoint. Inactive, no saved execution data.",
  },
};
