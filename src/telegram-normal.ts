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
  liveAIDependencies,
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
  | { intent: "digest" }
  | { intent: "agenda"; window: "today" | "upcoming" }
  | {
      intent: "contacts" | "briefing" | "draft_preview" | "search";
      query: string;
    };
const INTENT_SCHEMA: Record<string, unknown> = {
  anyOf: [
    {
      type: "object",
      properties: {
        intent: {
          enum: ["help", "status", "obligations", "clarify", "digest"],
        },
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
        intent: { enum: ["contacts", "briefing", "draft_preview", "search"] },
        query: { type: "string" },
      },
      required: ["intent", "query"],
      additionalProperties: false,
    },
  ],
};
const HELP =
  "I can explain features, show source status, today’s or upcoming meetings and pending promises, find contacts, search imported messages by keywords, give a priority briefing, prepare cited contact briefings, and hold follow-up drafts for review. Try “What meetings and pending promises do I have?” or “Prepare a briefing for exact@email.com”. Names never merge identities. Confirm, complete and cancel require explicit slash commands; I never send to contacts.";
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
      ["help", "status", "obligations", "clarify", "digest"].includes(
        x.intent,
      ) &&
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
      ["contacts", "briefing", "draft_preview", "search"].includes(x.intent) &&
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
        intent: x.intent as
          "contacts" | "briefing" | "draft_preview" | "search",
        query: x.query.trim(),
      };
  } catch {
    /* Invalid model output receives a fixed clarification. */
  }
  return null;
}
export const localNormalModel: NormalModel = async (request, signal) => {
  if (!["qwen3:0.6b", "qwen3:4b"].includes(request.model))
    throw new Error("Unapproved local model");
  const draft = request.model === "qwen3:4b";
  const response = await fetch("http://127.0.0.1:11434/api/chat", {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...request,
      think: false,
      stream: false,
      ...(draft ? { keep_alive: 0 } : {}),
      options: {
        temperature: 0,
        num_predict: draft ? 1024 : 512,
        num_ctx: 8192,
      },
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
  owner: string,
  enforcePolicy: boolean,
): NormalizedRecord[] {
  const window = calendarWindow(policy, now);
  return records.filter(
    (r) =>
      r.owner_id === owner &&
      !r.cancelled &&
      (!enforcePolicy ||
        (r.source === "gmail"
          ? r.account_id.toLowerCase() === policy.account_email.toLowerCase()
          : r.source === "calendar"
            ? policy.calendar_ids.includes(r.account_id) ||
              Boolean(
                policy.manual_calendar_snapshots?.some(
                  (snapshot) =>
                    snapshot.calendar_id === r.account_id &&
                    snapshot.event_id === r.source_record_id,
                ),
              )
            : Boolean(
                policy.social?.accounts.some(
                  (account) =>
                    account.source === r.source &&
                    account.account_id === r.account_id &&
                    account.owner_verified,
                ),
              ))) &&
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
              "Classify English or French owner requests. Choose one intent: help (explain features), status (service/source health), agenda (meetings, also meetings plus promises), obligations (promises/tasks review), contacts (find contact), briefing (prepare meeting/contact), draft_preview (write a held follow-up), search (find imported messages about copied owner keywords), digest (focus/priority/daily briefing), clarify (unsupported, change tasks, send, delete). Contact/search query copies only the actual name/email/ID/topic keywords from the owner text, never example wording. For contact intents query is ONLY the name/email/ID, excluding following message instructions. A request to write a held draft remains draft_preview when it says not to promise, not to propose a time or not to send. Those are draft constraints, not requests to mutate tasks. Intent boundaries: draft_preview means compose/write recipient text, including write NAME a note, friendly note, follow-up, brouillon, rédige, suivi. Composition is NEVER contacts or obligations. contacts means LOOK UP contact information only. obligations means LIST existing promises only. A draft may mention calls or protocol reviews without requesting agenda or task changes. An actual send request is clarify; a request to write a draft without sending is draft_preview. No model commands. Follow this JSON schema: " +
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
          {
            role: "user",
            content:
              "Draft a short casual follow-up for Mira Tan asking about the prototype notes. The September call is in the past. Do not propose a meeting time.",
          },
          {
            role: "assistant",
            content: '{"intent":"draft_preview","query":"Mira Tan"}',
          },
          {
            role: "user",
            content:
              "Rédige un suivi formel pour Docteur Chen afin de demander où en est la relecture du protocole, sans promettre de délai ni proposer de rendez-vous.",
          },
          {
            role: "assistant",
            content: '{"intent":"draft_preview","query":"Docteur Chen"}',
          },
          {
            role: "user",
            content:
              "Write Sam Patel a brief note checking how the proposal is progressing, without suggesting a time.",
          },
          {
            role: "assistant",
            content: '{"intent":"draft_preview","query":"Sam Patel"}',
          },
          {
            role: "user",
            content:
              "Peux-tu préparer un brouillon pour Camille au sujet de son retour sur le dossier ? Ne propose aucun rendez-vous.",
          },
          {
            role: "assistant",
            content: '{"intent":"draft_preview","query":"Camille"}',
          },
          { role: "user", content: "Find messages about Secure Horizons" },
          {
            role: "assistant",
            content: '{"intent":"search","query":"Secure Horizons"}',
          },
          { role: "user", content: "What should I focus on?" },
          { role: "assistant", content: '{"intent":"digest"}' },
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
      (c) =>
        c.owner_id === auth.owner_id &&
        c.status === "confirmed" &&
        c.evidence_valid,
    ),
    pending: state.commitments.filter(
      (c) =>
        c.owner_id === auth.owner_id &&
        c.status === "pending" &&
        c.evidence_valid,
    ),
  };
  const allRecords = await store.interactions(auth.owner_id);
  const records = eligible(
    allRecords,
    now,
    policy,
    state.sources,
    auth.owner_id,
    input.policy !== undefined,
  );
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
  if (intent.intent === "search") {
    const query = normalized(intent.query);
    const terms = [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])].slice(
      0,
      12,
    );
    const ranked = terms.length
      ? records
          .flatMap((record) => {
            const text = normalized(record.body_text.slice(0, 16384));
            if (!terms.every((term) => text.includes(term))) return [];
            return [
              {
                record,
                score:
                  (text.includes(query) ? 8 : 0) +
                  terms.reduce(
                    (sum, term) =>
                      sum + Math.min(6, text.split(term).length - 1),
                    0,
                  ),
              },
            ];
          })
          .sort(
            (a, b) =>
              b.score - a.score ||
              b.record.occurred_at.localeCompare(a.record.occurred_at) ||
              a.record.record_key.localeCompare(b.record.record_key),
          )
          .slice(0, 10)
      : [];
    return read(
      {
        outbound_sent: false,
        search_query: intent.query,
        search_limit: 10,
        search_results: ranked.map(({ record }) => ({
          date: record.occurred_at,
          source: record.source,
          reference: record.evidence_reference,
          text: record.body_text.slice(0, 500),
          attribution: record.attribution ?? "unknown",
        })),
        normal_message: ranked.length
          ? "Imported keyword matches. People and channels remain separate."
          : "No imported keyword match. This does not establish absence from your accounts.",
        search_note:
          "Bounded keyword ranking over the first 16,384 characters of eligible imported records; at most ten results. Not complete semantic search.",
        coverage: state.sources,
      },
      ranked.map(({ record }) => record),
    );
  }
  if (intent.intent === "digest") {
    const today = localDay(now);
    const byKey = new Map(records.map((record) => [record.record_key, record]));
    const due = promises.commitments
      .filter(
        (commitment) =>
          commitment.due_date !== null &&
          commitment.due_date <= today &&
          byKey.has(commitment.record_key),
      )
      .sort(
        (a, b) =>
          a.due_date!.localeCompare(b.due_date!) ||
          a.commitment_id.localeCompare(b.commitment_id),
      );
    const meetings = records
      .filter((record) => record.source === "calendar")
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
    const used = new Set(
      [...due, ...promises.pending].map((commitment) => commitment.record_key),
    );
    const suggestions = records
      .filter(
        (record) =>
          record.source !== "calendar" &&
          record.kind === "message" &&
          record.direction === "received" &&
          record.attribution === "direct" &&
          record.contact_ids?.length === 1 &&
          Date.parse(record.occurred_at) >= now.getTime() - 3 * 86400000 &&
          !used.has(record.record_key),
      )
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
    const candidates = [
      ...due.map((commitment) => ({
        record: byKey.get(commitment.record_key)!,
        entry: {
          kind:
            commitment.due_date! < today
              ? "confirmed_overdue"
              : "confirmed_due",
          reason: `${commitment.direction === "owed_to_me" ? "Confirmed obligation owed to you" : "Confirmed obligation owed by you"} ${commitment.due_date! < today ? "overdue" : "due today"}`,
          direction: commitment.direction,
          date: commitment.due_date,
          source: commitment.source,
          reference: byKey.get(commitment.record_key)!.evidence_reference,
          text: commitment.action,
          commitment_id: commitment.commitment_id,
        },
      })),
      ...meetings.map((record) => ({
        record,
        entry: {
          kind: "meeting",
          reason: "Upcoming or ongoing imported meeting",
          date: record.occurred_at,
          source: record.source,
          reference: record.evidence_reference,
          text: record.body_text.slice(0, 320),
        },
      })),
      ...suggestions.map((record) => ({
        record,
        entry: {
          kind: "review_suggestion",
          reason:
            "Recent directly received text to review. Suggested attention, not verified urgency or a promise.",
          date: record.occurred_at,
          source: record.source,
          reference: record.evidence_reference,
          text: (record.authored_text ?? record.body_text).slice(0, 320),
        },
      })),
    ].slice(0, 5);
    const pending = promises.pending.filter((commitment) =>
      byKey.has(commitment.record_key),
    );
    const shownPending = pending.slice(0, 5 - candidates.length);
    const unavailable = [...promises.commitments, ...promises.pending].filter(
      (commitment) => !byKey.has(commitment.record_key),
    ).length;
    return read(
      {
        outbound_sent: false,
        priorities: candidates.map(({ entry }) => entry),
        priority_pending: shownPending.map((commitment) => ({
          kind: "unconfirmed_proposal",
          direction: commitment.direction,
          reason: "Unconfirmed proposal. No confirmed deadline or urgency.",
          date: null,
          source: commitment.source,
          reference: byKey.get(commitment.record_key)!.evidence_reference,
          text: commitment.action,
          commitment_id: commitment.commitment_id,
        })),
        pending_total: pending.length,
        priority_unavailable_count: unavailable,
        normal_message:
          candidates.length || shownPending.length
            ? "Priority review: confirmed due promises, upcoming meetings, then recent received messages. Unconfirmed proposals are separate."
            : "No eligible priorities in the imported window. This does not establish that no obligations or messages exist. Older or unavailable evidence is not shown.",
        coverage: state.sources,
        clock: now.toISOString(),
      },
      [
        ...candidates.map(({ record }) => record),
        ...shownPending.map((commitment) => byKey.get(commitment.record_key)!),
      ],
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
  const namedMember = group?.members
    .slice()
    .sort((a, b) => Number(b.source === "gmail") - Number(a.source === "gmail"))
    .map((member) =>
      state.contacts.find(
        (candidate) =>
          candidate.contact_id === member.contact_id &&
          candidate.emails.some(
            (identity) => normalized(identity) === normalized(member.identity),
          ),
      ),
    )
    .find(
      (candidate) =>
        candidate &&
        candidate.name.trim() &&
        candidate.name !== candidate.contact_id &&
        !candidate.name.includes("@") &&
        !/^\+?[\d\s]+$/u.test(candidate.name),
    );
  const contact = group
    ? {
        owner_id: auth.owner_id,
        contact_id: group.id,
        name: namedMember?.name ?? "this contact",
      }
    : matches[0]!;
  if (contact.name.length > 200)
    return read({
      outbound_sent: false,
      normal_message:
        "This stored contact display name needs review before a personalised draft. Choose a contact with a name of at most 200 characters.",
      contacts: [contact],
    });
  const prepared = prepareLiveAI({
    owner_id: auth.owner_id,
    contact_id: group?.id ?? contact.contact_id,
    purpose: intent.intent === "draft_preview" ? "draft" : "briefing",
    records,
    ...(group ? { contact_group: group } : {}),
    ...(intent.intent === "draft_preview" && input.policy
      ? {
          draft_context: {
            now: now.toISOString(),
            contact_name: contact.name,
            owner_request: auth.text,
            policy,
          },
        }
      : {}),
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
    auth.owner_id,
    input.policy !== undefined,
  );
  const currentGroup = input.resolveGroup
    ? await input.resolveGroup(query)
    : null;
  const ai = validateLiveAI(
    prepared,
    output,
    current,
    currentGroup,
    (input.clock ?? (() => new Date()))(),
  );
  const keys = new Set(liveAIDependencies(prepared).map((x) => x.record_key));
  return {
    ...read(
      {
        outbound_sent: false,
        contact,
        ai,
        normal_message: ai.draft
          ? ai.draft.label
          : ai.items.length
            ? (ai.warning ??
              "Current source excerpts. No generated draft is available.")
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
    record_guards: liveAIDependencies(prepared),
    ai_guard: { prepared, output, current_group: currentGroup },
  };
}
