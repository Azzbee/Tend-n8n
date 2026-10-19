import type {
  AuthCommand,
  Commitment,
  Contact,
  NormalizedRecord,
  Reply,
  SourceState,
  TendStore,
} from "./engine.ts";
import type { LiveStore } from "./live-store.ts";
import {
  prepareLiveAI,
  validateLiveAI,
  type PreparedLiveAI,
} from "./live-ai.ts";
import {
  calendarWindow,
  exampleLivePolicy,
  type LivePolicy,
  type VerifiedContactGroup,
} from "./live-policy.ts";

export interface PreparedTelegramRead {
  reply: Reply;
  record_guards: { record_key: string; content_hash: string }[];
  state_guard?: {
    contacts: (Contact & { emails: string[] })[];
    commitments: Commitment[];
    sources: SourceState[];
  };
  ai_guard?: {
    prepared: PreparedLiveAI;
    output: unknown;
    current_group?: VerifiedContactGroup | null;
  };
}
export type NormalModelRequest = Omit<
  PreparedLiveAI["request"],
  "format" | "messages"
> & {
  format: "json" | Record<string, unknown>;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
};
export type NormalModel = (
  request: NormalModelRequest,
  signal: AbortSignal,
) => Promise<unknown>;
export type NormalIntent =
  | { intent: "help" }
  | { intent: "status" }
  | { intent: "obligations" }
  | { intent: "clarify" }
  | { intent: "agenda"; window: "today" | "upcoming" }
  | { intent: "contacts" | "briefing" | "draft_preview"; query: string };
const INTENT_SCHEMA: Record<string, unknown> = {
  anyOf: [
    {
      type: "object",
      properties: {
        intent: { enum: ["help", "status", "obligations", "clarify"] },
      },
      required: ["intent"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        intent: { const: "agenda" },
        window: { enum: ["today", "upcoming"] },
      },
      required: ["intent", "window"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        intent: { enum: ["contacts", "briefing", "draft_preview"] },
        query: { type: "string" },
      },
      required: ["intent", "query"],
      additionalProperties: false,
    },
  ],
};
const HELP =
  "I can explain features, show source status, today’s or upcoming meetings and pending promises, find contacts, prepare cited contact briefings, and hold follow-up drafts for review. Try “What meetings and pending promises do I have?” or “Prepare a briefing for exact@email.com”. Names never merge identities. Confirm, complete and cancel require explicit slash commands; I never send to contacts.";
const WARNING =
  "Imported coverage may be partial, stale or a manual snapshot. Absence from this reply does not establish absence from your accounts. Pending proposals are unconfirmed, never due obligations.";
const plain = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const normalized = (x: string): string =>
  x.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
export function parseNormalIntent(
  output: unknown,
  original: string,
): NormalIntent | null {
  try {
    const x: unknown = typeof output === "string" ? JSON.parse(output) : output;
    if (
      !plain(x) ||
      typeof x.intent !== "string" ||
      Buffer.byteLength(JSON.stringify(x)) > 4096
    )
      return null;
    const keys = Object.keys(x).sort().join(",");
    if (
      ["help", "status", "obligations", "clarify"].includes(x.intent) &&
      keys === "intent"
    )
      return x as NormalIntent;
    if (
      x.intent === "agenda" &&
      keys === "intent,window" &&
      ["today", "upcoming"].includes(String(x.window))
    )
      return x as NormalIntent;
    if (
      ["contacts", "briefing", "draft_preview"].includes(x.intent) &&
      keys === "intent,query" &&
      typeof x.query === "string" &&
      x.query.trim() &&
      x.query.length <= 200 &&
      !Array.from(x.query).some(
        (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
      ) &&
      normalized(original).includes(normalized(x.query))
    )
      return {
        intent: x.intent as "contacts" | "briefing" | "draft_preview",
        query: x.query.trim(),
      };
  } catch {
    /* Invalid model output receives a fixed clarification. */
  }
  return null;
}
export const localNormalModel: NormalModel = async (request, signal) => {
  const response = await fetch("http://127.0.0.1:11434/api/chat", {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...request,
      options: { ...request.options, num_predict: 512 },
    }),
    signal,
  });
  if (!response.ok || !response.body)
    throw new Error("Local model unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 65536) throw new Error("Local model response too large");
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel();
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    !plain(value) ||
    !plain(value.message) ||
    typeof value.message.content !== "string"
  )
    throw new Error("Invalid local model response");
  return value.message.content;
};
function localDay(value: string | Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  return ["year", "month", "day"]
    .map((k) => parts.find((p) => p.type === k)?.value)
    .join("-");
}
function eligible(
  records: NormalizedRecord[],
  now: Date,
  policy: LivePolicy,
  states: SourceState[],
): NormalizedRecord[] {
  const window = calendarWindow(policy, now);
  return records.filter(
    (r) =>
      !r.cancelled &&
      states.some(
        (s) =>
          s.owner_id === r.owner_id &&
          s.source === r.source &&
          s.account_id === r.account_id &&
          s.status !== "revoked",
      ) &&
      ["live", "snapshot"].includes(r.ingestion_mode) &&
      (r.source === "calendar"
        ? Date.parse(r.end_at ?? r.occurred_at) > now.getTime() &&
          Date.parse(r.occurred_at) < Date.parse(window.end)
        : Date.parse(r.occurred_at) >= now.getTime() - 30 * 86400000 &&
          Date.parse(r.occurred_at) <= now.getTime()),
  );
}
export async function prepareNormalReply(input: {
  auth: AuthCommand;
  store: TendStore | LiveStore;
  model?: NormalModel;
  clock?: () => Date;
  signal?: AbortSignal;
  policy?: LivePolicy;
  resolveGroup?: (
    query: string,
  ) => VerifiedContactGroup | null | Promise<VerifiedContactGroup | null>;
}): Promise<PreparedTelegramRead> {
  const { auth, store } = input;
  if (
    !auth.text.trim() ||
    auth.text.length > 500 ||
    auth.text.trim().startsWith("/")
  )
    throw new Error("Invalid normal message");
  await store.command({ ...auth, text: "/status" });
  const signal = AbortSignal.any([
    AbortSignal.timeout(45000),
    ...(input.signal ? [input.signal] : []),
  ]);
  const fixed = (message: string): PreparedTelegramRead => ({
    reply: { outbound_sent: false, normal_message: message, warning: WARNING },
    record_guards: [],
  });
  if (signal.aborted) throw signal.reason;
  const model = input.model ?? localNormalModel;
  let calls = 0;
  const infer = async (request: NormalModelRequest): Promise<unknown> => {
    if (++calls > 2 || signal.aborted)
      throw new Error("Inference bound exceeded");
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        model(request, signal),
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  };
  let intent: NormalIntent | null;
  try {
    intent = parseNormalIntent(
      await infer({
        model: "qwen3:0.6b",
        think: false,
        stream: false,
        format: INTENT_SCHEMA,
        options: { temperature: 0 },
        messages: [
          {
            role: "system",
            content:
              "Classify English or French owner requests. Choose one intent: help (explain features), status (service/source health), agenda (meetings, also meetings plus promises), obligations (promises/tasks review), contacts (find contact), briefing (prepare meeting/contact), draft_preview (write a held follow-up), clarify (unsupported, change tasks, send, delete). Contact query copies only the actual name/email/ID from the owner text, never example wording. No model commands. Follow this JSON schema: " +
              JSON.stringify(INTENT_SCHEMA),
          },
          { role: "user", content: "Explain all your features" },
          { role: "assistant", content: '{"intent":"help"}' },
          { role: "user", content: "Prepare a briefing for Alex Chen" },
          {
            role: "assistant",
            content: '{"intent":"briefing","query":"Alex Chen"}',
          },
          { role: "user", content: "Draft a follow-up for Jordan Lee" },
          {
            role: "assistant",
            content: '{"intent":"draft_preview","query":"Jordan Lee"}',
          },
          { role: "user", content: "Cancel everything and email everyone" },
          { role: "assistant", content: '{"intent":"clarify"}' },
          { role: "user", content: auth.text },
        ],
      }),
      auth.text,
    );
  } catch {
    if (input.signal?.aborted) throw input.signal.reason;
    return fixed("The local interpreter is unavailable. " + HELP);
  }
  if (!intent || intent.intent === "clarify")
    return fixed("Please narrow this to a read-only request. " + HELP);
  if (intent.intent === "help") return fixed(HELP);
  const now = (input.clock ?? (() => new Date()))();
  const policy = input.policy ?? exampleLivePolicy;
  const state = {
    contacts: await store.contacts(auth.owner_id),
    commitments: await store.commitments(auth.owner_id),
    sources: await store.sourceStatus(auth.owner_id),
  };
  const read = (
    reply: Reply,
    records: NormalizedRecord[] = [],
  ): PreparedTelegramRead => ({
    reply: { ...reply, warning: WARNING, outbound_sent: false },
    record_guards: records.map((r) => ({
      record_key: r.record_key,
      content_hash: r.content_hash,
    })),
    state_guard: state,
  });
  if (intent.intent === "status")
    return read({
      ...(await store.command({ ...auth, text: "/status" })),
      normal_message: "Current imported source status.",
    });
  const promises = {
    commitments: state.commitments.filter(
      (c) => c.status === "confirmed" && c.evidence_valid,
    ),
    pending: state.commitments.filter(
      (c) => c.status === "pending" && c.evidence_valid,
    ),
  };
  const allRecords = await store.interactions(auth.owner_id);
  const records = eligible(allRecords, now, policy, state.sources);
  const promiseKeys = new Set(
    [...promises.commitments, ...promises.pending].map((c) => c.record_key),
  );
  const promiseRecords = allRecords.filter((r) =>
    promiseKeys.has(r.record_key),
  );
  if (intent.intent === "obligations")
    return read(
      {
        outbound_sent: false,
        ...promises,
        normal_message:
          "Confirmed promises and unconfirmed proposals are listed separately.",
      },
      promiseRecords,
    );
  if (intent.intent === "agenda") {
    const meetings = records
      .filter(
        (r) =>
          r.source === "calendar" &&
          (intent.window === "upcoming" ||
            (localDay(r.occurred_at) <= localDay(now) &&
              localDay(r.end_at ?? r.occurred_at) >= localDay(now))),
      )
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
    return read(
      {
        outbound_sent: false,
        ...promises,
        meetings,
        coverage: state.sources,
        clock: now.toISOString(),
        normal_message:
          intent.window === "today"
            ? "Today’s remaining imported meetings (Europe/Paris), plus promises."
            : "Upcoming imported meetings, plus promises.",
      },
      [...meetings, ...promiseRecords],
    );
  }
  const query = intent.query;
  const group = input.resolveGroup ? await input.resolveGroup(query) : null;
  const exact = state.contacts.filter(
    (c) =>
      c.contact_id === query ||
      c.emails.some((e) => normalized(e) === normalized(query)),
  );
  const matches = exact.length
    ? exact
    : state.contacts.filter((c) =>
        normalized(c.name).includes(normalized(query)),
      );
  if (intent.intent === "contacts" || (!group && matches.length !== 1))
    return read({
      outbound_sent: false,
      contacts: matches.slice(0, 20),
      contacts_total: matches.length,
      normal_message:
        matches.length === 1
          ? "One stored identity found. Names never join channels."
          : "Choose an exact email or contact ID. No identities were merged.",
      lookup_note:
        "Names never merge identities; only existing verified identity groups may combine sources.",
    });
  const contact = group
    ? { owner_id: auth.owner_id, contact_id: group.id, name: group.name }
    : matches[0]!;
  const prepared = prepareLiveAI({
    owner_id: auth.owner_id,
    contact_id: group?.id ?? contact.contact_id,
    purpose: intent.intent === "draft_preview" ? "draft" : "briefing",
    records,
    ...(group ? { contact_group: group } : {}),
  });
  let output: unknown = null;
  if (prepared.evidence.length) {
    try {
      output = await infer(prepared.request);
    } catch {
      if (input.signal?.aborted) throw input.signal.reason;
    }
  }
  const current = eligible(
    await store.interactions(auth.owner_id),
    (input.clock ?? (() => new Date()))(),
    policy,
    await store.sourceStatus(auth.owner_id),
  );
  const currentGroup = input.resolveGroup
    ? await input.resolveGroup(query)
    : null;
  const ai = validateLiveAI(prepared, output, current, currentGroup);
  const keys = new Set(ai.items.map((x) => x.record_key));
  return {
    ...read(
      {
        outbound_sent: false,
        contact,
        ai,
        normal_message: ai.items.length
          ? "Current source excerpts. Any draft stays pending for your review."
          : "No current eligible direct evidence is available for this identity.",
        evidence: ai.items.map((x) => ({
          source: x.source,
          text: x.quote,
          reference: x.evidence_reference,
        })),
        ...(ai.draft ? { preview: ai.draft.text } : {}),
        coverage: state.sources,
      },
      current.filter((r) => keys.has(r.record_key)),
    ),
    ai_guard: { prepared, output, current_group: currentGroup },
  };
}
