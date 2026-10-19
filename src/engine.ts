import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { canonicalEmail, type LiveRecord } from "./google-records.ts";
import { calendarWindow, exampleLivePolicy } from "./live-policy.ts";
import { chmodSync } from "node:fs";
import { validateLiveAI, liveAIRecordFingerprint } from "./live-ai.ts";
import type { VerifiedContactGroup } from "./live-policy.ts";
import type {
  PreparedTelegramRead,
  TelegramAIFreshness,
} from "./telegram-normal.ts";
import {
  eligiblePromiseSpans,
  isExplicitCommitment,
} from "./authored-promises.ts";
export const sources = [
  "gmail",
  "calendar",
  "whatsapp_personal",
  "whatsapp_business",
  "linkedin",
] as const;
export type Source = (typeof sources)[number];
export interface Contact {
  owner_id: string;
  contact_id: string;
  name: string;
}
export interface Identity {
  owner_id: string;
  identity: string;
  contact_id: string;
}
export interface SourceState {
  owner_id: string;
  source: Source;
  account_id: string;
  mode: "fixture" | "snapshot" | "live";
  last_success: string | null;
  status: string;
  coverage_start: string;
  coverage_end: string;
  cursor: string | null;
  retry_after_until?: string | null;
  attempt_count?: number;
  last_error?: number | null;
  last_batch_hash?: string;
  evidence_incomplete?: boolean;
  pagination_complete?: boolean;
}
export interface RawRecord {
  owner_id: string;
  source: Source;
  account_id: string;
  source_record_id: string;
  source_thread_id: string;
  kind: string;
  direction: "sent" | "received" | "event";
  actor_identity: string;
  participant_identities: string[];
  occurred_at: string;
  observed_at: string;
  body_text: string;
  evidence_reference: string;
  ingestion_mode: "fixture" | "snapshot" | "live";
  coverage_start: string;
  coverage_end: string;
  cancelled: boolean;
}
export interface NormalizedRecord extends RawRecord {
  contact_id: string;
  content_hash: string;
  record_key: string;
  contact_ids?: string[];
  authored_text?: string;
  authored_spans?: { start: number; end: number; text: string }[];
  attribution?: "direct" | "group" | "unknown";
  eligible_for_extraction?: boolean;
  end_at?: string;
  all_day?: boolean;
}
export interface StoreOptions {
  mode?: "fixture" | "live";
  principal?: { owner_id: string; user_id: string; chat_id: string };
  clock?: () => Date;
}
export interface LiveBatch {
  evidence_incomplete?: boolean;
  operation_hash?: string;
  owner_id: string;
  source: Source;
  account_id: string;
  records: LiveRecord[];
  cursor: string | null;
  complete: boolean;
  coverage_start: string;
  coverage_end: string;
  reconcile: boolean;
  seen_record_ids: string[];
  contacts?: Contact[];
  identities?: Identity[];
  removed_record_ids?: string[];
  expected_cursor?: string | null;
  quarantines?: {
    source_record_id: string;
    reason: string;
    observed_at: string;
  }[];
}
export function liveBatchCompletion(
  state: SourceState,
  batch: LiveBatch,
): {
  complete: boolean;
  flags: Pick<SourceState, "evidence_incomplete" | "pagination_complete">;
} {
  if (
    state.mode === "snapshot" &&
    (state.source !== "calendar" ||
      batch.source !== "calendar" ||
      batch.complete ||
      batch.reconcile ||
      batch.cursor !== null ||
      batch.records.length !== 1 ||
      batch.records[0]?.ingestion_mode !== "snapshot" ||
      (batch.removed_record_ids?.length ?? 0) !== 0 ||
      batch.seen_record_ids.length !== 1 ||
      batch.seen_record_ids[0] !== batch.records[0].source_record_id ||
      batch.evidence_incomplete !== true)
  )
    throw new Error("single partial calendar snapshot required");
  if (
    batch.evidence_incomplete !== undefined &&
    typeof batch.evidence_incomplete !== "boolean"
  )
    throw new Error("invalid evidence completeness flag");
  const tracked =
    batch.evidence_incomplete !== undefined ||
    state.evidence_incomplete !== undefined ||
    state.pagination_complete !== undefined;
  const incomplete =
    state.evidence_incomplete === true || batch.evidence_incomplete === true;
  return {
    complete: batch.complete && !incomplete,
    flags: tracked
      ? { evidence_incomplete: incomplete, pagination_complete: batch.complete }
      : {},
  };
}
export function resetLiveCompleteness(
  state: SourceState,
): Pick<SourceState, "evidence_incomplete" | "pagination_complete"> {
  return state.evidence_incomplete !== undefined ||
    state.pagination_complete !== undefined
    ? { evidence_incomplete: false, pagination_complete: false }
    : {};
}
export interface Candidate {
  quote: string;
  action: string;
  suggested_due: string | null;
}
export interface Commitment extends Candidate {
  commitment_id: string;
  owner_id: string;
  contact_id: string;
  source: Source;
  record_key: string;
  direction: "owed_by_me" | "owed_to_me";
  status: string;
  due_date: string | null;
  evidence_valid: boolean;
}
export interface AuthCommand {
  owner_id: string;
  user_id: string;
  chat_id: string;
  chat_type: string;
  text: string;
}
export interface Reply {
  outbound_sent: false;
  [key: string]: unknown;
}
export function telegramAIContactScope(
  owner: string,
  contactId: string,
  group: VerifiedContactGroup | null | undefined,
  contacts: (Contact & { emails: string[] })[],
): TelegramAIFreshness["recipient"] | null {
  const ids = new Set(
    group ? group.members.map((member) => member.contact_id) : [contactId],
  );
  const members = contacts
    .filter(
      (contact) => contact.owner_id === owner && ids.has(contact.contact_id),
    )
    .map((contact) => ({ ...contact, emails: [...contact.emails].sort() }))
    .sort((a, b) => a.contact_id.localeCompare(b.contact_id));
  if (!group) {
    const contact = members.find((member) => member.contact_id === contactId);
    return contact
      ? {
          contact: {
            owner_id: owner,
            contact_id: contactId,
            name: contact.name,
          },
          members,
        }
      : null;
  }
  if (group.id !== contactId) return null;
  const named = [...group.members]
    .sort((a, b) => Number(b.source === "gmail") - Number(a.source === "gmail"))
    .map((member) =>
      members.find(
        (contact) =>
          contact.contact_id === member.contact_id &&
          contact.emails.some((identity) =>
            member.source === "gmail"
              ? identity.toLowerCase() === member.identity.toLowerCase()
              : identity === member.identity,
          ),
      ),
    )
    .find(
      (contact) =>
        contact &&
        contact.name.trim() &&
        contact.name !== contact.contact_id &&
        !contact.name.includes("@") &&
        !/^\+?[\d\s]+$/u.test(contact.name),
    );
  return {
    contact: {
      owner_id: owner,
      contact_id: contactId,
      name: named?.name ?? "this contact",
    },
    members,
  };
}
export function telegramAIRecordSet(
  owner: string,
  contactId: string,
  group: VerifiedContactGroup | null | undefined,
  records: readonly NormalizedRecord[],
  accounts: TelegramAIFreshness["accounts"],
): TelegramAIFreshness["records"] {
  return records
    .filter(
      (record) =>
        record.owner_id === owner &&
        accounts.some(
          (account) =>
            account.source === record.source &&
            account.account_id === record.account_id &&
            (!account.record_ids ||
              account.record_ids.includes(record.source_record_id)),
        ) &&
        (group
          ? group.members.some(
              (member) =>
                member.source === record.source &&
                member.account_id === record.account_id &&
                record.contact_ids?.includes(member.contact_id) &&
                (record.actor_identity === member.identity ||
                  record.participant_identities.includes(member.identity)),
            )
          : record.contact_id === contactId ||
            record.contact_ids?.includes(contactId)),
    )
    .map((record) => ({
      record_key: record.record_key,
      fingerprint: liveAIRecordFingerprint(record),
    }))
    .sort((a, b) => a.record_key.localeCompare(b.record_key));
}
export function validatePreparedTelegramReply(
  owner: string,
  prepared: PreparedTelegramRead,
  records: readonly NormalizedRecord[],
  contacts: (Contact & { emails: string[] })[],
  commitments: Commitment[],
  states: SourceState[],
  now: Date,
): Reply {
  const fallback: Reply = {
    outbound_sent: false,
    warning:
      "Source evidence changed while preparing this reply. Ask again for current evidence.",
  };
  const canonical = (value: unknown): string => {
    const ordered = (item: unknown): unknown =>
      Array.isArray(item)
        ? item.map(ordered)
        : isRecord(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, ordered(item[key])]),
            )
          : item;
    return JSON.stringify(ordered(value));
  };
  if (prepared.reply.outbound_sent !== false) return fallback;
  if (
    !prepared.ai_guard?.freshness &&
    prepared.state_guard &&
    canonical(prepared.state_guard) !==
      canonical({ contacts, commitments, sources: states })
  )
    return fallback;
  const window = calendarWindow(exampleLivePolicy, now);
  const current = records.filter(
    (record) =>
      record.owner_id === owner &&
      !record.cancelled &&
      ["live", "snapshot"].includes(record.ingestion_mode) &&
      states.some(
        (state) =>
          state.owner_id === owner &&
          state.source === record.source &&
          state.account_id === record.account_id &&
          state.status !== "revoked",
      ) &&
      (record.source === "calendar"
        ? Date.parse(record.end_at ?? record.occurred_at) > now.getTime() &&
          Date.parse(record.occurred_at) < Date.parse(window.end)
        : Date.parse(record.occurred_at) >= now.getTime() - 30 * 86400000 &&
          Date.parse(record.occurred_at) <= now.getTime()),
  );
  if (
    prepared.record_guards.some(
      (guard) =>
        !current.some(
          (record) =>
            record.record_key === guard.record_key &&
            record.content_hash === guard.content_hash,
        ),
    )
  )
    return fallback;
  if (prepared.ai_guard) {
    const guard = prepared.ai_guard;
    if (guard.freshness) {
      const group = guard.prepared.contact_group?.group;
      if (
        guard.prepared.draft_context &&
        guard.prepared.draft_context.contact_name !==
          guard.freshness.recipient.contact.name
      )
        return fallback;
      if (
        group?.members.some(
          (member) =>
            !states.some(
              (state) =>
                state.owner_id === owner &&
                state.source === member.source &&
                state.account_id === member.account_id &&
                state.status !== "revoked",
            ),
        )
      )
        return fallback;
      if (group && canonical(group) !== canonical(guard.current_group))
        return fallback;
      const recipient = telegramAIContactScope(
        owner,
        guard.prepared.contact_id,
        group,
        contacts,
      );
      if (
        canonical(recipient) !== canonical(guard.freshness.recipient) ||
        canonical(
          telegramAIRecordSet(
            owner,
            guard.prepared.contact_id,
            group,
            current,
            guard.freshness.accounts,
          ),
        ) !== canonical(guard.freshness.records)
      )
        return fallback;
    } else if (!prepared.state_guard) return fallback;
    if (
      guard.prepared.owner_id !== owner ||
      canonical(
        validateLiveAI(
          guard.prepared,
          guard.output,
          current,
          guard.current_group,
          now,
        ),
      ) !== canonical(prepared.reply.ai)
    )
      return fallback;
  }
  return {
    ...structuredClone(prepared.reply),
    ...(prepared.ai_guard?.freshness
      ? { coverage: structuredClone(states) }
      : {}),
  };
}
export function exactTimestamp(s: string): boolean {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      s,
    )
  )
    return false;
  const day = s.slice(0, 10),
    d = new Date(`${day}T00:00:00Z`);
  return (
    Number.isFinite(Date.parse(s)) &&
    Number.isFinite(d.getTime()) &&
    d.toISOString().slice(0, 10) === day
  );
}
export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
export function parseRaw(x: unknown): RawRecord {
  if (!isRecord(x)) throw new Error("invalid record object");
  const required = [
    "owner_id",
    "source",
    "account_id",
    "source_record_id",
    "source_thread_id",
    "kind",
    "direction",
    "actor_identity",
    "occurred_at",
    "observed_at",
    "body_text",
    "evidence_reference",
    "ingestion_mode",
    "coverage_start",
    "coverage_end",
  ];
  for (const k of required)
    if (typeof x[k] !== "string" || (x[k] as string).length === 0)
      throw new Error(`invalid ${k}`);
  if (
    !Array.isArray(x.participant_identities) ||
    !x.participant_identities.every((v) => typeof v === "string")
  )
    throw new Error("invalid participants");
  if (typeof x.cancelled !== "boolean") throw new Error("invalid cancelled");
  if (
    !sources.includes(x.source as Source) ||
    !["sent", "received", "event"].includes(x.direction as string) ||
    !["fixture", "snapshot", "live"].includes(x.ingestion_mode as string)
  )
    throw new Error("invalid enum");
  return x as unknown as RawRecord;
}
export function normalizeRecord(
  raw: RawRecord,
  identities: Identity[],
): NormalizedRecord {
  parseRaw(raw);
  for (const k of [
    "occurred_at",
    "observed_at",
    "coverage_start",
    "coverage_end",
  ] as const)
    if (!exactTimestamp(raw[k])) throw new Error(`invalid timestamp ${k}`);
  if (Date.parse(raw.coverage_start) > Date.parse(raw.coverage_end))
    throw new Error("reversed coverage window");
  if (raw.kind !== (raw.source === "calendar" ? "meeting" : "message"))
    throw new Error("unsupported/group record");
  if (raw.source === "calendar" && raw.direction !== "event")
    throw new Error("invalid event direction");
  if (raw.source !== "calendar" && raw.direction === "event")
    throw new Error("invalid message direction");
  const own = identities.filter((i) => i.owner_id === raw.owner_id);
  const actor = own.find((i) => i.identity === raw.actor_identity);
  if (!actor) throw new Error("unresolved identity");
  const participants = raw.participant_identities.map((id) =>
    own.find((i) => i.identity === id),
  );
  if (participants.some((i) => !i)) throw new Error("unresolved participant");
  const contacts = [
    ...new Set(
      [actor, ...participants.filter((i): i is Identity => !!i)]
        .map((i) => i.contact_id)
        .filter((id) => id !== "OWNER"),
    ),
  ];
  if (contacts.length !== 1) throw new Error("unresolved/group attribution");
  if (
    (raw.direction === "sent") !== (actor.contact_id === "OWNER") &&
    raw.source !== "calendar"
  )
    throw new Error("inconsistent actor direction");
  const key = JSON.stringify([
    raw.owner_id,
    raw.source,
    raw.account_id,
    raw.source_record_id,
  ]);
  return {
    ...raw,
    contact_id: contacts[0]!,
    record_key: createHash("sha256").update(key).digest("hex"),
    content_hash: createHash("sha256")
      .update(
        JSON.stringify([
          raw.body_text,
          raw.occurred_at,
          raw.cancelled,
          raw.direction,
          raw.actor_identity,
          raw.participant_identities,
          contacts[0],
        ]),
      )
      .digest("hex"),
  };
}
export function validateCandidate(raw: RawRecord, input: unknown): Candidate {
  return validateEvidenceCandidate(raw, input, (text) =>
    /^I (?:will|promise to)\b/i.test(text),
  );
}
function validateEvidenceCandidate(
  raw: RawRecord,
  input: unknown,
  explicit: (text: string) => boolean,
): Candidate {
  if (
    !isRecord(input) ||
    Object.keys(input).some(
      (k) => !["quote", "action", "suggested_due"].includes(k),
    )
  )
    throw new Error("invalid candidate fields");
  if (
    typeof input.quote !== "string" ||
    typeof input.action !== "string" ||
    (input.suggested_due !== null && typeof input.suggested_due !== "string")
  )
    throw new Error("invalid candidate types");
  if (
    !input.quote ||
    !input.action ||
    !raw.body_text.includes(input.quote) ||
    !input.quote.toLowerCase().includes(input.action.toLowerCase())
  )
    throw new Error("fabricated quote/action");
  if (input.quote !== raw.body_text.trim() || raw.body_text.includes("\n"))
    throw new Error(
      "single direct utterance required; quoted reply needs review",
    );
  if (!explicit(input.quote)) throw new Error("not explicit promise");
  if (raw.kind !== "message") throw new Error("not conversation");
  if (
    input.suggested_due !== null &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(input.suggested_due) ||
      !exactTimestamp(`${input.suggested_due}T00:00:00Z`) ||
      !input.quote.includes(input.suggested_due))
  )
    throw new Error("fabricated/ambiguous date");
  return {
    quote: input.quote,
    action: input.action,
    suggested_due: input.suggested_due,
  };
}
export function retryDelay(attempt: number, retryAfter: string | null): number {
  if (attempt < 0 || attempt >= 3) throw new Error("retry limit");
  const seconds =
    retryAfter !== null && /^\d+(?:\.\d+)?$/.test(retryAfter)
      ? Number(retryAfter)
      : null;
  const delay = seconds !== null ? seconds * 1000 : 500 * 2 ** attempt;
  if (delay > 10000) throw new Error("retry budget: defer run");
  return delay;
}
export function normalizeLiveRecord(
  raw: RawRecord,
  identities: Identity[],
): NormalizedRecord {
  if (typeof raw.body_text !== "string") throw new Error("invalid body_text");
  parseRaw({ ...raw, body_text: raw.body_text || "(no authored text)" });
  if (
    !["live", "snapshot"].includes(raw.ingestion_mode) ||
    !sources.includes(raw.source)
  )
    throw new Error("live source required");
  const record = raw as LiveRecord;
  if (
    !Array.isArray(record.contact_ids) ||
    !Array.isArray(record.authored_spans) ||
    typeof record.authored_text !== "string" ||
    typeof record.eligible_for_extraction !== "boolean" ||
    !["direct", "group", "unknown"].includes(record.attribution)
  )
    throw new Error("invalid live record");
  for (const time of [
    raw.occurred_at,
    raw.observed_at,
    raw.coverage_start,
    raw.coverage_end,
  ])
    if (!exactTimestamp(time)) throw new Error("invalid timestamp");
  if (Date.parse(raw.coverage_start) > Date.parse(raw.coverage_end))
    throw new Error("reversed coverage");
  const actor = identities.find((x) => x.identity === raw.actor_identity);
  const participants = raw.participant_identities.map((email) =>
    identities.find((x) => x.identity === email),
  );
  if (!actor || participants.some((x) => !x))
    throw new Error("unresolved identity");
  if (
    raw.source !== "calendar" &&
    ((raw.direction === "sent") !== (actor.contact_id === "OWNER") ||
      raw.kind !== "message")
  )
    throw new Error("inconsistent actor direction");
  if (
    raw.source === "calendar" &&
    (raw.direction !== "event" || raw.kind !== "meeting")
  )
    throw new Error("invalid calendar direction");
  const contacts = [
    ...new Set(
      [actor, ...participants.filter((x): x is Identity => !!x)]
        .map((x) => x.contact_id)
        .filter((x) => x !== "OWNER"),
    ),
  ].sort();
  if (
    JSON.stringify(contacts) !==
    JSON.stringify([...new Set(record.contact_ids)].sort())
  )
    throw new Error("contact binding mismatch");
  if (
    record.authored_spans.some(
      (span) =>
        !Number.isInteger(span.start) ||
        !Number.isInteger(span.end) ||
        span.start < 0 ||
        span.end < span.start ||
        record.authored_text.slice(span.start, span.end) !== span.text ||
        !raw.body_text.includes(span.text),
    )
  )
    throw new Error("invalid authored span");
  const record_key = createHash("sha256")
    .update(
      JSON.stringify([
        raw.owner_id,
        raw.source,
        raw.account_id,
        raw.source_record_id,
      ]),
    )
    .digest("hex");
  const content_hash = createHash("sha256")
    .update(
      JSON.stringify([
        raw.body_text,
        raw.occurred_at,
        raw.cancelled,
        raw.direction,
        raw.actor_identity,
        raw.participant_identities,
        record.contact_ids,
        record.authored_spans,
        record.attribution,
        record.end_at,
        record.all_day,
      ]),
    )
    .digest("hex");
  return {
    ...record,
    contact_id: contacts.length === 1 ? contacts[0]! : "",
    record_key,
    content_hash,
  };
}
export function validateLiveCandidate(
  record: LiveRecord,
  input: unknown,
): Candidate {
  if (
    !record.eligible_for_extraction ||
    record.attribution !== "direct" ||
    record.contact_ids.length !== 1 ||
    !isRecord(input) ||
    typeof input.quote !== "string" ||
    !record.authored_spans.some((span) => span.text === input.quote)
  )
    throw new Error("direct authored evidence required");
  return validateEvidenceCandidate(
    { ...record, body_text: input.quote },
    input,
    isExplicitCommitment,
  );
}
export class TendStore {
  private db: DatabaseSync;
  private readonly mode: "fixture" | "live";
  private readonly principal: {
    owner_id: string;
    user_id: string;
    chat_id: string;
  };
  private readonly clock: () => Date;
  constructor(path: string, options: StoreOptions = {}) {
    this.mode = options.mode ?? "fixture";
    if (this.mode === "live" && !options.principal)
      throw new Error("live principal required");
    this.principal = options.principal ?? {
      owner_id: "demo-owner",
      user_id: "demo-user",
      chat_id: "demo-private",
    };
    this.clock = options.clock ?? (() => new Date());
    this.db = new DatabaseSync(path);

    this.db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS contacts(owner_id TEXT NOT NULL,contact_id TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(owner_id,contact_id));
 CREATE TABLE IF NOT EXISTS identities(owner_id TEXT NOT NULL,identity TEXT NOT NULL,contact_id TEXT NOT NULL,PRIMARY KEY(owner_id,identity));
 CREATE TABLE IF NOT EXISTS sources(owner_id TEXT NOT NULL,source TEXT NOT NULL,account_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner_id,source));
 CREATE TABLE IF NOT EXISTS interactions(record_key TEXT PRIMARY KEY,owner_id TEXT NOT NULL,source TEXT NOT NULL,account_id TEXT NOT NULL,source_record_id TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(owner_id,source,account_id,source_record_id));
 CREATE TABLE IF NOT EXISTS commitments(commitment_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,record_key TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(owner_id,record_key));
 CREATE TABLE IF NOT EXISTS quarantines(id INTEGER PRIMARY KEY,source TEXT,reason TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS telegram_updates(channel_id TEXT NOT NULL,update_id INTEGER NOT NULL,payload_hash TEXT NOT NULL,reply_data TEXT NOT NULL,status TEXT NOT NULL,telegram_message_id INTEGER,PRIMARY KEY(channel_id,update_id));
 CREATE TABLE IF NOT EXISTS live_quarantines(owner_id TEXT NOT NULL,source TEXT NOT NULL,account_id TEXT NOT NULL,record_id TEXT NOT NULL,reason TEXT NOT NULL,observed_at TEXT NOT NULL,PRIMARY KEY(owner_id,source,account_id,record_id));
 CREATE TABLE IF NOT EXISTS live_sources(owner_id TEXT NOT NULL,source TEXT NOT NULL,account_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner_id,source,account_id));
 CREATE TABLE IF NOT EXISTS live_sync_seen(owner_id TEXT NOT NULL,source TEXT NOT NULL,account_id TEXT NOT NULL,record_id TEXT NOT NULL,PRIMARY KEY(owner_id,source,account_id,record_id));
 CREATE TABLE IF NOT EXISTS live_telegram_updates(owner_id TEXT NOT NULL,channel_id TEXT NOT NULL,update_id INTEGER NOT NULL,payload_hash TEXT NOT NULL,reply_data TEXT NOT NULL,status TEXT NOT NULL,telegram_message_id INTEGER,PRIMARY KEY(owner_id,channel_id,update_id));
 CREATE TABLE IF NOT EXISTS live_extraction_attempts(owner_id TEXT NOT NULL,record_key TEXT NOT NULL,content_hash TEXT NOT NULL,attempted_at TEXT NOT NULL,PRIMARY KEY(owner_id,record_key));`);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS store_metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),mode TEXT NOT NULL,principal_id TEXT NOT NULL)",
    );
    const binding = this.db
      .prepare("SELECT mode,principal_id FROM store_metadata WHERE singleton=1")
      .get();
    const expectedPrincipal =
      this.mode === "live" ? this.principal.owner_id : "";
    const legacyLive =
      Number(this.db.prepare("SELECT COUNT(*) n FROM live_sources").get()?.n) >
      0;
    const legacyFixture =
      Number(this.db.prepare("SELECT COUNT(*) n FROM sources").get()?.n) > 0;
    if (
      (binding &&
        (binding.mode !== this.mode ||
          binding.principal_id !== expectedPrincipal)) ||
      (!binding &&
        ((this.mode === "fixture" && legacyLive) ||
          (this.mode === "live" && legacyFixture)))
    ) {
      this.db.close();
      throw new Error("database mode or principal mismatch");
    }
    this.db
      .prepare("INSERT OR IGNORE INTO store_metadata VALUES(1,?,?)")
      .run(this.mode, expectedPrincipal);
    if (this.mode === "live" && path !== ":memory:") chmodSync(path, 0o600);
  }
  close(): void {
    this.db.close();
  }
  seed(
    contacts: Contact[],
    identities: Identity[],
    states: SourceState[],
  ): void {
    if (
      this.mode === "live" &&
      [...contacts, ...identities, ...states].some(
        (x) => x.owner_id !== this.principal.owner_id,
      )
    )
      throw new Error("unauthorized seed");
    for (const c of contacts)
      this.db
        .prepare("INSERT OR IGNORE INTO contacts VALUES (?,?,?)")
        .run(c.owner_id, c.contact_id, c.name);
    for (const i of identities)
      this.db
        .prepare("INSERT OR IGNORE INTO identities VALUES (?,?,?)")
        .run(i.owner_id, i.identity, i.contact_id);
    for (const s of states)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO ${this.mode === "live" ? "live_sources" : "sources"} VALUES (?,?,?,?)`,
        )
        .run(s.owner_id, s.source, s.account_id, JSON.stringify(s));
  }
  private identities(owner: string): Identity[] {
    this.assertOwner(owner);
    return this.db
      .prepare(
        "SELECT owner_id,identity,contact_id FROM identities WHERE owner_id=?",
      )
      .all(owner) as unknown as Identity[];
  }
  private assertOwner(owner: string): void {
    if (this.mode === "live" && owner !== this.principal.owner_id)
      throw new Error("unauthorized owner");
  }
  private normalizeIncoming(raw: RawRecord): NormalizedRecord {
    if (this.mode === "fixture")
      return normalizeRecord(raw, this.identities(raw.owner_id));
    this.assertOwner(raw.owner_id);
    return normalizeLiveRecord(raw, this.identities(raw.owner_id));
  }
  counts(owner = this.principal.owner_id): {
    interactions: number;
    commitments: number;
  } {
    this.assertOwner(owner);
    return {
      interactions: Number(
        this.db
          .prepare("SELECT count(*) AS n FROM interactions WHERE owner_id=?")
          .get(owner)?.n,
      ),
      commitments: Number(
        this.db
          .prepare("SELECT count(*) AS n FROM commitments WHERE owner_id=?")
          .get(owner)?.n,
      ),
    };
  }
  telegramDeliveryCounts(): { reply_pending: number; sent: number } {
    if (this.mode === "live") {
      const count = (status: string) =>
        Number(
          this.db
            .prepare(
              "SELECT count(*) AS n FROM live_telegram_updates WHERE owner_id=? AND status=?",
            )
            .get(this.principal.owner_id, status)?.n,
        );
      return { reply_pending: count("reply_pending"), sent: count("sent") };
    }
    return {
      reply_pending: Number(
        this.db
          .prepare(
            "SELECT count(*) AS n FROM telegram_updates WHERE status='reply_pending'",
          )
          .get()?.n,
      ),
      sent: Number(
        this.db
          .prepare(
            "SELECT count(*) AS n FROM telegram_updates WHERE status='sent'",
          )
          .get()?.n,
      ),
    };
  }
  ingest(raw: RawRecord | LiveRecord): NormalizedRecord {
    this.db.exec("SAVEPOINT single_ingest");
    try {
      const result = this.writeRecord(raw);
      this.db.exec("RELEASE single_ingest");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK TO single_ingest");
      this.db.exec("RELEASE single_ingest");
      throw e;
    }
  }
  private writeRecord(raw: RawRecord): NormalizedRecord {
    const r = this.normalizeIncoming(raw);
    const state = this.sourceStatus(raw.owner_id).find(
      (s) => s.source === raw.source && s.account_id === raw.account_id,
    );
    if (
      !state ||
      state.account_id !== raw.account_id ||
      (state.mode !== raw.ingestion_mode &&
        !(
          this.mode === "live" &&
          state.mode === "live" &&
          raw.ingestion_mode === "snapshot"
        ))
    )
      throw new Error("unregistered account/mode");
    if (state.status === "revoked") throw new Error("source revoked");
    if (
      this.mode === "live" &&
      state.mode === "snapshot" &&
      raw.source !== "calendar"
    )
      throw new Error("calendar snapshot account required");
    if (
      raw.source === "calendar" &&
      (raw.ingestion_mode === "snapshot") !== (state.mode === "snapshot")
    )
      throw new Error("calendar ingestion mode mismatch");
    const previous = this.db
      .prepare(
        "SELECT json_extract(data,'$.content_hash') AS content_hash FROM interactions WHERE owner_id=? AND record_key=?",
      )
      .get(raw.owner_id, r.record_key);
    if (previous && previous.content_hash !== r.content_hash) {
      for (const candidate of this.commitments(raw.owner_id).filter(
        (candidate) => candidate.record_key === r.record_key,
      ))
        this.put({
          ...candidate,
          status: [
            "done",
            "cancelled",
            ...(this.mode === "live" ? ["confirmed"] : []),
          ].includes(candidate.status)
            ? candidate.status
            : "invalidated",
          evidence_valid: false,
          ...(this.mode === "live"
            ? {
                quote: "",
                action: "",
                suggested_due: null,
                due_date:
                  candidate.status === "confirmed" ? candidate.due_date : null,
              }
            : {}),
        });
      this.scrubReplyCache(raw.owner_id);
    }
    this.db
      .prepare(
        "INSERT INTO interactions VALUES(?,?,?,?,?,?) ON CONFLICT(record_key) DO UPDATE SET data=excluded.data",
      )
      .run(
        r.record_key,
        r.owner_id,
        r.source,
        r.account_id,
        r.source_record_id,
        JSON.stringify(r),
      );
    return r;
  }
  ingestBatch(records: RawRecord[], cursor: string): NormalizedRecord[] {
    this.db.exec("BEGIN");
    try {
      const out = records.map((r) => this.writeRecord(r));
      for (const source of new Set(out.map((r) => r.source))) {
        const owner = out.find((r) => r.source === source)!.owner_id;
        const state = this.sourceStatus(owner).find((s) => s.source === source);
        if (state)
          this.db
            .prepare("UPDATE sources SET data=? WHERE owner_id=? AND source=?")
            .run(JSON.stringify({ ...state, cursor }), owner, source);
      }
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  commitLiveBatch(batch: LiveBatch): NormalizedRecord[] {
    if (this.mode !== "live") throw new Error("live mode required");
    this.assertOwner(batch.owner_id);
    const state = this.sourceStatus(batch.owner_id).find(
      (x) => x.source === batch.source && x.account_id === batch.account_id,
    );
    if (
      !state ||
      !["live", "snapshot"].includes(state.mode) ||
      state.status === "revoked"
    )
      throw new Error("unregistered live account");
    if (
      batch.operation_hash !== undefined &&
      !/^[a-f0-9]{64}$/.test(batch.operation_hash)
    )
      throw new Error("invalid operation hash");
    const batchHash =
      batch.operation_hash ??
      createHash("sha256").update(JSON.stringify(batch)).digest("hex");
    const completion = liveBatchCompletion(state, batch);
    if (state.last_batch_hash === batchHash) return [];
    if (
      batch.expected_cursor !== undefined &&
      state.cursor !== batch.expected_cursor
    )
      throw new Error("stale sync cursor");
    if (
      state.status === "current" ||
      state.coverage_start !== batch.coverage_start ||
      state.coverage_end !== batch.coverage_end
    )
      throw new Error("stale sync window");
    if (
      !exactTimestamp(batch.coverage_start) ||
      !exactTimestamp(batch.coverage_end) ||
      Date.parse(batch.coverage_start) > Date.parse(batch.coverage_end)
    )
      throw new Error("invalid coverage");
    if (
      batch.records.some(
        (x) =>
          x.owner_id !== batch.owner_id ||
          x.source !== batch.source ||
          x.account_id !== batch.account_id,
      )
    )
      throw new Error("batch account mismatch");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.seed(batch.contacts ?? [], batch.identities ?? [], []);
      const out = batch.records.map((record) => this.writeRecord(record));
      for (const record of out)
        this.db
          .prepare(
            "DELETE FROM live_quarantines WHERE owner_id=? AND source=? AND account_id=? AND record_id=?",
          )
          .run(
            batch.owner_id,
            batch.source,
            batch.account_id,
            record.source_record_id,
          );
      for (const q of batch.quarantines ?? [])
        this.db
          .prepare(
            "INSERT INTO live_quarantines VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,source,account_id,record_id) DO UPDATE SET reason=excluded.reason,observed_at=excluded.observed_at",
          )
          .run(
            batch.owner_id,
            batch.source,
            batch.account_id,
            q.source_record_id,
            q.reason,
            q.observed_at,
          );

      for (const id of batch.seen_record_ids)
        this.db
          .prepare("INSERT OR IGNORE INTO live_sync_seen VALUES(?,?,?,?)")
          .run(batch.owner_id, batch.source, batch.account_id, id);
      for (const id of batch.removed_record_ids ?? [])
        this.removeLiveRecord(
          batch.owner_id,
          batch.source,
          batch.account_id,
          id,
        );
      if (completion.complete && batch.reconcile) {
        const seen = new Set(
          this.db
            .prepare(
              "SELECT record_id FROM live_sync_seen WHERE owner_id=? AND source=? AND account_id=?",
            )
            .all(batch.owner_id, batch.source, batch.account_id)
            .map((x) => String(x.record_id)),
        );
        for (const record of this.interactions(batch.owner_id).filter(
          (x) => x.source === batch.source && x.account_id === batch.account_id,
        ))
          if (!seen.has(record.source_record_id))
            this.removeLiveRecord(
              batch.owner_id,
              batch.source,
              batch.account_id,
              record.source_record_id,
            );
      }
      if (batch.complete)
        this.db
          .prepare(
            "DELETE FROM live_sync_seen WHERE owner_id=? AND source=? AND account_id=?",
          )
          .run(batch.owner_id, batch.source, batch.account_id);
      this.db
        .prepare(
          "UPDATE live_sources SET data=? WHERE owner_id=? AND source=? AND account_id=?",
        )
        .run(
          JSON.stringify({
            ...state,
            cursor: batch.cursor,
            status: completion.complete ? "current" : "partial",
            ...completion.flags,
            last_success: completion.complete
              ? this.clock().toISOString()
              : state.last_success,
            coverage_start: batch.coverage_start,
            coverage_end: batch.coverage_end,
            last_batch_hash: batchHash,
            retry_after_until: null,
            attempt_count: 0,
            last_error: null,
          }),
          batch.owner_id,
          batch.source,
          batch.account_id,
        );
      this.pruneLiveContacts(batch.owner_id);
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  prepareLiveSnapshot(
    owner: string,
    source: Source,
    accountId: string,
    start: string,
    end: string,
    resumeCursor?: string,
  ): SourceState {
    this.assertOwner(owner);
    if (
      resumeCursor !== undefined &&
      (source !== "linkedin" ||
        resumeCursor.length > 8192 ||
        !/^li-change:(0|[1-9]\d*)$/.test(resumeCursor))
    )
      throw new Error("invalid live resume cursor");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.sourceStatus(owner).find(
        (x) => x.source === source && x.account_id === accountId,
      );
      if (!state) throw new Error("unknown source");
      if (state.mode === "snapshot") {
        if (
          source !== "calendar" ||
          state.status === "revoked" ||
          resumeCursor !== undefined ||
          !exactTimestamp(start) ||
          !exactTimestamp(end) ||
          Date.parse(start) >= Date.parse(end)
        )
          throw new Error("invalid manual calendar snapshot window");
        const next = {
          ...state,
          coverage_start: start,
          coverage_end: end,
          cursor: null,
          status: "partial",
          last_success: null,
          evidence_incomplete: true,
          pagination_complete: false,
        };
        this.db
          .prepare(
            "UPDATE live_sources SET data=? WHERE owner_id=? AND source=? AND account_id=?",
          )
          .run(JSON.stringify(next), owner, source, accountId);
        this.db.exec("COMMIT");
        return next;
      }
      if (resumeCursor !== undefined) {
        const watermark = Number(resumeCursor.slice("li-change:".length));
        if (
          !Number.isSafeInteger(watermark) ||
          (state.cursor?.startsWith("li-change:")
            ? state.cursor !== resumeCursor
            : state.cursor !== null ||
              !(
                state.status === "current" ||
                (state.status === "partial" &&
                  state.pagination_complete === true)
              ))
        )
          throw new Error("stale or unproven live resume cursor");
      }

      if (
        state.status !== "current" &&
        !(state.status !== "revoked" && state.pagination_complete === true) &&
        resumeCursor === undefined
      ) {
        this.db.exec("COMMIT");
        return state;
      }
      if (state.status === "revoked") throw new Error("source revoked");
      const next = {
        ...state,
        cursor: resumeCursor ?? null,
        status: "partial",
        coverage_start: start,
        coverage_end: end,
        last_batch_hash: "",
        ...(resumeCursor === undefined
          ? resetLiveCompleteness(state)
          : { pagination_complete: false }),
      };
      this.db
        .prepare(
          "DELETE FROM live_sync_seen WHERE owner_id=? AND source=? AND account_id=?",
        )
        .run(owner, source, accountId);
      this.db
        .prepare(
          "UPDATE live_sources SET data=? WHERE owner_id=? AND source=? AND account_id=?",
        )
        .run(JSON.stringify(next), owner, source, accountId);
      this.db.exec("COMMIT");
      return next;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  reconnectLiveSource(
    owner: string,
    source: Source,
    accountId: string,
    start: string,
    end: string,
    requireActive = false,
  ): void {
    this.assertOwner(owner);
    if (this.mode !== "live") throw new Error("live mode required");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.sourceStatus(owner).find(
        (x) => x.source === source && x.account_id === accountId,
      );
      if (!state) throw new Error("unknown source");
      if (requireActive && state.status === "revoked")
        throw new Error("source revoked; active connection required");
      if (
        !exactTimestamp(start) ||
        !exactTimestamp(end) ||
        Date.parse(start) >= Date.parse(end)
      )
        throw new Error("invalid reconnect window");
      this.db
        .prepare(
          "DELETE FROM live_sync_seen WHERE owner_id=? AND source=? AND account_id=?",
        )
        .run(owner, source, accountId);
      this.db
        .prepare(
          "UPDATE live_sources SET data=? WHERE owner_id=? AND source=? AND account_id=?",
        )
        .run(
          JSON.stringify({
            ...state,
            status: "partial",
            cursor: null,
            last_success: null,
            coverage_start: start,
            coverage_end: end,
            last_batch_hash: "",
            ...resetLiveCompleteness(state),
            retry_after_until: null,
            attempt_count: 0,
            last_error: null,
          }),
          owner,
          source,
          accountId,
        );
      this.scrubReplyCache(owner);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  markLiveSyncError(
    owner: string,
    source: Source,
    accountId: string,
    reconnect: boolean,
    retryAfterUntil: string | null = null,
    statusCode: number | null = null,
  ): void {
    this.assertOwner(owner);
    if (reconnect) {
      this.revokeSource(owner, source);
      return;
    }
    const state = this.sourceStatus(owner).find(
      (x) => x.source === source && x.account_id === accountId,
    );
    if (!state) throw new Error("unknown source");
    if (state.status === "revoked")
      throw new Error("source revoked; explicit reconnect required");
    this.db
      .prepare(
        "UPDATE live_sources SET data=? WHERE owner_id=? AND source=? AND account_id=?",
      )
      .run(
        JSON.stringify({
          ...state,
          status: "stale",
          retry_after_until: retryAfterUntil,
          attempt_count: (state.attempt_count ?? 0) + 1,
          last_error: statusCode,
        }),
        owner,
        source,
        accountId,
      );
  }
  private removeLiveRecord(
    owner: string,
    source: Source,
    accountId: string,
    providerId: string,
  ): void {
    this.assertOwner(owner);
    const record = this.db
      .prepare(
        "SELECT record_key FROM interactions WHERE owner_id=? AND source=? AND account_id=? AND source_record_id=?",
      )
      .get(owner, source, accountId, providerId) as
      { record_key: string } | undefined;
    if (!record) return;
    for (const c of this.commitments(owner).filter(
      (x) => x.record_key === record.record_key,
    ))
      this.put({
        ...c,
        status: [
          "done",
          "cancelled",
          ...(this.mode === "live" ? ["confirmed"] : []),
        ].includes(c.status)
          ? c.status
          : "invalidated",
        evidence_valid: false,
        quote: "",
        action: "",
        suggested_due: null,
        due_date: c.status === "confirmed" ? c.due_date : null,
      });
    this.db
      .prepare("DELETE FROM interactions WHERE owner_id=? AND record_key=?")
      .run(owner, record.record_key);
    this.db
      .prepare(
        "DELETE FROM live_extraction_attempts WHERE owner_id=? AND record_key=?",
      )
      .run(owner, record.record_key);
    this.scrubReplyCache(owner);
  }
  expireLiveEvidence(
    owner: string,
    gmailStart: string,
    calendarStart: string,
    calendarEnd: string,
  ): void {
    this.assertOwner(owner);
    if (this.mode !== "live") throw new Error("live mode required");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const records = this.db
        .prepare(
          "SELECT source,account_id,source_record_id,json_extract(data,'$.occurred_at') AS occurred_at,json_extract(data,'$.end_at') AS end_at FROM interactions WHERE owner_id=?",
        )
        .all(owner) as unknown as (Pick<
        NormalizedRecord,
        "source" | "account_id" | "source_record_id" | "occurred_at"
      > & { end_at: string | null })[];
      for (const record of records)
        if (
          (record.source !== "calendar" &&
            Date.parse(record.occurred_at) < Date.parse(gmailStart)) ||
          (record.source === "calendar" &&
            (Date.parse(record.end_at ?? record.occurred_at) <=
              Date.parse(calendarStart) ||
              Date.parse(record.occurred_at) >= Date.parse(calendarEnd)))
        )
          this.removeLiveRecord(
            owner,
            record.source,
            record.account_id,
            record.source_record_id,
          );
      this.db
        .prepare(
          "DELETE FROM live_quarantines WHERE owner_id=? AND observed_at<?",
        )
        .run(owner, gmailStart);
      this.pruneLiveContacts(owner);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private pruneLiveContacts(owner: string): void {
    if (this.mode !== "live") return;
    this.assertOwner(owner);
    const used = new Set(
      this.db
        .prepare(
          "SELECT DISTINCT value AS contact_id FROM interactions,json_each(interactions.data,'$.contact_ids') WHERE owner_id=?",
        )
        .all(owner)
        .map((row) => row.contact_id),
    );
    let changed = false;
    const contacts = this.db
      .prepare("SELECT contact_id FROM contacts WHERE owner_id=?")
      .all(owner) as unknown as Pick<Contact, "contact_id">[];
    for (const contact of contacts) {
      if (contact.contact_id === "OWNER" || used.has(contact.contact_id))
        continue;
      changed = true;
      this.db
        .prepare("DELETE FROM identities WHERE owner_id=? AND contact_id=?")
        .run(owner, contact.contact_id);
      this.db
        .prepare("DELETE FROM contacts WHERE owner_id=? AND contact_id=?")
        .run(owner, contact.contact_id);
    }
    if (changed) this.scrubReplyCache(owner);
  }
  private scrubReplyCache(owner: string): void {
    if (this.mode === "live")
      this.db
        .prepare(
          "UPDATE live_telegram_updates SET reply_data='{}' WHERE owner_id=?",
        )
        .run(owner);
  }
  quarantineCount(owner: string): number {
    this.assertOwner(owner);
    return Number(
      this.db
        .prepare("SELECT COUNT(*) n FROM live_quarantines WHERE owner_id=?")
        .get(owner)?.n,
    );
  }
  cachedReplyText(owner: string): string {
    this.assertOwner(owner);
    return this.db
      .prepare("SELECT reply_data FROM live_telegram_updates WHERE owner_id=?")
      .all(owner)
      .map((x) => String(x.reply_data))
      .join("\n");
  }
  contacts(owner: string, query = ""): (Contact & { emails: string[] })[] {
    this.assertOwner(owner);
    const identities = this.identities(owner);
    const needle = query.toLowerCase();
    return (
      this.db
        .prepare(
          "SELECT owner_id,contact_id,name FROM contacts WHERE owner_id=? ORDER BY name,contact_id",
        )
        .all(owner) as unknown as Contact[]
    )
      .map((contact) => ({
        ...contact,
        emails: identities
          .filter((x) => x.contact_id === contact.contact_id)
          .map((x) => x.identity),
      }))
      .filter(
        (x) =>
          !query ||
          x.name.toLowerCase().includes(needle) ||
          x.contact_id === query ||
          x.emails.some((email) => email.toLowerCase().includes(needle)),
      );
  }
  sourceStatus(owner: string): SourceState[] {
    this.assertOwner(owner);
    return this.db
      .prepare(
        `SELECT data FROM ${this.mode === "live" ? "live_sources" : "sources"} WHERE owner_id=? ORDER BY source,account_id`,
      )
      .all(owner)
      .map((r) => JSON.parse(String(r.data)) as SourceState);
  }
  interactions(owner: string): NormalizedRecord[] {
    this.assertOwner(owner);
    return this.db
      .prepare(
        "SELECT data FROM interactions WHERE owner_id=? ORDER BY source,source_record_id",
      )
      .all(owner)
      .map((r) => JSON.parse(String(r.data)) as NormalizedRecord);
  }
  originalMessageTimes(
    owner: string,
    source: Source,
    accountId: string,
  ): Record<string, string> {
    this.assertOwner(owner);
    const rows = this.db
      .prepare(
        "SELECT source_record_id,json_extract(data,'$.occurred_at') AS occurred_at FROM interactions WHERE owner_id=? AND source=? AND account_id=?",
      )
      .all(owner, source, accountId);
    return Object.fromEntries(
      rows.map((row) => [
        String(row.source_record_id),
        String(row.occurred_at),
      ]),
    );
  }
  extractionAttempted(record: NormalizedRecord): boolean {
    this.assertOwner(record.owner_id);
    const row = this.db
      .prepare(
        "SELECT content_hash FROM live_extraction_attempts WHERE owner_id=? AND record_key=?",
      )
      .get(record.owner_id, record.record_key);
    return row?.content_hash === record.content_hash;
  }
  markExtractionAttempt(
    owner: string,
    recordKey: string,
    expectedHash: string,
  ): void {
    this.assertOwner(owner);
    const record = this.interactions(owner).find(
      (r) => r.record_key === recordKey,
    );
    if (
      this.mode !== "live" ||
      !record ||
      record.content_hash !== expectedHash ||
      eligiblePromiseSpans(record).length === 0
    )
      throw new Error("current eligible authored evidence required");
    this.db
      .prepare(
        "INSERT INTO live_extraction_attempts VALUES(?,?,?,?) ON CONFLICT(owner_id,record_key) DO UPDATE SET content_hash=excluded.content_hash,attempted_at=excluded.attempted_at",
      )
      .run(owner, recordKey, expectedHash, this.clock().toISOString());
  }
  extractionReviewCount(owner: string): number {
    this.assertOwner(owner);
    const candidates = new Set(
      this.commitments(owner).map((c) => c.record_key),
    );
    return this.interactions(owner).filter(
      (r) => this.extractionAttempted(r) && !candidates.has(r.record_key),
    ).length;
  }
  resolveContact(owner: string, query: string): Contact {
    this.assertOwner(owner);
    if (this.mode === "live" && query.includes("@")) {
      const identity = this.identities(owner).find(
        (x) => x.identity === canonicalEmail(query),
      );
      if (!identity || identity.contact_id === "OWNER")
        throw new Error("unknown contact");
      query = identity.contact_id;
    }
    const matches = this.db
      .prepare(
        "SELECT owner_id,contact_id,name FROM contacts WHERE owner_id=? AND (contact_id=? OR name=?)",
      )
      .all(owner, query, query) as unknown as Contact[];
    if (matches.length !== 1)
      throw new Error(
        matches.length > 1 ? "ambiguous contact: use ID" : "unknown contact",
      );
    return matches[0]!;
  }
  addCandidate(raw: RawRecord, input: unknown): Commitment {
    const normalized = this.normalizeIncoming(raw);
    const validated =
      this.mode === "live"
        ? validateLiveCandidate(raw as LiveRecord, input)
        : validateCandidate(raw, input);
    const stored = this.interactions(raw.owner_id).find(
      (r) => r.record_key === normalized.record_key,
    );
    if (!stored || stored.content_hash !== normalized.content_hash)
      throw new Error("evidence not persisted/current");
    const id = "C" + normalized.record_key.slice(0, 12);
    const existing = this.db
      .prepare(
        "SELECT data FROM commitments WHERE commitment_id=? AND owner_id=?",
      )
      .get(id, raw.owner_id);
    if (existing) {
      const current = JSON.parse(String(existing.data)) as Commitment;
      if (this.mode === "live" && current.status === "invalidated") {
        const proposed: Commitment = {
          ...current,
          ...validated,
          contact_id: normalized.contact_id,
          direction: raw.direction === "sent" ? "owed_by_me" : "owed_to_me",
          status: "pending",
          due_date: null,
          evidence_valid: true,
        };
        this.put(proposed);
        return proposed;
      }
      if (current.status === "confirmed" && current.evidence_valid === false)
        return current;
      if (current.evidence_valid === false || current.status === "invalidated")
        throw new Error(
          "invalidated candidate requires external owner review; automatic reinstatement unsupported",
        );
      return current;
    }
    const c: Commitment = {
      ...validated,
      commitment_id: id,
      owner_id: raw.owner_id,
      contact_id: normalized.contact_id,
      source: raw.source,
      record_key: normalized.record_key,
      direction: raw.direction === "sent" ? "owed_by_me" : "owed_to_me",
      status: "pending",
      due_date: null,
      evidence_valid: true,
    };
    this.db
      .prepare("INSERT INTO commitments VALUES(?,?,?,?)")
      .run(id, c.owner_id, c.record_key, JSON.stringify(c));
    return c;
  }
  commitments(owner: string): Commitment[] {
    this.assertOwner(owner);
    return this.db
      .prepare("SELECT data FROM commitments WHERE owner_id=?")
      .all(owner)
      .map((r) => JSON.parse(String(r.data)) as Commitment);
  }
  private put(c: Commitment): void {
    this.db
      .prepare(
        "UPDATE commitments SET data=? WHERE commitment_id=? AND owner_id=?",
      )
      .run(JSON.stringify(c), c.commitment_id, c.owner_id);
  }
  revokeSource(owner: string, source: Source): void {
    this.assertOwner(owner);
    this.db.exec("SAVEPOINT revoke_source");
    try {
      for (const state of this.sourceStatus(owner).filter(
        (s) => s.source === source,
      ))
        this.db
          .prepare(
            `UPDATE ${this.mode === "live" ? "live_sources" : "sources"} SET data=? WHERE owner_id=? AND source=? AND account_id=?`,
          )
          .run(
            JSON.stringify({ ...state, status: "revoked" }),
            owner,
            source,
            state.account_id,
          );
      for (const c of this.commitments(owner).filter(
        (c) => c.source === source,
      ))
        this.put({
          ...c,
          status: [
            "done",
            "cancelled",
            ...(this.mode === "live" ? ["confirmed"] : []),
          ].includes(c.status)
            ? c.status
            : "invalidated",
          evidence_valid: false,
          quote: "",
          action: "",
          suggested_due: null,
          due_date:
            this.mode === "live" && c.status === "confirmed"
              ? c.due_date
              : null,
        });
      this.db
        .prepare(
          "DELETE FROM live_extraction_attempts WHERE owner_id=? AND record_key IN (SELECT record_key FROM interactions WHERE owner_id=? AND source=?)",
        )
        .run(owner, owner, source);
      this.db
        .prepare("DELETE FROM interactions WHERE owner_id=? AND source=?")
        .run(owner, source);
      this.scrubReplyCache(owner);
      this.pruneLiveContacts(owner);
      if (this.mode === "live")
        this.db
          .prepare("DELETE FROM live_quarantines WHERE owner_id=? AND source=?")
          .run(owner, source);
      if (this.mode === "live")
        this.db
          .prepare("DELETE FROM live_sync_seen WHERE owner_id=? AND source=?")
          .run(owner, source);
      this.db.exec("RELEASE revoke_source");
    } catch (error) {
      this.db.exec("ROLLBACK TO revoke_source; RELEASE revoke_source");
      throw error;
    }
  }
  command(auth: AuthCommand): Reply {
    this.authorizeCommand(auth);
    return this.executeCommand(auth);
  }
  private authorizeCommand(auth: AuthCommand): void {
    if (
      auth.owner_id !== this.principal.owner_id ||
      auth.user_id !== this.principal.user_id ||
      auth.chat_id !== this.principal.chat_id ||
      auth.chat_type !== "private"
    )
      throw new Error("unauthorized");
  }
  telegramCommand(
    auth: AuthCommand,
    channelId: string,
    updateId: number,
  ): { accepted: boolean; reply?: Reply } {
    this.authorizeCommand(auth);
    this.validateTelegramKey(channelId, updateId);
    const hash = createHash("sha256").update(auth.text).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db
        .prepare(
          `SELECT payload_hash FROM ${this.mode === "live" ? "live_telegram_updates" : "telegram_updates"} WHERE channel_id=? AND update_id=?${this.mode === "live" ? " AND owner_id=?" : ""}`,
        )
        .get(
          ...(this.mode === "live"
            ? [channelId, updateId, auth.owner_id]
            : [channelId, updateId]),
        );
      if (prior) {
        this.db.exec("COMMIT");
        return { accepted: false };
      }
      let reply: Reply;
      try {
        reply = this.executeCommand(auth);
      } catch {
        reply = {
          outbound_sent: false,
          error: "Command failed. Use /help for examples.",
        };
      }
      if (this.mode === "live")
        this.db
          .prepare(
            "INSERT INTO live_telegram_updates(owner_id,channel_id,update_id,payload_hash,reply_data,status) VALUES(?,?,?,?,?,?)",
          )
          .run(
            auth.owner_id,
            channelId,
            updateId,
            hash,
            JSON.stringify(reply),
            "reply_pending",
          );
      else
        this.db
          .prepare(
            "INSERT INTO telegram_updates(channel_id,update_id,payload_hash,reply_data,status) VALUES(?,?,?,?,?)",
          )
          .run(
            channelId,
            updateId,
            hash,
            JSON.stringify(reply),
            "reply_pending",
          );
      this.db.exec("COMMIT");
      return { accepted: true, reply };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  commitTelegramReply(
    auth: AuthCommand,
    channelId: string,
    updateId: number,
    prepared: PreparedTelegramRead,
    signal?: AbortSignal,
  ): { accepted: boolean; reply?: Reply } {
    signal?.throwIfAborted();
    this.authorizeCommand(auth);
    this.validateTelegramKey(channelId, updateId);
    if (this.mode !== "live") throw new Error("live mode required");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db
        .prepare(
          "SELECT 1 FROM live_telegram_updates WHERE owner_id=? AND channel_id=? AND update_id=?",
        )
        .get(auth.owner_id, channelId, updateId);
      if (prior) {
        this.db.exec("COMMIT");
        return { accepted: false };
      }
      const reply = validatePreparedTelegramReply(
        auth.owner_id,
        prepared,
        this.interactions(auth.owner_id),
        this.contacts(auth.owner_id),
        this.commitments(auth.owner_id),
        this.sourceStatus(auth.owner_id),
        this.clock(),
      );
      signal?.throwIfAborted();
      this.db
        .prepare(
          "INSERT INTO live_telegram_updates(owner_id,channel_id,update_id,payload_hash,reply_data,status) VALUES(?,?,?,?,?,?)",
        )
        .run(
          auth.owner_id,
          channelId,
          updateId,
          createHash("sha256").update(auth.text).digest("hex"),
          JSON.stringify(reply),
          "reply_pending",
        );
      signal?.throwIfAborted();
      this.db.exec("COMMIT");
      return { accepted: true, reply };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  pendingTelegramReply(
    owner: string,
    channelId: string,
    updateId: number,
  ): { channel_id: string; update_id: number; reply: Reply } | null {
    if (this.mode !== "live") throw new Error("live mode required");
    this.assertOwner(owner);
    this.validateTelegramKey(channelId, updateId);
    const row = this.db
      .prepare(
        "SELECT status,reply_data FROM live_telegram_updates WHERE owner_id=? AND channel_id=? AND update_id=?",
      )
      .get(owner, channelId, updateId);
    if (!row || row.status !== "reply_pending") return null;
    const reply: unknown = JSON.parse(String(row.reply_data));
    if (!isRecord(reply) || reply.outbound_sent !== false) return null;
    return {
      channel_id: channelId,
      update_id: updateId,
      reply: { ...reply, outbound_sent: false },
    };
  }
  acknowledgeTelegramReply(
    auth: AuthCommand,
    channelId: string,
    updateId: number,
    messageId: number,
  ): void {
    this.authorizeCommand(auth);
    this.validateTelegramKey(channelId, updateId);
    if (!Number.isSafeInteger(messageId) || messageId <= 0)
      throw new Error("invalid Telegram message ID");
    const result = this.db
      .prepare(
        `UPDATE ${this.mode === "live" ? "live_telegram_updates" : "telegram_updates"} SET status='sent',telegram_message_id=?${this.mode === "live" ? ",reply_data='{}'" : ""} WHERE channel_id=? AND update_id=?${this.mode === "live" ? " AND owner_id=?" : ""}`,
      )
      .run(
        ...(this.mode === "live"
          ? [messageId, channelId, updateId, auth.owner_id]
          : [messageId, channelId, updateId]),
      );
    if (result.changes !== 1) throw new Error("unknown Telegram update");
  }
  private validateTelegramKey(channelId: string, updateId: number): void {
    if (
      !/^[a-z0-9-]{1,80}$/.test(channelId) ||
      !Number.isSafeInteger(updateId) ||
      updateId < 0
    )
      throw new Error("invalid Telegram update key");
  }
  private executeCommand(auth: AuthCommand): Reply {
    const tokens = auth.text.trim().split(/\s+/);
    const [cmd, id, date, ...extra] = tokens;
    const expectedArgs =
      cmd === "/confirm"
        ? 3
        : ["/draft", "/done", "/cancel"].includes(cmd ?? "")
          ? 2
          : 1;
    if (
      !["/prep", "/contacts"].includes(cmd ?? "") &&
      tokens.length !== expectedArgs
    )
      throw new Error("invalid command arguments");
    if (!["/prep", "/contacts"].includes(cmd ?? "") && extra.length)
      throw new Error("invalid command arguments");
    const owner = auth.owner_id;
    const mode =
      this.mode === "live" ? "PRIVATE LIVE GOOGLE" : "FICTIONAL LOCAL DEMO";
    if (cmd === "/contacts") {
      const found = this.contacts(owner, tokens.slice(1).join(" "));
      return {
        outbound_sent: false,
        mode,
        contacts: found.slice(0, 50),
        contacts_total: found.length,
        lookup_note:
          found.length > 50
            ? "Showing first 50 matches; narrow the query or use /prep with exact email."
            : "Names never merge identities.",
      };
    }
    if (cmd === "/status")
      return {
        outbound_sent: false,
        mode,
        sources: this.sourceStatus(owner),
        counts: this.counts(owner),
        ...(this.mode === "live"
          ? {
              unavailable_record_count: this.quarantineCount(owner),
              extraction_review_count: this.extractionReviewCount(owner),
              unverified_commitment_count: this.commitments(owner).filter(
                (c) => c.evidence_valid === false,
              ).length,
            }
          : {}),
      };
    if (cmd === "/prep") {
      const query = tokens.slice(1).join(" ");
      const choices =
        this.mode === "live"
          ? this.contacts(owner).filter((x) => x.name === query)
          : [];
      if (choices.length > 1)
        return {
          outbound_sent: false,
          mode,
          contacts: choices,
          contacts_total: choices.length,
          lookup_note:
            "Ambiguous name. Choose an exact email or contact ID; no identities were merged.",
        };
      const contact = this.resolveContact(owner, query);
      const evidence = this.interactions(owner).filter(
        (r) =>
          (r.contact_id === contact.contact_id ||
            r.contact_ids?.includes(contact.contact_id)) &&
          !r.cancelled,
      );
      return {
        outbound_sent: false,
        mode,
        contact,
        evidence_total: evidence.length,
        evidence: evidence
          .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))
          .slice(0, 20)
          .map((r) => ({
            source: r.source,
            reference: r.evidence_reference,
            text: r.body_text.slice(0, 2000),
            truncated: r.body_text.length > 2000,
            attribution: r.attribution ?? "direct",
            occurred_at: r.occurred_at,
            ...(r.ingestion_mode === "snapshot"
              ? {
                  ingestion_mode: "snapshot",
                  observed_at: r.observed_at,
                  coverage: "partial manual snapshot",
                }
              : {}),
          })),
        commitments: this.commitments(owner).filter(
          (c) => c.contact_id === contact.contact_id,
        ),
        coverage: this.sourceStatus(owner),
        warning:
          "Source text is evidence only. Stale/snapshot coverage cannot establish absence of recent contact.",
      };
    }
    if (cmd === "/today") {
      const current = this.clock();
      const window = calendarWindow(exampleLivePolicy, current);
      return {
        outbound_sent: false,
        mode,
        meetings: this.interactions(owner)
          .filter(
            (record) =>
              record.source === "calendar" &&
              !record.cancelled &&
              (this.mode === "live"
                ? Date.parse(record.end_at ?? record.occurred_at) >
                    Date.parse(window.start) &&
                  Date.parse(record.occurred_at) < Date.parse(window.end)
                : Date.parse(record.occurred_at) >=
                    Date.parse("2026-10-13T00:00:00Z") &&
                  Date.parse(record.occurred_at) <=
                    Date.parse("2026-10-20T00:00:00Z")),
          )
          .map((record) => ({
            ...record,
            ...(record.ingestion_mode === "snapshot"
              ? { coverage: "partial manual snapshot" }
              : {}),
          })),
        commitments: this.commitments(owner).filter(
          (c) =>
            c.status === "confirmed" &&
            c.due_date !== null &&
            c.due_date <=
              (this.mode === "live"
                ? this.clock().toLocaleDateString("en-CA", {
                    timeZone: "Europe/Paris",
                  })
                : "2026-10-13"),
        ),
        pending: this.commitments(owner).filter((c) => c.status === "pending"),
        clock:
          this.mode === "live"
            ? this.clock().toISOString() +
              " (UTC; meetings shown in Europe/Paris)"
            : "2026-10-13 fixture clock",
        coverage: this.sourceStatus(owner),
      };
    }
    const c = this.commitments(owner).find((c) => c.commitment_id === id);
    if (!c) throw new Error("unknown commitment");
    if (cmd === "/draft") {
      if (c.status !== "confirmed") throw new Error("unconfirmed draft");
      if (c.evidence_valid === false)
        throw new Error("Evidence review required");
      return {
        outbound_sent: false,
        preview:
          c.direction === "owed_by_me"
            ? `Review-only draft: Update on my promise "${c.quote}". [Add my actual progress before sending]`
            : `Review-only draft: Following up on "${c.quote}". Could you confirm progress?`,
        evidence: c.record_key,
      };
    }
    if (cmd === "/confirm") {
      if (this.mode === "live" && c.evidence_valid === false)
        throw new Error("invalid transition: evidence review required");
      if (!date || !exactTimestamp(`${date}T00:00:00Z`))
        throw new Error("explicit valid date required");
      if (c.status === "confirmed" && c.due_date === date)
        return { outbound_sent: false, ...c };
      if (c.status !== "pending") throw new Error("invalid transition");
      const next = { ...c, status: "confirmed", due_date: date };
      this.put(next);
      return { outbound_sent: false, ...next };
    }
    const target =
      cmd === "/done" ? "done" : cmd === "/cancel" ? "cancelled" : null;
    if (!target) throw new Error("unsupported command");
    if (c.status === target) return { outbound_sent: false, ...c };
    if (c.status !== "confirmed") throw new Error("invalid transition");
    const next = { ...c, status: target };
    this.put(next);
    return { outbound_sent: false, ...next };
  }
}
