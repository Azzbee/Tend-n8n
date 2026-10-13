import { writeFile, mkdir } from "node:fs/promises";
import { format } from "prettier";
import { telegramGuardCode, telegramReplyCode } from "./telegram.ts";
async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(
    path,
    await format(JSON.stringify(value), { parser: "json" }),
  );
}
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
  credentials?: Record<string, { id: string; name: string }>;
  webhookId?: string;
  continueOnFail?: boolean;
};
type Workflow = {
  id: string;
  name: string;
  active: false;
  nodes: Node[];
  connections: Record<
    string,
    Record<string, { node: string; type: string; index: number }[][]>
  >;
  settings: {
    executionOrder: "v1";
    saveDataSuccessExecution: "all" | "none";
    saveDataErrorExecution: "all" | "none";
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
const validateModel = `const result=$input.first().json; const candidate=typeof result.text==='string'?JSON.parse(result.text):result; const record=$('Prepare local AI request').first().json.record; const keys=Object.keys(candidate);if(keys.length!==3||keys.some(k=>!['quote','action','suggested_due'].includes(k)))throw new Error('invalid model fields');if(typeof candidate.quote!=='string'||typeof candidate.action!=='string'||!record.body_text.includes(candidate.quote)||!candidate.quote.toLowerCase().includes(candidate.action.toLowerCase())||candidate.quote!==record.body_text.trim()||record.body_text.includes('\\n')||!/^I (?:will|promise to)\\b/i.test(candidate.quote))throw new Error('fabricated quote/action');if(candidate.suggested_due!==null && (typeof candidate.suggested_due!=='string'||!/^\\d{4}-\\d{2}-\\d{2}$/.test(candidate.suggested_due)||!candidate.quote.includes(candidate.suggested_due)))throw new Error('fabricated date');return [{json:{record,candidate}}];`;
const ai: Node = {
  ...node(
    "Local AI extraction (Basic LLM Chain)",
    "chainLlm",
    {
      promptType: "define",
      text: "={{ $json.request.messages[1].content }}",
      messages: {
        messageValues: [
          {
            type: "SystemMessagePromptTemplate",
            message: "={{ $json.request.messages[0].content }}",
          },
        ],
      },
      batching: { batchSize: 1 },
    },
    760,
    0,
    1.9,
  ),
  type: "@n8n/n8n-nodes-langchain.chainLlm",
};
workflows.push(
  workflow(
    "TendReview07",
    "Tend 07: Extract Commitments (local AI, pending only)",
    [
      manual(),
      code(
        "Select fictional record",
        'return [{json:{source_record_id:"g1"}}];',
        250,
      ),
      {
        ...http("Prepare local AI request", "/api/model-input", 500),
        parameters: {
          ...http("Prepare local AI request", "/api/model-input", 500)
            .parameters,
          url: "={{ 'http://host.docker.internal:18767/api/model-input?record_id=' + encodeURIComponent($json.source_record_id) }}",
        },
      },
      { ...ai, position: [760, 0] },
      code("Validate quoted model result", validateModel, 1030),
      http(
        "Persist pending candidate",
        "/api/candidates",
        1300,
        "={{ JSON.stringify($json) }}",
      ),
    ],
  ),
);
const model: Node = {
  ...node(
    "Local Ollama Chat Model",
    "lmChatOllama",
    {
      model: "qwen3:0.6b",
      options: {
        temperature: 0,
        format: "json",
        think: false,
        numCtx: 2048,
        numPredict: 512,
      },
    },
    760,
    260,
  ),
  type: "@n8n/n8n-nodes-langchain.lmChatOllama",
  credentials: {
    ollamaApi: {
      id: "TendReviewLocalOllama",
      name: "Tend review local Ollama (no key)",
    },
  },
};
workflows[6]!.nodes.push(model);
workflows[6]!.connections[model.name] = {
  ai_languageModel: [[{ node: ai.name, type: "ai_languageModel", index: 0 }]],
};
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
    code(
      "Begin isolated retry scenario",
      "return [{json:{run_id:Date.now()+'-'+Math.random().toString(16).slice(2)}}];",
      220,
    ),
    {
      ...http("Retry synthetic 429 then recover", "/api/transient", 450),
      parameters: {
        url: "={{ 'http://host.docker.internal:18767/api/transient?run_id=' + encodeURIComponent($json.run_id) }}",
        options: { timeout: 10000 },
      },
    },
    code(
      "Record recovery only",
      "const result=$input.first().json;if(result.recovered!==true||result.attempt!==3)throw new Error('three-attempt recovery failed');return $input.all();",
      710,
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
const telegramCredential = {
  telegramApi: { id: "TendReviewTelegram", name: "TendReviewTelegram" },
};
const liveTelegram = workflow(
  "TendLiveTelegram",
  "Tend 10: Private Telegram control (fictional evidence)",
  [
    {
      ...node(
        "Telegram private message",
        "telegramTrigger",
        {
          updates: ["message"],
          additionalFields: {
            download: false,
            chatIds: "CONFIGURE_OWNER_CHAT_ID",
            userIds: "CONFIGURE_OWNER_USER_ID",
          },
        },
        0,
        0,
        1.5,
      ),
      webhookId: "GENERATE_PRIVATE_DEPLOYMENT_COPY",
      credentials: telegramCredential,
    },
    code("Authorize Telegram owner", telegramGuardCode, 270),
    {
      ...http(
        "Read or change fictional demo state",
        "/api/telegram/command",
        560,
        "={{ JSON.stringify({...$json.command,telegram_update_id:$json.telegram_update_id,telegram_channel_id:$json.telegram_channel_id}) }}",
      ),
      retryOnFail: false,
      continueOnFail: true,
    },
    code(
      "Continue only a newly committed update",
      "const result=$input.first().json;if(result.accepted!==true||!result.reply||typeof result.reply!=='object')return [];return [{json:result.reply}];",
      720,
    ),
    code("Format private owner reply", telegramReplyCode, 840),
    {
      ...node(
        "Reply only to the authorized owner",
        "telegram",
        {
          resource: "message",
          operation: "sendMessage",
          chatId: "={{ $json.chat_id }}",
          text: "={{ $json.text }}",
          additionalFields: {
            parse_mode: "HTML",
            appendAttribution: false,
            disable_web_page_preview: true,
            disable_notification: true,
          },
        },
        1120,
        0,
        1.2,
      ),
      credentials: telegramCredential,
    },
    http(
      "Record Telegram send acknowledgement",
      "/api/telegram/ack",
      1380,
      "={{ JSON.stringify({...$('Authorize Telegram owner').first().json.command,telegram_update_id:$('Authorize Telegram owner').first().json.telegram_update_id,telegram_channel_id:$('Authorize Telegram owner').first().json.telegram_channel_id,telegram_message_id:($json.result?.message_id ?? $json.message_id)}) }}",
    ),
  ],
);
liveTelegram.settings.saveDataSuccessExecution = "none";
liveTelegram.settings.saveDataErrorExecution = "none";
workflows.push(liveTelegram);
await mkdir("workflows", { recursive: true });
for (let i = 0; i < workflows.length; i++)
  await writeJson(
    `workflows/${String(i + 1).padStart(2, "0")}-${["gmail", "calendar", "whatsapp-personal", "whatsapp-business", "linkedin", "normalize-store", "extract-commitments", "assistant", "retry-fixture", "telegram-private"][i]}.json`,
    workflows[i],
  );
await mkdir("fixtures", { recursive: true });
await writeJson("fixtures/local-ollama.json", [
  {
    id: "TendReviewLocalOllama",
    name: "Tend review local Ollama (no key)",
    type: "ollamaApi",
    data: { baseUrl: "http://host.docker.internal:11434" },
  },
]);
await writeJson("fixtures/demo.json", {
  fictional: true,
  clock: "2026-10-13",
  contacts: fixtureContacts,
  identities: fixtureIdentities,
  sources: fixtureSources,
  records: fixtureRecords,
  command: demoAuth,
});
console.log(
  `Built ${workflows.length} inactive workflow exports and fictional fixture data.`,
);
