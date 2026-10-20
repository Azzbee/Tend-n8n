interface DailyNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
  retryOnFail: false;
  continueOnFail?: boolean;
}
interface DailyWorkflow {
  id: string;
  name: string;
  active: false;
  nodes: DailyNode[];
  connections: Record<
    string,
    { main: { node: string; type: "main"; index: number }[][] }
  >;
  settings: {
    executionOrder: "v1";
    timezone: "Europe/Paris";
    executionTimeout: number;
    saveDataSuccessExecution: "none";
    saveDataErrorExecution: "none";
    saveManualExecutions: false;
  };
  pinData: Record<string, never>;
  tags: never[];
}
const guard = String.raw`const ownerUser='CONFIGURE_OWNER_USER_ID',ownerChat='CONFIGURE_OWNER_CHAT_ID';
if(!/^[1-9]\d{0,15}$/.test(ownerUser)||ownerChat!==ownerUser)throw new Error('Exact configured owner required');
const t=$input.first().json.transport;if(t===null)return [];
if(!t||typeof t!=='object'||Object.keys(t).sort().join(',')!=='chat_id,delivery_id,paris_date,text'||t.chat_id!==ownerChat||typeof t.text!=='string'||!t.text.trim()||t.text.length>4096||typeof t.paris_date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(t.paris_date)||typeof t.delivery_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(t.delivery_id))throw new Error('Exact private owner transport required');
return [{json:t}];`;
const inspect = String.raw`const ownerUser='CONFIGURE_OWNER_USER_ID',ownerChat='CONFIGURE_OWNER_CHAT_ID';
const selected=$('Validate exact owner transport').first().json,raw=$input.first().json;
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);const wrapped=object(raw)&&Object.hasOwn(raw,'result');
const receipt=wrapped?raw.result:raw;
const valid=/^[1-9]\d{0,15}$/.test(ownerUser)&&ownerUser===ownerChat&&object(raw)&&(!wrapped?!Object.hasOwn(raw,'ok'):raw.ok===true)&&object(receipt)&&Number.isSafeInteger(receipt.message_id)&&receipt.message_id>0&&object(receipt.chat)&&receipt.chat.type==='private'&&['string','number'].includes(typeof receipt.chat.id)&&String(receipt.chat.id)===ownerChat;
return [{json:{paris_date:selected.paris_date,delivery_id:selected.delivery_id,receipt_valid:Boolean(valid),...(valid?{receipt:raw}:{})}}];`;
export function buildDailyBriefingWorkflow(): DailyWorkflow {
  const nodes: DailyNode[] = [];
  const connections: DailyWorkflow["connections"] = {};
  const add = (
    name: string,
    type: string,
    parameters: Record<string, unknown>,
    x: number,
    y = 0,
    version = 2,
  ): DailyNode => {
    const n: DailyNode = {
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name,
      type: `n8n-nodes-base.${type}`,
      typeVersion: version,
      parameters,
      position: [x, y],
      retryOnFail: false,
    };
    nodes.push(n);
    return n;
  };
  const connect = (from: string, to: string, branch = 0): void => {
    const c = connections[from] ?? { main: [] };
    while (c.main.length <= branch) c.main.push([]);
    c.main[branch]!.push({ node: to, type: "main", index: 0 });
    connections[from] = c;
  };
  const http = (
    name: string,
    route: string,
    body: string,
    x: number,
    y = 0,
  ): DailyNode => {
    const n = add(
      name,
      "httpRequest",
      {
        method: "POST",
        url: `http://host.docker.internal:18768/api/live/daily/${route}`,
        authentication: "genericCredentialType",
        genericAuthType: "httpHeaderAuth",
        sendBody: true,
        contentType: "raw",
        rawContentType: "application/json",
        body,
        options: { timeout: 55000 },
      },
      x,
      y,
      4.2,
    );
    n.credentials = {
      httpHeaderAuth: {
        id: "CONFIGURE_INTERNAL_API_CREDENTIAL_ID",
        name: "CONFIGURE_INTERNAL_API_CREDENTIAL",
      },
    };
    return n;
  };
  add(
    "Daily Paris schedule and bounded catch-up",
    "scheduleTrigger",
    {
      rule: {
        interval: [
          { field: "cronExpression", expression: "0 0 9 * * *" },
          { field: "cronExpression", expression: "0 */5 9-12 * * *" },
        ],
      },
    },
    0,
    0,
    1.2,
  );
  http("Prepare dated priority digest", "prepare", "{}", 240);
  add(
    "Continue only a pending dated digest",
    "code",
    {
      jsCode:
        "const x=$input.first().json;if(x.state!=='pending'||typeof x.paris_date!=='string'||typeof x.delivery_id!=='string')return [];return [{json:{paris_date:x.paris_date,delivery_id:x.delivery_id}}];",
    },
    480,
  );
  http(
    "Claim once after current evidence validation",
    "claim",
    "={{ JSON.stringify($json) }}",
    720,
  );
  add("Validate exact owner transport", "code", { jsCode: guard }, 960);
  const send = add(
    "Send one private daily briefing",
    "telegram",
    {
      resource: "message",
      operation: "sendMessage",
      chatId: "={{ $json.chat_id }}",
      text: "={{ $json.text }}",
      additionalFields: {
        appendAttribution: false,
        disable_web_page_preview: true,
      },
    },
    1200,
    0,
    1.2,
  );
  send.credentials = {
    telegramApi: {
      id: "CONFIGURE_TELEGRAM_CREDENTIAL_ID",
      name: "CONFIGURE_TELEGRAM_CREDENTIAL",
    },
  };
  send.continueOnFail = true;
  add("Inspect actual Telegram receipt", "code", { jsCode: inspect }, 1440);
  add(
    "Actual matching receipt available",
    "if",
    {
      conditions: {
        options: { caseSensitive: true, typeValidation: "strict", version: 2 },
        conditions: [
          {
            id: "actual-receipt",
            leftValue: "={{ $json.receipt_valid }}",
            rightValue: true,
            operator: { type: "boolean", operation: "true", singleValue: true },
          },
        ],
        combinator: "and",
      },
      options: {},
    },
    1680,
    0,
    2.2,
  );
  http(
    "Record actual owner acknowledgement",
    "ack",
    "={{ JSON.stringify({paris_date:$json.paris_date,delivery_id:$json.delivery_id,receipt:$json.receipt}) }}",
    1920,
  );
  http(
    "Hold uncertain owner delivery",
    "uncertain",
    "={{ JSON.stringify({paris_date:$json.paris_date,delivery_id:$json.delivery_id}) }}",
    1920,
    180,
  );
  const chain = [
    "Daily Paris schedule and bounded catch-up",
    "Prepare dated priority digest",
    "Continue only a pending dated digest",
    "Claim once after current evidence validation",
    "Validate exact owner transport",
    "Send one private daily briefing",
    "Inspect actual Telegram receipt",
    "Actual matching receipt available",
  ];
  for (let i = 1; i < chain.length; i++) connect(chain[i - 1]!, chain[i]!);
  connect(
    "Actual matching receipt available",
    "Record actual owner acknowledgement",
  );
  connect(
    "Actual matching receipt available",
    "Hold uncertain owner delivery",
    1,
  );
  return {
    id: "TendDailyOwnerBriefing",
    name: "Tend: Daily private owner briefing at 09:00 Paris",
    active: false,
    nodes,
    connections,
    settings: {
      executionOrder: "v1",
      timezone: "Europe/Paris",
      executionTimeout: 180,
      saveDataSuccessExecution: "none",
      saveDataErrorExecution: "none",
      saveManualExecutions: false,
    },
    pinData: {},
    tags: [],
  };
}
