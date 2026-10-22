import { isExplicitCommitment } from "./authored-promises.ts";
import { writeFile, mkdir } from "node:fs/promises";
import { format } from "prettier";
import { buildDailyBriefingWorkflow } from "./daily-workflow.ts";
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
    executionTimeout?: number;
    errorWorkflow?: string;
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
const approvedStateCode = `const x=$input.first().json;if(!x||typeof x.account_email!=='string'||!x.account_email.includes('@')||!['gmail','calendar'].includes(x.source))throw new Error('invalid approved sync state');const start=Date.parse(x.window_start),end=Date.parse(x.window_end);const b=x.budget;const valid=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end||(x.lane==='history'?(x.history_version!==1||x.window_start!=='0001-01-01T00:00:00.000Z'||!Number.isFinite(Date.parse(x.watermark))):end-start>(x.source==='gmail'?30*86400000:7*86400000+7200000))||!(x.cursor===null||typeof x.cursor==='string')||!b||!valid(b.max_run_ms,1000,300000)||!valid(b.max_attempts,1,5)||!valid(b.max_records_per_run,1,1000)||!valid(b.max_page_size,1,500)||!valid(b.max_body_bytes,1,1048576)||!valid(x.page_size,1,500))throw new Error('invalid approved sync state');if(x.source==='calendar'&&(typeof x.calendar_id!=='string'||!x.calendar_id))throw new Error('missing approved calendar');const started_at=$('Set sync clock').item.json.started_at;if(!Number.isFinite(started_at))throw new Error('invalid sync clock');const wait=x.retry_after_until===null||x.retry_after_until===undefined?0:Date.parse(x.retry_after_until);if(!Number.isFinite(wait))throw new Error('invalid provider retry time');return [{json:{...x,account_email:x.account_email.toLowerCase(),profile_account_email:null,started_at,deadline_at:started_at+b.max_run_ms,page_size:Math.min(20,x.page_size,b.max_records_per_run,b.max_page_size),attempts:{},request_allowed:x.request_allowed!==false&&x.reconnect_required!==true&&wait<=Date.now()}}];`;
const failureBody =
  "={{ JSON.stringify({...($json.lane==='history'?{lane:'history',history_version:1,watermark:$json.watermark}:{}),source:$json.source,account_email:$json.account_email,profile_account_email:$json.profile_account_email??null,...($json.calendar_id?{calendar_id:$json.calendar_id}:{}),cursor:$json.cursor,status_code:$json.status_code??599,retry_after_seconds:$json.retry_delay_seconds??0,reconnect_required:$json.reconnect_required===true}) }}";
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
    `const response=$input.first().json;const ctx=$(${JSON.stringify(prepName)}).item.json;const status=Number(response.statusCode)||599;const rateLimited=status===403&&Array.isArray(response.body?.error?.errors)&&response.body.error.errors.some(e=>['rateLimitExceeded','userRateLimitExceeded','dailyLimitExceeded','quotaExceeded'].includes(e.reason));const headers=response.headers||{};const raw=headers['retry-after']??headers['Retry-After'];const seconds=typeof raw==='string'&&/^\\d+$/.test(raw)?Number(raw):typeof raw==='string'?Math.max(0,Math.ceil((Date.parse(raw)-Date.now())/1000)):NaN;const retry_delay_seconds=Number.isFinite(seconds)?seconds:Math.min(8,2**(ctx.attempts[${JSON.stringify(phase)}]-1));let out={...ctx,ok:false,status_code:status,reconnect_required:status===401||(status===403&&!rateLimited),retry_delay_seconds,retry_allowed:(status===429||rateLimited||status>=500)&&ctx.attempts[${JSON.stringify(phase)}]<ctx.budget.max_attempts&&Date.now()+retry_delay_seconds*1000+5000<=ctx.deadline_at};if(status>=200&&status<300){const body=response.body;try{${accept}}catch{out={...out,status_code:502,failure_kind:'provider-contract',retry_allowed:false,reconnect_required:false};}}return [{json:out}];`,
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
    `/api/live/sync-state?source=${source}&lane=auto`,
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
const storageTimeoutMs = 5000;
const storageMaxTries = 2;
const storageRetryDelayMs = 1000;
const storageRetryReserveMs =
  storageTimeoutMs * storageMaxTries +
  storageRetryDelayMs * (storageMaxTries - 1);
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
  `const x=$input.first().json;const c=x.context;const attempts=c?.budget?.max_attempts;if(!Number.isSafeInteger(attempts)||attempts<1||attempts>5)throw new Error('invalid storage attempt budget');const storage_retry_allowed=attempts>1;const reserve=storage_retry_allowed?${storageRetryReserveMs}:${storageTimeoutMs};if(c&&Date.now()+reserve>c.deadline_at)throw new Error('storage budget exhausted; checkpoint unchanged');if(!c||!['gmail','calendar'].includes(c.source)||c.account_email!==c.profile_account_email||!x.record||typeof x.record.id!=='string'||!x.record.id||!(c.cursor===null||typeof c.cursor==='string'))throw new Error('invalid approved provider envelope');const serialize=${approvedRecordBodyCode};if(typeof x.storage_body!=='string'||Buffer.byteLength(x.storage_body,'utf8')>c.budget.max_body_bytes||x.storage_body!==serialize(c,x.record))throw new Error('invalid approved storage body');return [{json:{...x,storage_retry_allowed}}];`,
  250,
);
const normalizeCall = liveHttp(
  "Normalize and commit approved record",
  "/api/live/sync",
  500,
  "={{ $json.storage_body }}",
);
normalizeCall.parameters.options = { timeout: storageTimeoutMs };
normalizeCall.retryOnFail = true;
normalizeCall.maxTries = storageMaxTries;
normalizeCall.waitBetweenTries = storageRetryDelayMs;
const normalizeOnce = liveHttp(
  "Normalize and commit approved record once",
  "/api/live/sync",
  500,
  "={{ $json.storage_body }}",
);
normalizeOnce.parameters.options = { timeout: storageTimeoutMs };
normalizeOnce.position[1] = 220;
const normalizeRetry = condition(
  "Storage retry allowed by approved budget",
  "storage_retry_allowed",
  400,
);
const normalizedReceipt = code(
  "Return committed page context",
  "const saved=$input.first().json;const x=$('Validate approved raw input').item.json;if(saved.error)throw new Error('record storage failed');return [{json:{context:x.context,source_record_id:x.record.id,committed:true}}];",
  760,
);
normalizeLive.nodes.push(
  normalizeTrigger,
  normalizeCheck,
  normalizeRetry,
  normalizeCall,
  normalizeOnce,
  normalizedReceipt,
);
connect(normalizeLive, normalizeTrigger.name, normalizeCheck.name);
connect(normalizeLive, normalizeCheck.name, normalizeRetry.name);
connect(normalizeLive, normalizeRetry.name, normalizeCall.name);
connect(normalizeLive, normalizeRetry.name, normalizeOnce.name, 1);
connect(normalizeLive, normalizeCall.name, normalizedReceipt.name);
connect(normalizeLive, normalizeOnce.name, normalizedReceipt.name);
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
  const lane = code(
    "Choose independent history lane",
    "return [{json:{...$json,history_lane:$json.lane==='history'}}];",
    x - 350,
  );
  const branch = condition("Independent history page", "history_lane", x - 180);
  const historyPage = code(
    "Bound whole history page",
    `const x=$input.first().json,ctx=x;const raw=${recordsExpression};if(!Array.isArray(raw)||raw.length>10)throw new Error('History page size exceeded');const page=(records,advance)=>({lane:'history',history_version:1,deadline_at:x.deadline_at,watermark:x.watermark,source:x.source,account_email:x.account_email,profile_account_email:x.profile_account_email,...(x.calendar_id?{calendar_id:x.calendar_id}:{}),records,advance,previous_cursor:x.cursor,cursor:advance?x.next_cursor:x.cursor,complete:advance&&x.next_cursor===null,window_start:x.window_start,window_end:x.window_end});const fits=records=>Buffer.byteLength(JSON.stringify(page(records,true)),'utf8')+32<=x.budget.max_body_bytes;const groups=[];let current=[];for(const record of raw){if(!record||typeof record.id!=='string'||!record.id)throw new Error('Missing history record ID');const bounded=fits([record])?record:{id:record.id,oversized:true};if(!fits([...current,bounded])&&current.length){groups.push(current);current=[];}current.push(bounded);}groups.push(current);return groups.map((records,i)=>({json:page(records,i===groups.length-1)}));`,
    x + 100,
  );
  const historyCommit = liveHttp(
    "Commit independent history page",
    "/api/live/sync",
    x + 350,
    "={{ JSON.stringify($json) }}",
  );
  historyCommit.parameters.options = { timeout: 5000 };
  const historyLoop = node(
    "Store one history chunk at a time",
    "splitInBatches",
    { batchSize: 1, options: { reset: false } },
    x + 200,
    0,
    3,
  );
  const historyBudget = code(
    "Check history storage deadline",
    "const x=$input.first().json;if(!Number.isFinite(x.deadline_at)||Date.now()+5000>x.deadline_at)throw new Error('History storage deadline exhausted; provider cursor unchanged');return [{json:x}];",
    x + 270,
  );
  const historyDone = code(
    "History provider page acknowledged",
    "return $input.all();",
    x + 500,
  );
  w.nodes.push(
    lane,
    branch,
    historyPage,
    historyLoop,
    historyBudget,
    historyDone,
    historyCommit,
    fan,
    empty,
    child,
    collect,
    final,
  );
  connect(w, from, lane.name);
  connect(w, lane.name, branch.name);
  connect(w, branch.name, historyPage.name);
  connect(w, historyPage.name, historyLoop.name);
  connect(w, historyLoop.name, historyDone.name, 0);
  connect(w, historyLoop.name, historyBudget.name, 1);
  connect(w, historyBudget.name, historyCommit.name);
  connect(w, historyCommit.name, historyLoop.name);
  connect(w, branch.name, fan.name, 1);
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
  "={{ JSON.stringify({q:($json.lane==='history'?'':'after:'+Math.floor(Date.parse($json.window_start)/1000)+' ')+'before:'+Math.ceil(Date.parse($json.window_end)/1000)+' -in:spam -in:trash -is:draft',includeSpamTrash:false,maxResults:$json.page_size,...($json.cursor?{pageToken:$json.cursor}:{})}) }}",
);
connect(liveGmail, gProfile.success, gList.start);
const gmailDetailBatch = { batchSize: 1, batchInterval: 500 };
const refEmpty = code(
  "Choose message details or empty page",
  `const x=$input.first().json;const launch_delay_ms=Math.max(0,Math.ceil(x.message_refs.length/${gmailDetailBatch.batchSize})-1)*${gmailDetailBatch.batchInterval};const storage_reserve_ms=x.budget.max_attempts>1?${storageRetryReserveMs}:${storageTimeoutMs};const details_allowed=Date.now()+launch_delay_ms+5000+storage_reserve_ms<=x.deadline_at;return [{json:{...x,empty:x.message_refs.length===0,details_allowed,status_code:details_allowed?0:599,retry_delay_seconds:0,reconnect_required:false}}];`,
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
  `const ctx=$('Prepare message detail batch').first().json;const responses=$input.all().map(x=>x.json);const ok=responses.length===ctx.message_refs.length&&responses.every(r=>r.statusCode===200&&r.body&&typeof r.body.id==='string')&&new Set(responses.map(r=>r.body&&r.body.id)).size===ctx.message_refs.length&&responses.every(r=>ctx.message_refs.some(m=>m.id===r.body.id));if(!ok){const bad=responses.find(r=>r.statusCode!==200)||{};const status=Number(bad.statusCode)||599;const rateLimited=status===403&&Array.isArray(bad.body?.error?.errors)&&bad.body.error.errors.some(e=>['rateLimitExceeded','userRateLimitExceeded','dailyLimitExceeded','quotaExceeded'].includes(e.reason));const header=(bad.headers||{})['retry-after'];const retry_delay_seconds=typeof header==='string'&&/^\\d+$/.test(header)?Number(header):typeof header==='string'?Math.max(0,Math.ceil((Date.parse(header)-Date.now())/1000)):1;return [{json:{...ctx,ok:false,status_code:status,profile_account_email:ctx.profile_account_email,reconnect_required:status===401||(status===403&&!rateLimited),retry_delay_seconds:Number.isFinite(retry_delay_seconds)?retry_delay_seconds:1}}];}return [{json:{...ctx,ok:true,provider_records:responses.map(r=>r.body)}}];`,
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
  "={{ JSON.stringify({...($json.lane==='history'?{}:{timeMin:$json.window_start}),timeMax:$json.window_end,singleEvents:true,showDeleted:true,maxResults:$json.page_size,timeZone:'Europe/Paris',...($json.cursor?{pageToken:$json.cursor}:{})}) }}",
);
connect(liveCalendar, cChosen.success, cEvents.start);
addCommitPage(liveCalendar, cEvents.success, "ctx.provider_records", 5800);
// Preserve the generic owner guard. Root patches its owned private deployment in place;
// importing this inactive template must never register a second active bot webhook.
const googleTelegram = structuredClone(liveTelegram);
googleTelegram.id = "TendGoogle14";
googleTelegram.name = "Tend 14: Private approved Google owner control";
googleTelegram.settings.saveManualExecutions = false;
googleTelegram.settings.executionTimeout = 90;
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
    if (n.name === "Read or change fictional demo state")
      n.parameters.options = { timeout: 60000 };
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
  `const isExplicitCommitment=${isExplicitCommitment.toString()};const x=$input.first().json;const input=$('Read eligible authored span').first().json;const candidate=typeof x.text==='string'?JSON.parse(x.text):x;const span=input.record.authored_span;const keys=Object.keys(candidate);if(keys.length!==3||keys.some(k=>!['quote','action','suggested_due'].includes(k))||typeof candidate.quote!=='string'||typeof candidate.action!=='string'||candidate.quote!==span||!isExplicitCommitment(candidate.quote)||!candidate.quote.toLowerCase().includes(candidate.action.toLowerCase())||(candidate.suggested_due!==null&&(typeof candidate.suggested_due!=='string'||!/^\\d{4}-\\d{2}-\\d{2}$/.test(candidate.suggested_due)||!candidate.quote.includes(candidate.suggested_due))))throw new Error('unsupported or invented authored promise');return [{json:{record_key:input.record_key,content_hash:input.content_hash,candidate}}];`,
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

const liveReviewAI = privateWorkflow(
  "TendLive16",
  "Tend 16: Local AI cited contact briefing or review draft",
);
liveReviewAI.settings.executionTimeout = 120;
const reviewStart = node(
  "Run selected private AI review",
  "manualTrigger",
  {},
  0,
);
const reviewSelection = node(
  "Set explicit contact and review purpose",
  "set",
  {
    assignments: {
      assignments: [
        {
          id: "contact",
          name: "contact_id",
          value: "CONFIGURE_CONTACT_ID",
          type: "string",
        },
        {
          id: "purpose",
          name: "purpose",
          value: "CONFIGURE_PURPOSE",
          type: "string",
        },
        {
          id: "deliver",
          name: "deliver_to_owner",
          value: false,
          type: "boolean",
        },
        {
          id: "owner-chat",
          name: "owner_chat_id",
          value: "CONFIGURE_OWNER_CHAT_ID",
          type: "string",
        },
        {
          id: "owner-user",
          name: "owner_user_id",
          value: "CONFIGURE_OWNER_USER_ID",
          type: "string",
        },
      ],
    },
    includeOtherFields: false,
    options: {},
  },
  250,
  0,
  3.4,
);
const reviewSelectionGuard = code(
  "Validate explicit private AI selection",
  "const x=$input.first().json;if(typeof x.contact_id!=='string'||!x.contact_id.trim()||x.contact_id.length>128||x.contact_id==='OWNER'||x.contact_id.startsWith('CONFIGURE_')||!['briefing','draft'].includes(x.purpose))throw new Error('Configure an explicit contact ID and briefing or draft purpose before retrieval');if(x.deliver_to_owner!==undefined&&typeof x.deliver_to_owner!=='boolean')throw new Error('Owner delivery must be an explicit boolean');const deliver=x.deliver_to_owner===true;if(deliver&&(typeof x.owner_chat_id!=='string'||! /^[1-9]\\d{0,15}$/.test(x.owner_chat_id)||x.owner_chat_id!==x.owner_user_id))throw new Error('Configure the same enrolled private owner user and chat');return [{json:{contact_id:x.contact_id,purpose:x.purpose,deliver_to_owner:deliver,owner_chat_id:x.owner_chat_id,owner_user_id:x.owner_user_id,started_at:Date.now()}}];",
  500,
);
const reviewInput = liveHttp(
  "Read selected current AI evidence",
  "/api/live/ai/input",
  750,
);
reviewInput.parameters.url =
  "={{ 'http://host.docker.internal:18768/api/live/ai/input?contact_id=' + encodeURIComponent($json.contact_id) + '&purpose=' + encodeURIComponent($json.purpose) }}";
const reviewReady = code(
  "Check bounded current AI request",
  "const x=$input.first().json;if(x.eligible!==true)return [{json:{eligible:false}}];if(typeof x.request_id!=='string'||x.request_id.length<16||x.request_id.length>256||!x.request||!['qwen3:0.6b','qwen3:4b'].includes(x.request.model)||!Array.isArray(x.request.messages)||x.request.messages.length!==2||x.request.messages[0].role!=='system'||x.request.messages[1].role!=='user'||x.request.messages.some(m=>typeof m.content!=='string')||Buffer.byteLength(JSON.stringify(x.request),'utf8')>32768)throw new Error('Invalid or oversized private AI request');return [{json:{...x,eligible:true}}];",
  1000,
);
const reviewBranch = condition(
  "Selected current AI evidence available",
  "eligible",
  1250,
);
const reviewChain = structuredClone(ai);
reviewChain.name = "Local cited review (Basic LLM Chain)";
reviewChain.id = "local-cited-review-basic-llm-chain";
reviewChain.position = [1500, 0];
reviewChain.retryOnFail = false;
reviewChain.continueOnFail = true;
const reviewModel = structuredClone(model);
reviewModel.name = "Local review Ollama Chat Model";
reviewModel.id = "local-review-ollama-chat-model";
reviewModel.position = [1500, 260];
reviewModel.parameters.model =
  "={{ $('Check bounded current AI request').first().json.request.model }}";
reviewModel.parameters.options = {
  temperature: 0,
  format:
    "={{ $('Check bounded current AI request').first().json.request.format }}",
  think: false,
  numCtx: 8192,
  numPredict: 1024,
};
const reviewOutput = code(
  "Bound cited review output before validation",
  "const x=$input.first().json;const input=$('Check bounded current AI request').first().json;const clock=$('Validate explicit private AI selection').first().json.started_at;if(!Number.isFinite(clock)||Date.now()-clock>110000)throw new Error('Private AI review exceeded its deadline');const candidate=typeof x.text==='string'?x.text:Object.keys(x).every(k=>['items','draft'].includes(k))&&Array.isArray(x.items)?JSON.stringify(x):null;const output=typeof candidate==='string'&&Buffer.byteLength(candidate,'utf8')<=8192?candidate:null;return [{json:{request_id:input.request_id,output}}];",
  1750,
);
const reviewValidate = liveHttp(
  "Validate current cited AI review",
  "/api/live/ai/validate",
  2000,
  "={{ JSON.stringify($json) }}",
);
const reviewUnavailable = code(
  "No eligible selected AI evidence",
  "return [{json:{status:'unavailable',outbound_sent:false,draft:null,items:[],warning:'No eligible selected real evidence. No model call or draft was produced.'}}];",
  1500,
);
reviewUnavailable.position = [1500, 500];
const reviewResult = code(
  "Return review only without delivery",
  "const x=$input.first().json;if(x.outbound_sent!==false||!['validated','fallback','unavailable'].includes(x.status)||(x.draft!==null&&(!x.draft||x.draft.pending_review!==true))||Object.keys(x).some(k=>['recipients','actions','send','tools'].includes(k)))throw new Error('Private AI result must remain review only');return [{json:x}];",
  2250,
);
const reviewDeliveryCheck = code(
  "Check explicit owner delivery",
  "return [{json:{deliver_to_owner:$('Validate explicit private AI selection').first().json.deliver_to_owner===true}}];",
  2500,
);
const reviewDeliveryBranch = condition(
  "Owner delivery explicitly enabled",
  "deliver_to_owner",
  2750,
);
const reviewLocalResult = code(
  "Return local review without delivery",
  "return [{json:$('Return review only without delivery').first().json}];",
  3000,
);
reviewLocalResult.position = [3000, 500];
const reviewDeliveryFormat = code(
  "Prepare bounded validated owner review",
  String.raw`const c=$('Validate explicit private AI selection').first().json;const x=$('Return review only without delivery').first().json;const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));if(c.deliver_to_owner!==true||typeof c.owner_chat_id!=='string'||!/^[1-9]\d{0,15}$/.test(c.owner_chat_id)||c.owner_chat_id!==c.owner_user_id||!exact(x,['status','purpose','items','draft','outbound_sent','warning'])||x.status!=='validated'||x.outbound_sent!==false||!['briefing','draft'].includes(x.purpose)||x.purpose!==c.purpose||!Array.isArray(x.items)||x.items.length<1||x.items.length>3||x.items.some(i=>!exact(i,['record_key','content_hash','quote','source','evidence_reference'])||['record_key','content_hash','quote','source','evidence_reference'].some(k=>typeof i[k]!=='string'||!i[k])||!['gmail','calendar','whatsapp_personal','whatsapp_business','linkedin'].includes(i.source))||(x.purpose==='briefing'?x.draft!==null:!exact(x.draft,['text','pending_review','label','model','recipient','style_basis','prose_fact_verified'])||x.draft.label!=='AI-written draft. Check facts before sending'||x.draft.model!=='qwen3:4b'||!exact(x.draft.recipient,['contact_id','name'])||x.draft.recipient.contact_id!==c.contact_id||typeof x.draft.recipient.name!=='string'||!['neutral','recipient_examples'].includes(x.draft.style_basis)||x.draft.prose_fact_verified!==false||x.draft.pending_review!==true||typeof x.draft.text!=='string'||!x.draft.text))throw new Error('Only validated pending review output may reach the enrolled owner');const text='Tend '+(x.purpose==='draft'?'AI-written draft. Check facts before sending. Pending your review.':'cited briefing.')+(x.draft?'\nFor: '+x.draft.recipient.name+'\n\n'+x.draft.text:'')+'\n\n'+x.items.map(i=>'['+i.source+'] '+i.quote+'\nSource: '+i.evidence_reference).join('\n\n');const escaped=text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');if(escaped.length>3900)throw new Error('Owner review exceeds Telegram reply limit; use local review');return [{json:{text:escaped}}];`,
  3000,
);
const reviewDelivery = {
  ...node(
    "Deliver validated review only to enrolled owner",
    "telegram",
    {
      resource: "message",
      operation: "sendMessage",
      chatId:
        "={{ $('Validate explicit private AI selection').first().json.owner_chat_id }}",
      text: "={{ $json.text }}",
      additionalFields: {
        parse_mode: "HTML",
        appendAttribution: false,
        disable_web_page_preview: true,
        disable_notification: true,
      },
    },
    3250,
    0,
    1.2,
  ),
  disabled: true,
  retryOnFail: false,
  credentials: {
    telegramApi: {
      id: "CONFIGURE_OWNER_TELEGRAM_CREDENTIAL",
      name: "Configure existing enrolled owner Telegram credential",
    },
  },
};
const reviewDeliveryReceipt = code(
  "Verify owner delivery receipt",
  "const raw=$input.first().json;const wrapped=Object.hasOwn(raw,'result');if(!wrapped&&Object.hasOwn(raw,'ok'))throw new Error('Incomplete owner transport envelope; inspect delivery before any manual retry');if(wrapped&&(raw.ok!==true||!raw.result||typeof raw.result!=='object'||Array.isArray(raw.result)))throw new Error('Invalid owner transport envelope; inspect delivery before any manual retry');const x=wrapped?raw.result:raw;const c=$('Validate explicit private AI selection').first().json;if(!Number.isSafeInteger(x.message_id)||x.message_id<=0||!x.chat||x.chat.type!=='private'||String(x.chat.id)!==c.owner_chat_id)throw new Error('Owner transport acknowledgement unavailable or mismatched; inspect delivery before any manual retry');return [{json:{...$('Return review only without delivery').first().json,owner_delivery:{status:'sent',message_id:x.message_id}}}];",
  3500,
);
liveReviewAI.nodes.push(
  reviewStart,
  reviewSelection,
  reviewSelectionGuard,
  reviewInput,
  reviewReady,
  reviewBranch,
  reviewChain,
  reviewModel,
  reviewOutput,
  reviewValidate,
  reviewUnavailable,
  reviewResult,
  reviewDeliveryCheck,
  reviewDeliveryBranch,
  reviewLocalResult,
  reviewDeliveryFormat,
  reviewDelivery,
  reviewDeliveryReceipt,
);
connect(liveReviewAI, reviewStart.name, reviewSelection.name);
connect(liveReviewAI, reviewSelection.name, reviewSelectionGuard.name);
connect(liveReviewAI, reviewSelectionGuard.name, reviewInput.name);
connect(liveReviewAI, reviewInput.name, reviewReady.name);
connect(liveReviewAI, reviewReady.name, reviewBranch.name);
connect(liveReviewAI, reviewBranch.name, reviewChain.name);
connect(liveReviewAI, reviewBranch.name, reviewUnavailable.name, 1);
connect(liveReviewAI, reviewChain.name, reviewOutput.name);
connect(liveReviewAI, reviewOutput.name, reviewValidate.name);
connect(liveReviewAI, reviewValidate.name, reviewResult.name);
connect(liveReviewAI, reviewUnavailable.name, reviewResult.name);
connect(liveReviewAI, reviewResult.name, reviewDeliveryCheck.name);
connect(liveReviewAI, reviewDeliveryCheck.name, reviewDeliveryBranch.name);
connect(liveReviewAI, reviewDeliveryBranch.name, reviewDeliveryFormat.name);
connect(liveReviewAI, reviewDeliveryBranch.name, reviewLocalResult.name, 1);
connect(liveReviewAI, reviewDeliveryFormat.name, reviewDelivery.name);
connect(liveReviewAI, reviewDelivery.name, reviewDeliveryReceipt.name);
liveReviewAI.connections[reviewModel.name] = {
  ai_languageModel: [
    [{ node: reviewChain.name, type: "ai_languageModel", index: 0 }],
  ],
};
workflows.push(liveReviewAI);

for (const spec of [
  {
    number: 17,
    id: "TendSocial17",
    source: "whatsapp_personal",
    provider: "unipile",
    credential: "CONFIGURE_UNIPILE_READ_HEADER",
  },
  {
    number: 18,
    id: "TendSocial18",
    source: "linkedin",
    provider: "linkedin",
    credential: "CONFIGURE_LINKEDIN_PORTABILITY_HEADER",
  },
  {
    number: 19,
    id: "TendSocial19",
    source: "whatsapp_business",
    provider: "unipile",
    credential: "CONFIGURE_UNIPILE_BUSINESS_READ_HEADER",
  },
] as const) {
  const w = privateWorkflow(
    spec.id,
    `Tend ${spec.number}: Private ${spec.provider} verified read page`,
  );
  w.settings.executionTimeout = 120;
  const start = node(
    "Run one verified private provider page",
    "manualTrigger",
    {},
    0,
  );
  const selection = node(
    "Select approved provider account and phase",
    "set",
    {
      assignments: {
        assignments: [
          {
            id: "account",
            name: "account_id",
            value: "CONFIGURE_ACCOUNT_ID",
            type: "string",
          },
          { id: "phase", name: "phase", value: "snapshot", type: "string" },
        ],
      },
      includeOtherFields: false,
      options: {},
    },
    240,
    0,
    3.4,
  );
  const guard = code(
    "Validate configured read selection",
    `const x=$input.first().json;if(typeof x.account_id!=='string'||!x.account_id.trim()||x.account_id.length>1024||x.account_id.startsWith('CONFIGURE_')||!${JSON.stringify(spec.source === "linkedin" ? ["snapshot", "changes", "connections"] : ["snapshot"])}.includes(x.phase))throw new Error('Configure the approved provider account before retrieval');return [{json:{account_id:x.account_id,phase:x.phase,started_at:Date.now()}}];`,
    480,
  );
  const identity = liveHttp(
    "Plan owner identity read",
    "/api/live/social/read-input",
    720,
  );
  identity.parameters.url = `={{ 'http://host.docker.internal:18768/api/live/social/read-input?source=${spec.source}&account_id='+encodeURIComponent($json.account_id)+'&phase=identity' }}`;
  w.nodes.push(start, selection, guard, identity);
  connect(w, start.name, selection.name);
  connect(w, selection.name, guard.name);
  connect(w, guard.name, identity.name);
  const stages = [
    { prefix: "Owner identity", input: identity.name, x: 960 },
    {
      prefix: "Selected provider page",
      input: "Plan selected provider page",
      x: 2640,
    },
  ];
  const approvedOrigin =
    spec.provider === "linkedin"
      ? String.raw`/^https:\/\/api\.linkedin\.com(?::443)?\//`
      : String.raw`/^https:\/\/(?:api[0-9]*|[a-z0-9-]+)\.unipile\.com(?::(?:443|13111|16860))?\//`;
  for (const stage of stages) {
    const checked = code(
      `Check ${stage.prefix} plan`,
      String.raw`const x=$input.first().json;if(x.available!==true)throw new Error('Provider read unavailable: '+String(x.reason||'unavailable'));const p=x.plan;const url=p.url;if(p.method!=='GET'||p.source!==${JSON.stringify(spec.source)}||p.account_id!==$('Validate configured read selection').first().json.account_id||typeof url!=='string'||/[\s\u0000-\u001f\u007f\\]/u.test(url)||url.includes('#')||!${approvedOrigin}.test(url))throw new Error('Unapproved provider request');return [{json:x}];`,
      stage.x,
    );
    const provider = node(
      `Read ${stage.prefix}`,
      "httpRequest",
      {
        method: "GET",
        url: "={{ $json.plan.url }}",
        authentication: "genericCredentialType",
        genericAuthType: "httpHeaderAuth",
        sendHeaders: true,
        specifyHeaders: "json",
        jsonHeaders: "={{ JSON.stringify($json.plan.headers) }}",
        options: {
          timeout: 5000,
          redirect: { redirect: { followRedirects: false } },
          response: { response: { fullResponse: true, neverError: true } },
        },
      },
      stage.x + 240,
      0,
      4.2,
    );
    provider.credentials = {
      httpHeaderAuth: { id: spec.credential, name: spec.credential },
    };
    provider.retryOnFail = false;
    provider.continueOnFail = true;
    const envelope = code(
      `Bound ${stage.prefix} response`,
      `const ctx=$(${JSON.stringify(stage.input)}).first(0,${stage.prefix === "Selected provider page" ? "$runIndex" : "0"}).json;const r=$input.first().json;let status=Number(r.statusCode)||599;let body=r.body??{};const raw=r.headers||{};const retry=raw['retry-after']??raw['Retry-After'];const out={request_id:ctx.request_id,status,body,...(typeof retry==='string'&&retry.length<=128?{headers:{'Retry-After':retry}}:{})};if(!Number.isSafeInteger(ctx.max_result_bytes)||ctx.max_result_bytes<1024)throw new Error('Invalid server response budget');if(Buffer.byteLength(JSON.stringify(out),'utf8')>ctx.max_result_bytes)return [{json:{request_id:ctx.request_id,status:599,body:{error:'provider_envelope_exceeds_budget'}}}];return [{json:out}];`,
      stage.x + 480,
    );
    const result = liveHttp(
      `Validate ${stage.prefix} response`,
      "/api/live/social/read-result",
      stage.x + 720,
      "={{ JSON.stringify($json) }}",
    );
    result.retryOnFail = false;
    w.nodes.push(checked, provider, envelope, result);
    connect(w, stage.input, checked.name);
    connect(w, checked.name, provider.name);
    if (
      spec.provider === "unipile" &&
      stage.prefix === "Selected provider page"
    ) {
      const projection = code(
        "Project bounded WhatsApp message page",
        String.raw`const ctx=$('Plan selected provider page').first(0,$runIndex).json;const r=$input.first().json;
if(!Number.isSafeInteger(ctx.max_result_bytes)||ctx.max_result_bytes<1024||ctx.max_result_bytes>1048576)throw new Error('Invalid WhatsApp projection budget');
const status=Number(r.statusCode)||599;const retry=r.headers?.['retry-after']??r.headers?.['Retry-After'];const headers=typeof retry==='string'&&retry.length<=128?{headers:{'Retry-After':retry}}:{};
if(Buffer.byteLength(JSON.stringify(r),'utf8')>4194304)return [{json:{statusCode:status===200?599:status,body:{error:status===200?'provider_envelope_exceeds_budget':'provider_read_failed'},...headers}}];
let body={error:'provider_read_failed'};
if(status===200){const b=r.body,p=ctx.plan;if(!b||b.object!=='MessageList'||!Array.isArray(b.items)||!Number.isSafeInteger(p.limit)||p.limit<1||p.limit>20||b.items.length>p.limit||!Object.hasOwn(b,'cursor')||(b.cursor!==null&&(typeof b.cursor!=='string'||!b.cursor||b.cursor.length>8192||/[\u0000-\u001f\u007f]/u.test(b.cursor))))throw new Error('Invalid WhatsApp projection page');
const fields=['hidden','deleted','edited','is_event','event_type','is_hidden','id','message_id','account_id','chat_id','sender_id','is_sender','timestamp','text','chat_provider_id'];
const items=b.items.map(m=>{if(!m||typeof m!=='object'||Array.isArray(m))throw new Error('Invalid WhatsApp projection message');const out={};for(const key of fields)if(Object.hasOwn(m,key))out[key]=m[key];return out;});body={object:b.object,items,cursor:b.cursor};}
const projected={statusCode:status,body,...headers};if(Buffer.byteLength(JSON.stringify(projected),'utf8')>ctx.max_result_bytes)return [{json:{statusCode:599,body:{error:'provider_envelope_exceeds_budget'},...headers}}];return [{json:projected}];`,
        stage.x + 300,
      );
      const prepare = code(
        "Prepare exact WhatsApp chats",
        String.raw`const ctx=$('Plan selected provider page').first(0,$runIndex).json;const r=$input.first().json;
if(Number(r.statusCode)!==200)return [{json:{_chat_lookup:false}}];
const p=ctx.plan,b=r.body;const valid=v=>typeof v==='string'&&v.length>0&&v.length<=1024&&!/[\s\u0000-\u001f\u007f\\]/u.test(v);
if(p.source!==${JSON.stringify(spec.source)}||p.method!=='GET'||!valid(p.account_id)||!valid(p.expected_owner_identity)||!Number.isSafeInteger(p.limit)||p.limit<1||p.limit>20||!b||b.object!=='MessageList'||!Array.isArray(b.items)||b.items.length>p.limit||!Object.hasOwn(b,'cursor'))throw new Error('Invalid WhatsApp membership page');
if(!Number.isSafeInteger(ctx.max_result_bytes)||Buffer.byteLength(JSON.stringify(r),'utf8')>ctx.max_result_bytes)throw new Error('WhatsApp page exceeds budget');
if(typeof p.url!=='string'||!${approvedOrigin}.test(p.url)||/[\s\u0000-\u001f\u007f\\#]/u.test(p.url))throw new Error('Invalid WhatsApp membership origin');const origin=p.url.slice(0,p.url.indexOf('/',8));if(!p.url.startsWith(origin+'/api/v1/messages?'))throw new Error('Invalid WhatsApp membership path');
const ids=new Set(),groupish=new Set();for(const m of b.items){if(!m||m.account_id!==p.account_id||(!valid(m.chat_id)||m.chat_id==='.'||m.chat_id==='..'))throw new Error('Unbound WhatsApp message');ids.add(m.chat_id);if(typeof m.chat_provider_id==='string'&&(m.chat_provider_id.endsWith('@g.us')||m.chat_provider_id.endsWith('@broadcast')))groupish.add(m.chat_id);}
const lookup=[...ids].filter(id=>!groupish.has(id));
return lookup.length?lookup.map(chat_id=>({json:{_chat_lookup:true,chat_id,url:origin+'/api/v1/chats/'+encodeURIComponent(chat_id)}})):[{json:{_chat_lookup:false}}];`,
        stage.x + 360,
      );
      const needed = condition(
        "Exact WhatsApp chats needed",
        "_chat_lookup",
        stage.x + 420,
      );
      const chats = node(
        "Read exact WhatsApp chats",
        "httpRequest",
        {
          method: "GET",
          url: "={{ $json.url }}",
          authentication: "genericCredentialType",
          genericAuthType: "httpHeaderAuth",
          options: {
            // Repeated real chat reads abort at five seconds; retain a bounded 15-second request.
            timeout: 15000,
            redirect: { redirect: { followRedirects: false } },
            response: { response: { fullResponse: true, neverError: true } },
            batching: { batch: { batchSize: 4, batchInterval: 5000 } },
          },
        },
        stage.x + 480,
        240,
        4.2,
      );
      chats.credentials = {
        httpHeaderAuth: { id: spec.credential, name: spec.credential },
      };
      chats.retryOnFail = false;
      chats.continueOnFail = true;
      const membership = code(
        "Verify exact WhatsApp membership",
        String.raw`const ctx=$('Plan selected provider page').first(0,$runIndex).json;const r=$('Project bounded WhatsApp message page').first(0,$runIndex).json;
if(Number(r.statusCode)!==200)return [{json:r}];
const requests=$('Prepare exact WhatsApp chats').all(0,$runIndex).map(x=>x.json);const responses=$input.all().map(x=>x.json);const p=ctx.plan;
const blocked=reason=>[{json:{statusCode:599,body:{error:reason}}}];
if(requests.length>20||responses.length!==requests.length)return blocked('whatsapp_chat_response_count');
const proofs=new Map();const valid=v=>typeof v==='string'&&v.length>0&&v.length<=1024&&!/[\s\u0000-\u001f\u007f\\]/u.test(v);
let bytes=0;for(let i=0;i<requests.length;i++){if(requests[i]._chat_lookup!==true)continue;bytes+=Buffer.byteLength(JSON.stringify(responses[i]),'utf8');if(bytes>ctx.max_result_bytes)return blocked('whatsapp_chat_response_budget');}
const limited=responses.filter((response,i)=>requests[i]._chat_lookup===true&&Number(response.statusCode)===429);if(limited.length){let retry,fallback,maxDelay=-1;const now=Date.now();for(const response of limited){const headers=response.headers||{};const value=headers['retry-after']??headers['Retry-After'];if(typeof value!=='string'||value.length>128)continue;fallback??=value;const parsed=/^\d+$/.test(value)?Number(value):Math.ceil((Date.parse(value)-now)/1000);if(Number.isFinite(parsed)){const delay=Math.min(86400,Math.max(1,parsed));if(delay>maxDelay){maxDelay=delay;retry=value;}}}retry??=fallback;return [{json:{statusCode:429,body:{error:'whatsapp_chat_rate_limited'},...(retry!==undefined?{headers:{'Retry-After':retry}}:{})}}];}
for(let i=0;i<requests.length;i++){const req=requests[i];if(req._chat_lookup!==true)continue;const response=responses[i];const status=Number(response.statusCode)||599;if(status===404){proofs.set(req.chat_id,null);continue;}if(status!==200)return blocked(status===599?'whatsapp_chat_transport_failed':'whatsapp_chat_http_failed');const c=response.body;if(!c||c.object!=='Chat'||c.id!==req.chat_id||c.account_id!==p.account_id||c.account_type!=='WHATSAPP'||!valid(c.provider_id))return blocked('whatsapp_chat_identity_mismatch');
if(c.attendee_provider_id!==undefined&&c.attendee_provider_id!==null&&!valid(c.attendee_provider_id))return blocked('whatsapp_chat_peer_invalid');proofs.set(req.chat_id,c);}
const phoneJid=v=>typeof v==='string'&&/^\d+@s\.whatsapp\.net$/.test(v),lid=v=>typeof v==='string'&&/^\d+@lid$/.test(v);
const items=[];for(const raw of r.body.items){const {attendees,...m}=raw;const c=proofs.get(m.chat_id);if(c&&c.provider_id!==m.chat_provider_id){if((phoneJid(m.chat_provider_id)&&lid(c.provider_id))||(lid(m.chat_provider_id)&&phoneJid(c.provider_id))){items.push(m);continue;}return blocked('whatsapp_chat_provider_mismatch');}
if(c&&c.type===0&&valid(c.attendee_provider_id)&&c.attendee_provider_id!==p.expected_owner_identity){const peer=c.attendee_provider_id;const sent=m.is_sender===1||m.is_sender===true;const received=m.is_sender===0||m.is_sender===false;const actorIsOwner=m.sender_id===p.expected_owner_identity||(typeof m.sender_id==='string'&&/^\d+@lid$/.test(m.sender_id));if((sent&&actorIsOwner&&peer!==m.sender_id)||(received&&m.sender_id===peer))m.attendees=[{attendee_provider_id:p.expected_owner_identity},{attendee_provider_id:peer}];}items.push(m);}
return [{json:{...r,body:{...r.body,items}}}];`,
        stage.x + 600,
      );
      w.nodes.push(projection, prepare, needed, chats, membership);
      connect(w, provider.name, projection.name);
      connect(w, projection.name, prepare.name);
      connect(w, prepare.name, needed.name);
      connect(w, needed.name, chats.name);
      connect(w, needed.name, membership.name, 1);
      connect(w, chats.name, membership.name);
      connect(w, membership.name, envelope.name);
    } else connect(w, provider.name, envelope.name);
    connect(w, envelope.name, result.name);
  }
  const verified = code(
    "Require verified owner proof",
    "const x=$input.first().json;if(x.kind!=='identity'||typeof x.proof_id!=='string')throw new Error('Provider owner verification unavailable: '+String(x.reason||'unavailable'));return [{json:x}];",
    1920,
  );
  const page = liveHttp(
    "Plan selected provider page",
    "/api/live/social/read-input",
    2160,
  );
  page.parameters.url = `={{ 'http://host.docker.internal:18768/api/live/social/read-input?source=${spec.source}&account_id='+encodeURIComponent($('Validate configured read selection').first().json.account_id)+'&phase='+encodeURIComponent($('Validate configured read selection').first().json.phase)+'&proof_id='+encodeURIComponent($('Require verified owner proof').first().json.proof_id) }}`;
  const final = code(
    "Return private provider receipt",
    "const x=$input.first().json;if(!['page','connections','blocked'].includes(x.kind))throw new Error('Unknown provider receipt');return [{json:{...x,outbound_sent:false,submission_sent:false}}];",
    3600,
  );
  const paging = code(
    "Bound connections preview pagination",
    `const x=$input.first().json;const selection=$('Validate configured read selection').first().json;const pageIndex=$runIndex;
if(!${JSON.stringify(spec.source === "linkedin")}||selection.phase!=='connections')return [{json:{...x,_continue_connections:false}}];
if(!Number.isSafeInteger(pageIndex)||pageIndex<0||pageIndex>4)throw new Error('Invalid preview page index');
const previous=pageIndex>0?$('Bound connections preview pagination').first(0,pageIndex-1).json??{}:{};
if(x.kind==='blocked')return [{json:{...x,_continue_connections:false,more_available:true,preview_budget_exhausted:false,preview_interrupted:true}}];
if(x.kind!=='connections')throw new Error('Invalid connections preview');
const count=v=>Number.isSafeInteger(v)&&v>=0?v:0;
const rows=Array.isArray(previous.rows)?[...previous.rows]:[];let dropped=0;
for(const row of Array.isArray(x.rows)?x.rows:[]){if(rows.length<100&&Buffer.byteLength(JSON.stringify([...rows,row]),'utf8')<=65536)rows.push(row);else dropped++;}
const omitted=count(previous.omitted_row_count)+count(x.omitted_row_count)+dropped;
const hasMore=x.complete!==true;const next=hasMore&&pageIndex<4&&Number.isFinite(selection.started_at)&&Date.now()-selection.started_at<90000;
return [{json:{...x,rows,omitted_row_count:omitted,unknown_field_count:count(previous.unknown_field_count)+count(x.unknown_field_count),truncated_value_count:count(previous.truncated_value_count)+count(x.truncated_value_count),preview_truncated:omitted>0,preview_pages_read:pageIndex+1,more_available:hasMore,preview_budget_exhausted:hasMore&&!next,_continue_connections:next}}];`,
    3450,
  );
  const more = condition(
    "Another preview page fits this run",
    "_continue_connections",
    3600,
  );
  final.position = [3850, 0];
  final.parameters.jsCode = String(final.parameters.jsCode).replace(
    "return [{json:{...x,",
    "const {_continue_connections,...receipt}=x;return [{json:{...receipt,",
  );
  w.nodes.push(verified, page, paging, more, final);
  connect(w, "Validate Owner identity response", verified.name);
  connect(w, verified.name, page.name);
  connect(w, "Validate Selected provider page response", paging.name);
  connect(w, paging.name, more.name);
  connect(w, more.name, page.name);
  connect(w, more.name, final.name, 1);
  workflows.push(w);
}

// Error workflow for the fictional lane only. It receives n8n's Error Trigger
// payload, keeps just the names and a short message (never item data) and
// records them on the local fixture API. Private live workflows keep their
// no-save policy and do not use an error workflow.
const errorHandler = workflow(
  "TendReview21",
  "Tend 21: Error handler (fictional lane)",
  [
    node("Error Trigger", "errorTrigger", {}, 0, 0, 1),
    code(
      "Redact failure to names only",
      "const e=$input.first().json;const wf=e.workflow&&typeof e.workflow.name==='string'?e.workflow.name:'unknown workflow';const ex=e.execution||{};const node=ex.lastNodeExecuted||(ex.error&&ex.error.node&&ex.error.node.name)||'unknown node';const raw=ex.error&&typeof ex.error.message==='string'?ex.error.message:'no message';return [{json:{workflow:wf.slice(0,120),node:String(node).slice(0,120),message:raw.replace(/\\s+/g,' ').slice(0,200),execution_id:String(ex.id??'').slice(0,40)}}];",
      260,
    ),
    http(
      "Record failure on fixture API",
      "/api/failure-log",
      520,
      "={{ JSON.stringify($json) }}",
    ),
  ],
);
errorHandler.nodes[0]!.notes =
  "Set as the Error workflow of fictional workflows 01-09. Publish this workflow after import: n8n only runs published error workflows, and only for production runs. Stores only workflow name, failing node and a 200-character message.";
for (const w of workflows)
  if (/^TendReview0[1-9]$/.test(w.id))
    w.settings.errorWorkflow = "TendReview21";

// One sticky note per canvas so each workflow explains itself in the editor.
const NO_SAVE =
  "Private lane: no execution data is saved (success and error), so provider text never lands in n8n history.";
const adapterNote = (source: string) => ({
  purpose: `Fictional ${source} adapter for the demo lane.`,
  inputs: `Manual run; GET /api/fixtures on the local fixture API.`,
  outputs: "Records handed to sub-workflow 06 (normalize and store).",
  privacy:
    "Fictional fixtures only (Mira Tan, F17). No account or credential. Failures go to error workflow 21.",
});
const canvasNotes: Record<
  string,
  { purpose: string; inputs: string; outputs: string; privacy: string }
> = {
  TendReview01: adapterNote("Gmail"),
  TendReview02: adapterNote("Calendar"),
  TendReview03: adapterNote("personal WhatsApp"),
  TendReview04: adapterNote("business WhatsApp"),
  TendReview05: adapterNote("LinkedIn"),
  TendReview06: {
    purpose: "Sub-workflow: validate scope, normalize and store one record.",
    inputs: "Called by adapters 01-05 with fictional source records.",
    outputs: "One committed record in the local fixture store.",
    privacy:
      "Rejects anything outside the fictional scope. Failures go to error workflow 21.",
  },
  TendReview07: {
    purpose:
      "Extract a promise from one fictional record with the local AI (Ollama).",
    inputs: "Manual run; one fictional record from the fixture API.",
    outputs:
      "A pending candidate with its exact quote. Never an active commitment until the owner confirms.",
    privacy:
      "Local model only, no cloud AI. Quote must match the source text. Failures go to error workflow 21.",
  },
  TendReview08: {
    purpose: "Route an owner command and build a cited briefing preview.",
    inputs: "Manual run with a fictional private command.",
    outputs: "An owner-scoped reply preview, or a rejection.",
    privacy:
      "Owner and private chat checked first. Fictional data only. Failures go to error workflow 21.",
  },
  TendReview09: {
    purpose: "Show bounded retry: a synthetic 429 that recovers.",
    inputs: "Manual run; isolated retry scenario on the fixture API.",
    outputs: "One recovery record.",
    privacy: "Synthetic data only. Failures go to error workflow 21.",
  },
  TendLiveTelegram: {
    purpose: "Owner control over Telegram (/status, /today, /confirm ...).",
    inputs: "Telegram private message from the configured owner.",
    outputs: "One reply to the authorized owner and a send acknowledgement.",
    privacy: `Every other sender or chat is refused. ${NO_SAVE}`,
  },
  TendGoogle11: {
    purpose: "Read-only Gmail sync inside the approved time window.",
    inputs: "Schedule or manual run; Gmail API with read-only scope.",
    outputs: "Raw records handed to sub-workflow 13; a saved sync cursor.",
    privacy: `Read-only scope, approved window and request budget. ${NO_SAVE}`,
  },
  TendGoogle12: {
    purpose: "Read-only sync of the chosen Google Calendars.",
    inputs: "Schedule or manual run; Calendar API with read-only scope.",
    outputs: "Events handed to sub-workflow 13; a saved sync cursor.",
    privacy: `Read-only scope, chosen calendars only. ${NO_SAVE}`,
  },
  TendGoogle13: {
    purpose: "Sub-workflow: normalize and store approved Google records.",
    inputs: "Called by 11 and 12 with raw approved records.",
    outputs: "Committed records in the canonical store and page context.",
    privacy: `Validates the approved scope before any write. ${NO_SAVE}`,
  },
  TendGoogle14: {
    purpose: "Owner control over Telegram for the approved Google lane.",
    inputs: "Telegram private message from the configured owner.",
    outputs: "One reply to the authorized owner and a send acknowledgement.",
    privacy: `Every other sender or chat is refused. ${NO_SAVE}`,
  },
  TendGoogle15: {
    purpose: "Local AI promise extraction on newly authored Google evidence.",
    inputs: "Schedule or manual run; eligible authored spans from the store.",
    outputs: "Owner-scoped pending promises with exact quotes.",
    privacy: `Local Ollama only; nothing is active until the owner confirms. ${NO_SAVE}`,
  },
  TendLive16: {
    purpose: "Local AI cited briefing or review draft for one chosen contact.",
    inputs: "Manual run with an explicit contact and review purpose.",
    outputs: "A cited briefing or draft for owner review. Nothing is sent.",
    privacy: `Local Ollama only; every claim must cite stored evidence. ${NO_SAVE}`,
  },
  TendSocial17: {
    purpose: "Read one verified page of personal WhatsApp (Unipile).",
    inputs: "Manual run; approved provider account and phase.",
    outputs: "One bounded page of records for the private store.",
    privacy: `Read-only; owner identity verified first. ${NO_SAVE}`,
  },
  TendSocial18: {
    purpose: "Read one verified page of LinkedIn messages.",
    inputs: "Manual run; approved provider account and phase.",
    outputs: "One bounded page of records for the private store.",
    privacy: `Read-only; owner identity verified first. ${NO_SAVE}`,
  },
  TendSocial19: {
    purpose: "Read one verified page of business WhatsApp (Unipile).",
    inputs: "Manual run; approved provider account and phase.",
    outputs: "One bounded page of records for the private store.",
    privacy: `Read-only; owner identity verified first. ${NO_SAVE}`,
  },
  TendDailyOwnerBriefing: {
    purpose: "Daily private briefing at 09:00 Paris, sent once per day.",
    inputs: "Schedule with bounded catch-up; the dated priority digest.",
    outputs: "One Telegram message to the owner and its acknowledgement.",
    privacy: `Sent only to the exact configured owner chat. ${NO_SAVE}`,
  },
  TendReview21: {
    purpose: "Error workflow for fictional workflows 01-09.",
    inputs:
      "n8n Error Trigger (production runs only; publish 21 after import).",
    outputs: "POST /api/failure-log on the fixture API.",
    privacy:
      "Keeps only workflow name, failing node, a 200-character message and execution ID. No item data.",
  },
};
function withCanvasNote<
  W extends {
    id: string;
    nodes: { position: [number, number] }[];
  },
>(w: W): W {
  const note = canvasNotes[w.id];
  if (!note) throw new Error(`Missing canvas note for ${w.id}`);
  const x = Math.min(...w.nodes.map((n) => n.position[0]));
  const y = Math.min(...w.nodes.map((n) => n.position[1]));
  w.nodes.push({
    id: "canvas-note",
    name: "About this workflow",
    type: "n8n-nodes-base.stickyNote",
    typeVersion: 1,
    position: [x, y - 340],
    parameters: {
      content: `## ${w.id}\n**Purpose:** ${note.purpose}\n\n**Inputs:** ${note.inputs}\n\n**Outputs:** ${note.outputs}\n\n**Privacy:** ${note.privacy}`,
      width: 520,
      height: 300,
      color: 7,
    },
    retryOnFail: false,
  } as unknown as W["nodes"][number]);
  return w;
}
await mkdir("workflows", { recursive: true });
await writeJson(
  "workflows/21-error-handler.json",
  withCanvasNote(errorHandler),
);
for (let i = 0; i < workflows.length; i++)
  await writeJson(
    `workflows/${String(i + 1).padStart(2, "0")}-${["gmail", "calendar", "whatsapp-personal", "whatsapp-business", "linkedin", "normalize-store", "extract-commitments", "assistant", "retry-fixture", "telegram-private", "google-gmail-readonly", "google-calendar-readonly", "google-normalize-store", "google-telegram-private", "google-extract-commitments", "live-ai-review", "personal-whatsapp-readonly", "linkedin-portability-readonly", "business-whatsapp-readonly"][i]}.json`,
    withCanvasNote(workflows[i]!),
  );
await writeJson(
  "workflows/20-daily-owner-briefing.json",
  withCanvasNote(buildDailyBriefingWorkflow()),
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
  `Built ${workflows.length + 2} inactive workflow exports and fictional fixture data.`,
);
