import { writeFile, mkdir } from "node:fs/promises";
import { format } from "prettier";
import {
  telegramGuardCode,
  telegramReplyCode,
  telegramLiveGuardCode,
  telegramLiveReplyCode,
} from "./telegram.ts";
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
    saveManualExecutions?: boolean;
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
  telegramApi: {
    id: "CONFIGURE_TELEGRAM_CREDENTIAL_ID",
    name: "CONFIGURE_TELEGRAM_CREDENTIAL",
  },
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
// Live templates never carry saved connection values or an actual owner account.
const internalCredential = {
  httpHeaderAuth: {
    id: "CONFIGURE_INTERNAL_API_CREDENTIAL_ID",
    name: "CONFIGURE_INTERNAL_API_CREDENTIAL",
  },
};
const gmailCredential = {
  gmailOAuth2: {
    id: "CONFIGURE_GMAIL_READONLY_CREDENTIAL_ID",
    name: "CONFIGURE_GMAIL_READONLY_CREDENTIAL",
  },
};
const calendarCredential = {
  googleCalendarOAuth2Api: {
    id: "CONFIGURE_CALENDAR_READONLY_CREDENTIAL_ID",
    name: "CONFIGURE_CALENDAR_READONLY_CREDENTIAL",
  },
};
function liveHttp(name: string, path: string, x: number, body?: string): Node {
  const n = http(name, path, x, body);
  n.parameters = {
    ...n.parameters,
    url: `http://host.docker.internal:18768${path}`,
    authentication: "genericCredentialType",
    genericAuthType: "httpHeaderAuth",
    options: { timeout: 5000 },
  };
  n.credentials = internalCredential;
  n.retryOnFail = false;
  n.notes =
    "Bind a newly entered private Header Auth credential. No secret or real principal is included in this inactive export.";
  n.notesInFlow = true;
  return n;
}
function condition(name: string, field: string, x: number): Node {
  return node(
    name,
    "if",
    {
      conditions: {
        options: { caseSensitive: true, typeValidation: "strict", version: 2 },
        conditions: [
          {
            id: "condition",
            leftValue: `={{ $json.${field} }}`,
            rightValue: true,
            operator: { type: "boolean", operation: "true", singleValue: true },
          },
        ],
        combinator: "and",
      },
      options: {},
    },
    x,
    0,
    2.2,
  );
}
function connect(w: Workflow, from: string, to: string, output = 0): void {
  const prior = w.connections[from]?.main ?? [];
  while (prior.length <= output) prior.push([]);
  prior[output]!.push({ node: to, type: "main", index: 0 });
  w.connections[from] = { main: prior };
}
function privateWorkflow(id: string, title: string): Workflow {
  const w = workflow(id, title, [], {});
  w.settings.saveDataSuccessExecution = "none";
  w.settings.saveDataErrorExecution = "none";
  w.settings.saveManualExecutions = false;
  return w;
}
const approvedStateCode = `const x=$input.first().json;if(!x||typeof x.account_email!=='string'||!x.account_email.includes('@')||!['gmail','calendar'].includes(x.source))throw new Error('invalid approved sync state');const start=Date.parse(x.window_start),end=Date.parse(x.window_end);const b=x.budget;const valid=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end||end-start>(x.source==='gmail'?30*86400000:7*86400000+7200000)||!(x.cursor===null||typeof x.cursor==='string')||!b||!valid(b.max_run_ms,1000,300000)||!valid(b.max_attempts,1,5)||!valid(b.max_records_per_run,1,1000)||!valid(b.max_page_size,1,500)||!valid(b.max_body_bytes,1,1048576)||!valid(x.page_size,1,500))throw new Error('invalid approved sync state');if(x.source==='calendar'&&(typeof x.calendar_id!=='string'||!x.calendar_id))throw new Error('missing approved calendar');const started_at=$('Set sync clock').item.json.started_at;if(!Number.isFinite(started_at))throw new Error('invalid sync clock');const wait=x.retry_after_until===null||x.retry_after_until===undefined?0:Date.parse(x.retry_after_until);if(!Number.isFinite(wait))throw new Error('invalid provider retry time');return [{json:{...x,account_email:x.account_email.toLowerCase(),profile_account_email:null,started_at,deadline_at:started_at+b.max_run_ms,page_size:Math.min(20,x.page_size,b.max_records_per_run,b.max_page_size),attempts:{},request_allowed:x.reconnect_required!==true&&wait<=Date.now()}}];`;
const failureBody =
  "={{ JSON.stringify({source:$json.source,account_email:$json.account_email,profile_account_email:$json.profile_account_email??null,...($json.calendar_id?{calendar_id:$json.calendar_id}:{}),cursor:$json.cursor,status_code:$json.status_code??599,retry_after_seconds:$json.retry_delay_seconds??0,reconnect_required:$json.reconnect_required===true}) }}";
function addReadStage(
  w: Workflow,
  phase: string,
  url: string,
  credential: NonNullable<Node["credentials"]>,
  accept: string,
  x: number,
  query?: string,
): { start: string; success: string } {
  const prepName = `Prepare ${phase}`;
  const prepare = code(
    prepName,
    `const x=$input.first().json;const attempts={...(x.attempts||{})};attempts[${JSON.stringify(phase)}]=(attempts[${JSON.stringify(phase)}]||0)+1;const request_allowed=Date.now()+5000<=x.deadline_at&&attempts[${JSON.stringify(phase)}]<=x.budget.max_attempts;return [{json:{...x,attempts,request_allowed,status_code:request_allowed?0:599,failure_kind:request_allowed?null:'budget-exhausted',retry_allowed:false}}];`,
    x,
  );
  const budget = condition(
    `${phase} request budget`,
    "request_allowed",
    x + 150,
  );
  const requestNode: Node = {
    ...node(
      `Read ${phase}`,
      "httpRequest",
      {
        method: "GET",
        url,
        authentication: "predefinedCredentialType",
        nodeCredentialType: phase.startsWith("Calendar")
          ? "googleCalendarOAuth2Api"
          : "gmailOAuth2",
        ...(query
          ? { sendQuery: true, specifyQuery: "json", jsonQuery: query }
          : {}),
        options: {
          timeout: 5000,
          response: {
            response: {
              fullResponse: true,
              neverError: true,
              responseFormat: "json",
            },
          },
        },
      },
      x + 300,
      0,
      4.2,
    ),
    credentials: credential,
    retryOnFail: false,
    continueOnFail: true,
  };
  const check = code(
    `Check ${phase}`,
    `const response=$input.first().json;const ctx=$(${JSON.stringify(prepName)}).item.json;const status=Number(response.statusCode)||599;const rateLimited=status===403&&Array.isArray(response.body?.error?.errors)&&response.body.error.errors.some(e=>['rateLimitExceeded','userRateLimitExceeded'].includes(e.reason));const headers=response.headers||{};const raw=headers['retry-after']??headers['Retry-After'];const seconds=typeof raw==='string'&&/^\\d+$/.test(raw)?Number(raw):typeof raw==='string'?Math.max(0,Math.ceil((Date.parse(raw)-Date.now())/1000)):NaN;const retry_delay_seconds=Number.isFinite(seconds)?seconds:Math.min(8,2**(ctx.attempts[${JSON.stringify(phase)}]-1));let out={...ctx,ok:false,status_code:status,reconnect_required:status===401||(status===403&&!rateLimited),retry_delay_seconds,retry_allowed:(status===429||rateLimited||status>=500)&&ctx.attempts[${JSON.stringify(phase)}]<ctx.budget.max_attempts&&Date.now()+retry_delay_seconds*1000+5000<=ctx.deadline_at};if(status>=200&&status<300){const body=response.body;try{${accept}}catch{out={...out,status_code:502,failure_kind:'provider-contract',retry_allowed:false,reconnect_required:false};}}return [{json:out}];`,
    x + 450,
  );
  const success = condition(`${phase} succeeded`, "ok", x + 600);
  const retry = condition(
    `${phase} retry within budget`,
    "retry_allowed",
    x + 600,
  );
  retry.position[1] = 200;
  const wait = node(
    `Wait ${phase} Retry-After`,
    "wait",
    {
      resume: "timeInterval",
      amount: "={{ $json.retry_delay_seconds }}",
      unit: "seconds",
    },
    x + 450,
    360,
    1.1,
  );
  w.nodes.push(prepare, budget, requestNode, check, success, retry, wait);
  connect(w, prepare.name, budget.name);
  connect(w, budget.name, requestNode.name);
  connect(w, budget.name, "Record resumable failure", 1);
  connect(w, requestNode.name, check.name);
  connect(w, check.name, success.name);
  connect(w, success.name, retry.name, 1);
  connect(w, retry.name, wait.name);
  connect(w, retry.name, "Record resumable failure", 1);
  connect(w, wait.name, prepare.name);
  return { start: prepare.name, success: success.name };
}
function addSyncStart(w: Workflow, source: "gmail" | "calendar"): string {
  const start = node("Run approved initial sync", "manualTrigger", {}, 0);
  const schedule = node(
    "Poll approved window",
    "scheduleTrigger",
    { rule: { interval: [{ field: "minutes", minutesInterval: 1 }] } },
    0,
    180,
    1.2,
  );
  const clock = code(
    "Set sync clock",
    "return [{json:{started_at:Date.now()}}];",
    180,
  );
  const state = liveHttp(
    "Read approved sync state",
    `/api/live/sync-state?source=${source}`,
    360,
  );
  const validate = code(
    "Validate approved sync window",
    approvedStateCode,
    540,
  );
  const allowed = condition(
    "Provider retry window ready",
    "request_allowed",
    700,
  );
  const deferred = code(
    "Leave deferred checkpoint unchanged",
    "return [{json:{deferred:true,source:$json.source,retry_after_until:$json.retry_after_until??null}}];",
    880,
  );
  deferred.position[1] = 200;
  const error = liveHttp(
    "Record resumable failure",
    "/api/live/sync-error",
    850,
    failureBody,
  );
  error.position[1] = 560;
  w.nodes.push(
    start,
    schedule,
    clock,
    state,
    validate,
    allowed,
    deferred,
    error,
  );
  connect(w, start.name, clock.name);
  connect(w, schedule.name, clock.name);
  connect(w, clock.name, state.name);
  connect(w, state.name, validate.name);
  connect(w, validate.name, allowed.name);
  connect(w, allowed.name, deferred.name, 1);
  return allowed.name;
}
const profileAccept = `if(!body||typeof body.emailAddress!=='string')throw new Error('profile shape');const email=body.emailAddress.toLowerCase();out=email===ctx.account_email?{...out,ok:true,profile_account_email:email,retry_allowed:false,reconnect_required:false}:{...out,status_code:403,profile_account_email:null,reconnect_required:true,retry_allowed:false,failure_kind:'account-mismatch'};`;
const approvedRecordBodyCode = `(context,record)=>JSON.stringify({source:context.source,account_email:context.account_email,profile_account_email:context.profile_account_email,...(context.calendar_id?{calendar_id:context.calendar_id}:{}),records:[record],previous_cursor:context.cursor,cursor:context.cursor,complete:false,reconcile:false,window_start:context.window_start,window_end:context.window_end,seen_record_ids:[record.id]})`;
const normalizeLive = privateWorkflow(
  "TendGoogle13",
  "Tend 13: Approved Google normalize and store",
);
const normalizeTrigger = node(
  "When called by Google adapter",
  "executeWorkflowTrigger",
  { inputSource: "passthrough" },
  0,
  0,
  1.1,
);
const normalizeCheck = code(
  "Validate approved raw input",
  `const x=$input.first().json;const c=x.context;if(c&&Date.now()+5000>c.deadline_at)throw new Error('storage budget exhausted; checkpoint unchanged');if(!c||!['gmail','calendar'].includes(c.source)||c.account_email!==c.profile_account_email||!x.record||typeof x.record.id!=='string'||!x.record.id||!(c.cursor===null||typeof c.cursor==='string'))throw new Error('invalid approved provider envelope');const serialize=${approvedRecordBodyCode};if(typeof x.storage_body!=='string'||Buffer.byteLength(x.storage_body,'utf8')>c.budget.max_body_bytes||x.storage_body!==serialize(c,x.record))throw new Error('invalid approved storage body');return [{json:x}];`,
  250,
);
const normalizeCall = liveHttp(
  "Normalize and commit approved record",
  "/api/live/sync",
  500,
  "={{ $json.storage_body }}",
);
const normalizedReceipt = code(
  "Return committed page context",
  "const saved=$input.first().json;const x=$('Validate approved raw input').item.json;if(saved.error)throw new Error('record storage failed');return [{json:{context:x.context,source_record_id:x.record.id,committed:true}}];",
  760,
);
normalizeLive.nodes.push(
  normalizeTrigger,
  normalizeCheck,
  normalizeCall,
  normalizedReceipt,
);
connect(normalizeLive, normalizeTrigger.name, normalizeCheck.name);
connect(normalizeLive, normalizeCheck.name, normalizeCall.name);
connect(normalizeLive, normalizeCall.name, normalizedReceipt.name);
function addCommitPage(
  w: Workflow,
  from: string,
  recordsExpression: string,
  x: number,
): void {
  const fan = code(
    "Prepare bounded provider records",
    `const ctx=$input.first().json;const records=${recordsExpression};if(!Array.isArray(records)||records.length>ctx.page_size)throw new Error('page budget exceeded');const context={...ctx,expected_record_ids:records.map(record=>record?.id)};delete context.provider_records;delete context.message_refs;if(records.length===0)return [{json:{context,empty:true}}];return records.map(record=>{if(!record||typeof record.id!=='string'||!record.id)throw new Error('missing provider id');const serialize=${approvedRecordBodyCode};let storage_body=serialize(ctx,record);const bounded=Buffer.byteLength(storage_body,'utf8')<=ctx.budget.max_body_bytes?record:{id:record.id,oversized:true};if(bounded!==record)storage_body=serialize(ctx,bounded);if(Buffer.byteLength(storage_body,'utf8')>ctx.budget.max_body_bytes)throw new Error('storage envelope exceeds run budget; checkpoint unchanged');return {json:{context,record:bounded,storage_body,empty:false}};});`,
    x,
  );
  const empty = condition("Provider page is empty", "empty", x + 200);
  const child = node(
    "Normalize each approved provider record",
    "executeWorkflow",
    {
      source: "parameter",
      workflowJson: JSON.stringify(normalizeLive),
      mode: "each",
      options: { waitForSubWorkflow: true },
    },
    x + 450,
    0,
    1.3,
  );
  const collect = code(
    "Acknowledge only the committed complete page",
    `const original=$('Prepare bounded provider records').first().json.context;const items=$input.all().map(x=>x.json);const expected=original.expected_record_ids;if(!Array.isArray(expected)||expected.some(id=>typeof id!=='string'||!id)||new Set(expected).size!==expected.length)throw new Error('invalid expected provider record ids');if(Date.now()+5000>original.deadline_at)throw new Error('page acknowledgement budget exhausted; checkpoint unchanged');if(expected.length&&(!items.every(x=>x.committed===true)||items.length!==expected.length||new Set(items.map(x=>x.source_record_id)).size!==expected.length||items.some(x=>!expected.includes(x.source_record_id))))throw new Error('incomplete provider page remains resumable');return [{json:{source:original.source,account_email:original.account_email,profile_account_email:original.profile_account_email,...(original.calendar_id?{calendar_id:original.calendar_id}:{}),records:[],previous_cursor:original.cursor,cursor:original.next_cursor,complete:original.next_cursor===null,reconcile:original.next_cursor===null,window_start:original.window_start,window_end:original.window_end,seen_record_ids:expected}}];`,
    x + 720,
  );
  const final = liveHttp(
    "Commit provider page checkpoint",
    "/api/live/sync",
    x + 980,
    "={{ JSON.stringify($json) }}",
  );
  w.nodes.push(fan, empty, child, collect, final);
  connect(w, from, fan.name);
  connect(w, fan.name, empty.name);
  connect(w, empty.name, collect.name);
  connect(w, empty.name, child.name, 1);
  connect(w, child.name, collect.name);
  connect(w, collect.name, final.name);
}
const liveGmail = privateWorkflow(
  "TendGoogle11",
  "Tend 11: Read-only Gmail approved-window sync",
);
const gStart = addSyncStart(liveGmail, "gmail");
const gProfile = addReadStage(
  liveGmail,
  "Gmail profile",
  "https://gmail.googleapis.com/gmail/v1/users/me/profile",
  gmailCredential,
  profileAccept,
  1000,
);
connect(liveGmail, gStart, gProfile.start);
const gList = addReadStage(
  liveGmail,
  "Gmail message page",
  "https://gmail.googleapis.com/gmail/v1/users/me/messages",
  gmailCredential,
  `if(!body||typeof body!=='object'||(!Array.isArray(body.messages)&&body.resultSizeEstimate!==0)||!(body.nextPageToken===undefined||typeof body.nextPageToken==='string'))throw new Error('message page shape');const refs=body.messages||[];if(refs.length>ctx.page_size||refs.some(r=>!r||typeof r.id!=='string'||!r.id)||new Set(refs.map(r=>r.id)).size!==refs.length)throw new Error('message references');out={...out,ok:true,message_refs:refs,next_cursor:body.nextPageToken||null,retry_allowed:false,reconnect_required:false};`,
  2200,
  "={{ JSON.stringify({q:'after:'+Math.floor(Date.parse($json.window_start)/1000)+' before:'+Math.ceil(Date.parse($json.window_end)/1000)+' -in:spam -in:trash -is:draft',includeSpamTrash:false,maxResults:$json.page_size,...($json.cursor?{pageToken:$json.cursor}:{})}) }}",
);
connect(liveGmail, gProfile.success, gList.start);
const gmailDetailBatch = { batchSize: 1, batchInterval: 500 };
const refEmpty = code(
  "Choose message details or empty page",
  `const x=$input.first().json;const launch_delay_ms=Math.max(0,Math.ceil(x.message_refs.length/${gmailDetailBatch.batchSize})-1)*${gmailDetailBatch.batchInterval};const details_allowed=Date.now()+launch_delay_ms+5000+5000<=x.deadline_at;return [{json:{...x,empty:x.message_refs.length===0,details_allowed,status_code:details_allowed?0:599,retry_delay_seconds:0,reconnect_required:false}}];`,
  3500,
);
const refBranch = condition("Message references empty", "empty", 3650);
liveGmail.nodes.push(refEmpty, refBranch);
connect(liveGmail, gList.success, refEmpty.name);
connect(liveGmail, refEmpty.name, refBranch.name);
const directEmpty = code(
  "Empty message page",
  "return [{json:{...$json,provider_records:[]}}];",
  3800,
);
directEmpty.position[1] = 180;
liveGmail.nodes.push(directEmpty);
connect(liveGmail, refBranch.name, directEmpty.name);
const detailFan = code(
  "Prepare message detail batch",
  "const ctx=$input.first().json;if(Date.now()+5000>ctx.deadline_at)throw new Error('detail budget exhausted; checkpoint unchanged');return ctx.message_refs.map(r=>({json:{...ctx,message_id:r.id}}));",
  3800,
);
const details: Node = {
  ...node(
    "Read Gmail full messages",
    "httpRequest",
    {
      method: "GET",
      url: "={{ 'https://gmail.googleapis.com/gmail/v1/users/me/messages/'+encodeURIComponent($json.message_id) }}",
      authentication: "predefinedCredentialType",
      nodeCredentialType: "gmailOAuth2",
      sendQuery: true,
      specifyQuery: "json",
      jsonQuery: '={{ JSON.stringify({format:"full"}) }}',
      options: {
        timeout: 5000,
        batching: { batch: gmailDetailBatch },
        response: {
          response: {
            fullResponse: true,
            neverError: true,
            responseFormat: "json",
          },
        },
      },
    },
    4050,
    0,
    4.2,
  ),
  credentials: gmailCredential,
  retryOnFail: false,
  continueOnFail: true,
};
const detailCollect = code(
  "Check every message detail before page storage",
  `const ctx=$('Prepare message detail batch').first().json;const responses=$input.all().map(x=>x.json);const ok=responses.length===ctx.message_refs.length&&responses.every(r=>r.statusCode===200&&r.body&&typeof r.body.id==='string')&&new Set(responses.map(r=>r.body&&r.body.id)).size===ctx.message_refs.length&&responses.every(r=>ctx.message_refs.some(m=>m.id===r.body.id));if(!ok){const bad=responses.find(r=>r.statusCode!==200)||{};const status=Number(bad.statusCode)||599;const rateLimited=status===403&&Array.isArray(bad.body?.error?.errors)&&bad.body.error.errors.some(e=>['rateLimitExceeded','userRateLimitExceeded'].includes(e.reason));const header=(bad.headers||{})['retry-after'];const retry_delay_seconds=typeof header==='string'&&/^\\d+$/.test(header)?Number(header):typeof header==='string'?Math.max(0,Math.ceil((Date.parse(header)-Date.now())/1000)):1;return [{json:{...ctx,ok:false,status_code:status,profile_account_email:ctx.profile_account_email,reconnect_required:status===401||(status===403&&!rateLimited),retry_delay_seconds:Number.isFinite(retry_delay_seconds)?retry_delay_seconds:1}}];}return [{json:{...ctx,ok:true,provider_records:responses.map(r=>r.body)}}];`,
  4300,
);
const detailGood = condition("Every message detail read", "ok", 4550);
liveGmail.nodes.push(detailFan, details, detailCollect, detailGood);
const detailBudget = condition(
  "Detail batch fits run budget",
  "details_allowed",
  3760,
);
liveGmail.nodes.push(detailBudget);
connect(liveGmail, refBranch.name, detailBudget.name, 1);
connect(liveGmail, detailBudget.name, detailFan.name);
connect(liveGmail, detailBudget.name, "Record resumable failure", 1);
connect(liveGmail, detailFan.name, details.name);
connect(liveGmail, details.name, detailCollect.name);
connect(liveGmail, detailCollect.name, detailGood.name);
connect(liveGmail, detailGood.name, "Record resumable failure", 1);
addCommitPage(liveGmail, detailGood.name, "ctx.provider_records", 4800);
connect(liveGmail, directEmpty.name, "Prepare bounded provider records");
const liveCalendar = privateWorkflow(
  "TendGoogle12",
  "Tend 12: Read-only chosen Calendar approved-window sync",
);
const cStart = addSyncStart(liveCalendar, "calendar");
const cProfile = addReadStage(
  liveCalendar,
  "Gmail profile",
  "https://gmail.googleapis.com/gmail/v1/users/me/profile",
  gmailCredential,
  profileAccept,
  1000,
);
connect(liveCalendar, cStart, cProfile.start);
const cPrimary = addReadStage(
  liveCalendar,
  "Calendar primary account",
  "={{ 'https://www.googleapis.com/calendar/v3/users/me/calendarList/'+encodeURIComponent($json.account_email) }}",
  calendarCredential,
  `if(!body||body.id!==ctx.account_email||body.primary!==true)out={...out,ok:false,status_code:403,reconnect_required:true,retry_allowed:false,failure_kind:'calendar-account-mismatch'};else out={...out,ok:true,retry_allowed:false,reconnect_required:false};`,
  2200,
);
connect(liveCalendar, cProfile.success, cPrimary.start);
const cChosen = addReadStage(
  liveCalendar,
  "Calendar selected metadata",
  "={{ 'https://www.googleapis.com/calendar/v3/users/me/calendarList/'+encodeURIComponent($json.calendar_id) }}",
  calendarCredential,
  `if(!body||(ctx.calendar_id==='primary'?!(body.primary===true&&body.id===ctx.account_email):body.id!==ctx.calendar_id)||!['reader','writer','owner'].includes(body.accessRole))out={...out,ok:false,status_code:403,reconnect_required:true,retry_allowed:false,failure_kind:'calendar-not-approved-or-readable'};else out={...out,ok:true,retry_allowed:false,reconnect_required:false};`,
  3400,
);
connect(liveCalendar, cPrimary.success, cChosen.start);
const cEvents = addReadStage(
  liveCalendar,
  "Calendar event page",
  "={{ 'https://www.googleapis.com/calendar/v3/calendars/'+encodeURIComponent($json.calendar_id)+'/events' }}",
  calendarCredential,
  `if(!body||body.kind!=='calendar#events'||!(body.items===undefined||Array.isArray(body.items))||!(body.nextPageToken===undefined||typeof body.nextPageToken==='string'))throw new Error('event page shape');const items=body.items||[];if(items.length>ctx.page_size||items.some(r=>!r||typeof r.id!=='string'||!r.id)||new Set(items.map(r=>r.id)).size!==items.length)throw new Error('event references');out={...out,ok:true,provider_records:items,next_cursor:body.nextPageToken||null,retry_allowed:false,reconnect_required:false};`,
  4600,
  "={{ JSON.stringify({timeMin:$json.window_start,timeMax:$json.window_end,singleEvents:true,showDeleted:true,maxResults:$json.page_size,timeZone:'Europe/Paris',...($json.cursor?{pageToken:$json.cursor}:{})}) }}",
);
connect(liveCalendar, cChosen.success, cEvents.start);
addCommitPage(liveCalendar, cEvents.success, "ctx.provider_records", 5800);
// Preserve the generic owner guard. Root patches its owned private deployment in place;
// importing this inactive template must never register a second active bot webhook.
const googleTelegram = structuredClone(liveTelegram);
googleTelegram.id = "TendGoogle14";
googleTelegram.name = "Tend 14: Private approved Google owner control";
googleTelegram.settings.saveManualExecutions = false;
googleTelegram.versionId = "00000000-0000-4000-8000-000000000014";
for (const n of googleTelegram.nodes) {
  if (n.credentials?.telegramApi)
    n.credentials = {
      telegramApi: {
        id: "CONFIGURE_TELEGRAM_CREDENTIAL_ID",
        name: "CONFIGURE_TELEGRAM_CREDENTIAL",
      },
    };
  if (n.name === "Authorize Telegram owner")
    n.parameters.jsCode = telegramLiveGuardCode;
  if (n.type === "n8n-nodes-base.httpRequest") {
    const p = String(n.parameters.url);
    n.parameters = {
      ...n.parameters,
      url: p
        .replace("18767", "18768")
        .replace("/api/telegram/", "/api/live/telegram/"),
      authentication: "genericCredentialType",
      genericAuthType: "httpHeaderAuth",
    };
    n.credentials = internalCredential;
  }
  if (n.name === "Format private owner reply")
    n.parameters.jsCode = telegramLiveReplyCode;
}
const liveAI = privateWorkflow(
  "TendGoogle15",
  "Tend 15: Local AI on eligible newly authored Google evidence",
);
const modelStart = node(
  "Run approved local extraction",
  "manualTrigger",
  {},
  0,
);
const modelSchedule = node(
  "Poll eligible authored spans",
  "scheduleTrigger",
  { rule: { interval: [{ field: "minutes", minutesInterval: 1 }] } },
  0,
  180,
  1.2,
);
const getLiveModel = liveHttp(
  "Read eligible authored span",
  "/api/live/model-input",
  260,
);
const readyModel = code(
  "Check eligible authored source",
  "const x=$input.first().json;return [{json:{...x,eligible:typeof x.record_key==='string'&&x.record_key.length>0&&x.record&&typeof x.record.authored_span==='string'&&x.record.authored_span.length>0&&x.request&&Array.isArray(x.request.messages)&&x.request.messages.length>=2}}];",
  500,
);
const branchModel = condition("Eligible authored promise", "eligible", 710);
const markLiveExtraction = liveHttp(
  "Record extraction attempt before model",
  "/api/live/extraction-attempt",
  930,
  "={{ JSON.stringify({record_key:$json.record_key,content_hash:$json.content_hash}) }}",
);
const restoreLiveInput = code(
  "Restore current authored model input",
  "return [{json:$('Read eligible authored span').first().json}];",
  1190,
);
const liveChain = structuredClone(ai);
liveChain.position = [1450, 0];
const validateLiveCandidate = code(
  "Validate exact authored quote",
  "const x=$input.first().json;const input=$('Read eligible authored span').first().json;const candidate=typeof x.text==='string'?JSON.parse(x.text):x;const span=input.record.authored_span;const keys=Object.keys(candidate);if(keys.length!==3||keys.some(k=>!['quote','action','suggested_due'].includes(k))||typeof candidate.quote!=='string'||typeof candidate.action!=='string'||candidate.quote!==span||!/^I (?:will|promise to)\\b/i.test(candidate.quote)||!candidate.quote.toLowerCase().includes(candidate.action.toLowerCase())||(candidate.suggested_due!==null&&(typeof candidate.suggested_due!=='string'||!/^\\d{4}-\\d{2}-\\d{2}$/.test(candidate.suggested_due)||!candidate.quote.includes(candidate.suggested_due))))throw new Error('unsupported or invented authored promise');return [{json:{record_key:input.record_key,candidate}}];",
  1710,
);
const saveLiveCandidate = liveHttp(
  "Persist owner-scoped pending promise",
  "/api/live/candidates",
  1970,
  "={{ JSON.stringify($json) }}",
);
const liveModel = structuredClone(model);
liveModel.position = [1450, 260];
liveAI.nodes.push(
  modelStart,
  modelSchedule,
  getLiveModel,
  readyModel,
  branchModel,
  markLiveExtraction,
  restoreLiveInput,
  liveChain,
  validateLiveCandidate,
  saveLiveCandidate,
  liveModel,
);
connect(liveAI, modelStart.name, getLiveModel.name);
connect(liveAI, modelSchedule.name, getLiveModel.name);
connect(liveAI, getLiveModel.name, readyModel.name);
connect(liveAI, readyModel.name, branchModel.name);
connect(liveAI, branchModel.name, markLiveExtraction.name);
connect(liveAI, markLiveExtraction.name, restoreLiveInput.name);
connect(liveAI, restoreLiveInput.name, liveChain.name);
connect(liveAI, liveChain.name, validateLiveCandidate.name);
connect(liveAI, validateLiveCandidate.name, saveLiveCandidate.name);
liveAI.connections[liveModel.name] = {
  ai_languageModel: [
    [{ node: liveChain.name, type: "ai_languageModel", index: 0 }],
  ],
};
workflows.push(liveGmail, liveCalendar, normalizeLive, googleTelegram, liveAI);

await mkdir("workflows", { recursive: true });
for (let i = 0; i < workflows.length; i++)
  await writeJson(
    `workflows/${String(i + 1).padStart(2, "0")}-${["gmail", "calendar", "whatsapp-personal", "whatsapp-business", "linkedin", "normalize-store", "extract-commitments", "assistant", "retry-fixture", "telegram-private", "google-gmail-readonly", "google-calendar-readonly", "google-normalize-store", "google-telegram-private", "google-extract-commitments"][i]}.json`,
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
