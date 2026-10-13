import { writeFile, mkdir } from "node:fs/promises";
import {
  fixtureRecords,
  fixtureSources,
  fixtureContacts,
  fixtureIdentities,
  demoAuth,
} from "./fixtures.ts";
type Node = {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  disabled?: boolean;
  notes?: string;
  notesInFlow?: boolean;
};
type Workflow = {
  id: string;
  name: string;
  active: false;
  nodes: Node[];
  connections: Record<
    string,
    { main: { node: string; type: "main"; index: number }[][] }
  >;
  settings: {
    executionOrder: "v1";
    saveDataSuccessExecution: "all";
    saveDataErrorExecution: "all";
    timezone: "Europe/Paris";
  };
  tags: never[];
  pinData: Record<string, unknown>;
  versionId: string;
  meta: { templateCredsSetupCompleted: false };
};
const node = (
  name: string,
  type: string,
  parameters: Record<string, unknown>,
  x: number,
  y = 0,
  version = 1,
): Node => ({
  id: name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-"),
  name,
  type: `n8n-nodes-base.${type}`,
  typeVersion: version,
  position: [x, y],
  parameters,
});
const manual = () => node("Run fictional demo", "manualTrigger", {}, 0);
const code = (name: string, jsCode: string, x: number) =>
  node(name, "code", { jsCode }, x, 0, 2);
const http = (name: string, path: string, x: number, body?: string): Node => ({
  ...node(
    name,
    "httpRequest",
    {
      url: `http://host.docker.internal:18767${path}`,
      ...(body
        ? {
            method: "POST",
            sendBody: true,
            contentType: "raw",
            rawContentType: "application/json",
            body,
          }
        : {}),
      options: { timeout: 10000 },
    },
    x,
    0,
    4.2,
  ),
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 1000,
});
const sub = (name: string, id: string, x: number) =>
  node(
    name,
    "executeWorkflow",
    {
      source: "database",
      workflowId: { __rl: true, value: id, mode: "id" },
      mode: "once",
      options: { waitForSubWorkflow: true },
    },
    x,
    0,
    1.3,
  );
function workflow(
  id: string,
  name: string,
  nodes: Node[],
  connections?: Workflow["connections"],
): Workflow {
  const con: Workflow["connections"] = connections ?? {};
  if (!connections)
    for (let i = 0; i < nodes.length - 1; i++)
      con[nodes[i]!.name] = {
        main: [[{ node: nodes[i + 1]!.name, type: "main", index: 0 }]],
      };
  return {
    id,
    name,
    active: false,
    nodes,
    connections: con,
    settings: {
      executionOrder: "v1",
      saveDataSuccessExecution: "all",
      saveDataErrorExecution: "all",
      timezone: "Europe/Paris",
    },
    tags: [],
    pinData: {},
    versionId: `00000000-0000-4000-8000-${id.replace(/\D/g, "").padStart(12, "0")}`,
    meta: { templateCredsSetupCompleted: false },
  };
}
const workflows: Workflow[] = [];
const adapters = [
  ["gmail", "01-gmail"],
  ["calendar", "02-calendar"],
  ["whatsapp_personal", "03-whatsapp-personal"],
  ["whatsapp_business", "04-whatsapp-business"],
  ["linkedin", "05-linkedin"],
] as const;
for (const [source, file] of adapters) {
  const n = manual();
  n.notes =
    "Fictional snapshot/fixture adapter only. No live account, provider credential or message trigger is connected.";
  n.notesInFlow = true;
  workflows.push(
    workflow(
      `TendReview${file.slice(0, 2)}`,
      `Tend ${file}: FICTIONAL adapter`,
      [
        n,
        http("Read fictional source", `/api/fixtures/${source}`, 260),
        sub("Normalize and persist", "TendReview06", 540),
      ],
    ),
  );
}
const validate = `const input=$input.first().json; if(input.fictional!==true || !Array.isArray(input.records))throw new Error('fictional fixture envelope required'); for(const r of input.records){ if(r.owner_id!=='demo-owner' || !r.evidence_reference.startsWith('fixture://') || !['fixture','snapshot'].includes(r.ingestion_mode))throw new Error('fictional owner/source required'); } return [{json:input}];`;
workflows.push(
  workflow("TendReview06", "Tend 06: Normalize and Store (local SQLite API)", [
    node(
      "When called by adapter",
      "executeWorkflowTrigger",
      { inputSource: "passthrough" },
      0,
      0,
      1.1,
    ),
    code("Validate fictional scope", validate, 260),
    http(
      "Normalize and commit transaction",
      "/api/ingest",
      540,
      "={{ JSON.stringify($json) }}",
    ),
  ]),
);
const validateModel = `const result=$input.first().json; const candidate=JSON.parse(result.message.content); const record=$('Prepare local AI request').first().json.record; const keys=Object.keys(candidate);if(keys.length!==3||keys.some(k=>!['quote','action','suggested_due'].includes(k)))throw new Error('invalid model fields');if(typeof candidate.quote!=='string'||typeof candidate.action!=='string'||!record.body_text.includes(candidate.quote)||!candidate.quote.toLowerCase().includes(candidate.action.toLowerCase())||!/\\bI (?:will|promise to)\\b/i.test(candidate.quote))throw new Error('fabricated quote/action');if(candidate.suggested_due!==null && (typeof candidate.suggested_due!=='string'||!/^\\d{4}-\\d{2}-\\d{2}$/.test(candidate.suggested_due)||!candidate.quote.includes(candidate.suggested_due)))throw new Error('fabricated date');return [{json:{record,candidate}}];`;
const ai = http(
  "Local AI extraction (Ollama)",
  "",
  510,
  "={{ JSON.stringify($json.request) }}",
);
ai.parameters.url = "http://host.docker.internal:11434/api/chat";
ai.parameters.options = { timeout: 120000 };
ai.retryOnFail = false;
workflows.push(
  workflow(
    "TendReview07",
    "Tend 07: Extract Commitments (local AI, pending only)",
    [
      manual(),
      http("Prepare local AI request", "/api/model-input", 250),
      ai,
      code("Validate quoted model result", validateModel, 790),
      http(
        "Persist pending candidate",
        "/api/candidates",
        1070,
        "={{ JSON.stringify($json) }}",
      ),
    ],
  ),
);
const input = code(
  "Fictional private command",
  `return [{json:${JSON.stringify(demoAuth)}}];`,
  250,
);
const ownerCheck = code(
  "Authorize owner and private chat",
  `const x=$input.first().json;if(x.owner_id!=='demo-owner'||x.user_id!=='demo-user'||x.chat_id!=='demo-private'||x.chat_type!=='private')throw new Error('unauthorized before retrieval');return [{json:x}];`,
  500,
);
const allow = node(
  "Allowed command",
  "if",
  {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: "",
        typeValidation: "strict",
        version: 2,
      },
      conditions: [
        {
          id: "command-check",
          leftValue: "={{ $json.text }}",
          rightValue: "^/(prep|today|draft|confirm|done|cancel|status)(\\s|$)",
          operator: { type: "string", operation: "regex" },
        },
      ],
      combinator: "and",
    },
    options: {},
  },
  740,
  0,
  2.2,
);
const call = http(
  "Owner-scoped router and briefing",
  "/api/command",
  1000,
  "={{ JSON.stringify($json) }}",
);
const reject = code(
  "Reject command",
  "throw new Error('unsupported command');",
  1000,
);
reject.position[1] = 180;
workflows.push(
  workflow(
    "TendReview08",
    "Tend 08: Assistant Router and Briefing (private local preview)",
    [manual(), input, ownerCheck, allow, call, reject],
    {
      "Run fictional demo": {
        main: [[{ node: input.name, type: "main", index: 0 }]],
      },
      [input.name]: {
        main: [[{ node: ownerCheck.name, type: "main", index: 0 }]],
      },
      [ownerCheck.name]: {
        main: [[{ node: allow.name, type: "main", index: 0 }]],
      },
      [allow.name]: {
        main: [
          [{ node: call.name, type: "main", index: 0 }],
          [{ node: reject.name, type: "main", index: 0 }],
        ],
      },
    },
  ),
);
workflows.push(
  workflow("TendReview09", "Tend 09: Bounded Retry Fixture (synthetic 429)", [
    manual(),
    http("Retry synthetic 429 then recover", "/api/transient", 260),
    code(
      "Record recovery only",
      "if($input.first().json.recovered!==true)throw new Error('recovery failed');return $input.all();",
      540,
    ),
  ]),
);
for (const w of workflows.slice(0, 5)) {
  const call = w.nodes[w.nodes.length - 1]!;
  call.parameters = {
    source: "parameter",
    workflowJson: JSON.stringify(workflows[5]),
    mode: "once",
    options: { waitForSubWorkflow: true },
  };
}
await mkdir("workflows", { recursive: true });
for (let i = 0; i < workflows.length; i++)
  await writeFile(
    `workflows/${String(i + 1).padStart(2, "0")}-${["gmail", "calendar", "whatsapp-personal", "whatsapp-business", "linkedin", "normalize-store", "extract-commitments", "assistant", "retry-fixture"][i]}.json`,
    JSON.stringify(workflows[i], null, 2) + "\n",
  );
await mkdir("fixtures", { recursive: true });
await writeFile(
  "fixtures/demo.json",
  JSON.stringify(
    {
      fictional: true,
      clock: "2026-10-13",
      contacts: fixtureContacts,
      identities: fixtureIdentities,
      sources: fixtureSources,
      records: fixtureRecords,
      command: demoAuth,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Built ${workflows.length} inactive workflow exports and fictional fixture data.`,
);
