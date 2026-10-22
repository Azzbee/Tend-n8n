import type {
  Commitment,
  Contact,
  NormalizedRecord,
  Source,
  SourceState,
} from "./engine.ts";
import { isInstructionLike } from "./instruction-like.ts";

export interface DeskItem {
  commitment_id: string;
  contact_id: string;
  contact_name: string;
  direction: Commitment["direction"];
  status: string;
  quote: string;
  action: string;
  due_date: string | null;
  suggested_due: string | null;
  source: Source;
  record_id: string;
  occurred_at: string | null;
  evidence_valid: boolean;
}
export interface DeskRecordLine {
  record_id: string;
  source: Source;
  occurred_at: string;
  contact_name: string;
  direction: string;
  text: string;
  reason: string;
}
export interface DeskMeeting {
  record_id: string;
  title: string;
  starts_at: string;
  contact_id: string;
  contact_name: string;
  open: DeskItem[];
  last_message: DeskRecordLine | null;
}
export interface DeskStage {
  id: string;
  label: string;
  detail: string;
  state: "ok" | "waiting" | "attention" | "unknown";
}
export interface DeskFailure {
  workflow: string;
  node: string;
  message: string;
  execution_id: string;
}
export interface DeskWorkflowRun {
  id: string;
  name: string;
  lane: "classroom" | "private";
  last_status: "success" | "error" | "running" | "unknown";
  last_run_at: string | null;
}
export interface DeskSnapshot {
  generated_at: string;
  you_owe: DeskItem[];
  owed_to_you: DeskItem[];
  pending: DeskItem[];
  not_promises: DeskRecordLine[];
  not_promises_total: number;
  held_back: DeskRecordLine[];
  held_back_total: number;
  next_meeting: DeskMeeting | null;
  coverage: { source: Source; count: number }[];
  pipeline: DeskStage[];
}
export interface DeskRuns {
  workflows: DeskWorkflowRun[];
  failures: DeskFailure[];
  failure_log_connected: boolean;
  runs_connected: boolean;
}
export const outreachChannels = [
  "email",
  "whatsapp_personal",
  "whatsapp_business",
  "linkedin",
] as const;
export const outreachReasons = [
  "overdue_owed_to_you",
  "you_owe_soon",
  "after_meeting",
  "reply_waiting",
] as const;
export const outreachStatuses = [
  "pending",
  "approved",
  "skipped",
  "gmail_draft_created",
  "expired",
] as const;
export interface OutreachItem {
  id: string;
  contact_id: string;
  contact_name: string;
  channel: (typeof outreachChannels)[number];
  reason: (typeof outreachReasons)[number];
  draft_text: string;
  // First 8 hex characters of the draft's SHA-256; approval must echo it.
  text_code: string;
  evidence: { source: string; text: string; reference: string }[];
  status: (typeof outreachStatuses)[number];
  expires_at: string;
  deep_link?: string | null;
  recipient?: string;
}
// Implemented by the outreach service (improve/outreach) and injected by live-api.ts.
export interface DeskOutreachBackend {
  list(): Promise<{ items: OutreachItem[]; sending_enabled?: boolean }>;
  approve(id: string, seen: string): Promise<unknown>;
  edit(id: string, text: string): Promise<unknown>;
  skip(id: string): Promise<unknown>;
}

const LIST_LIMIT = 10;
const TEXT_LIMIT = 280;
const closed = new Set(["done", "cancelled", "dismissed", "invalidated"]);
// Display-only here: the same filter the planner uses to hold messages back.
export const instructionLike = isInstructionLike;
const clip = (text: string): string =>
  text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT - 1) + "…" : text;
const isDate = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value + "T00:00:00Z"));
export function confirmDefaultDate(item: Pick<DeskItem, "suggested_due">) {
  return isDate(item.suggested_due) ? item.suggested_due : "";
}

export function buildDeskSnapshot(input: {
  commitments: Commitment[];
  records: NormalizedRecord[];
  contacts: Pick<Contact, "contact_id" | "name">[];
  sources: SourceState[];
  now: Date;
  failures: DeskFailure[] | null;
}): DeskSnapshot {
  const revoked = new Set(
    input.sources
      .filter((s) => s.status === "revoked")
      .map((s) => `${s.source}\u0000${s.account_id}`),
  );
  const records = input.records.filter(
    (r) => !r.cancelled && !revoked.has(`${r.source}\u0000${r.account_id}`),
  );
  const byKey = new Map(records.map((r) => [r.record_key, r]));
  const names = new Map(input.contacts.map((c) => [c.contact_id, c.name]));
  const name = (id: string): string => names.get(id) ?? id;
  const item = (c: Commitment): DeskItem => {
    const record = byKey.get(c.record_key);
    return {
      commitment_id: c.commitment_id,
      contact_id: c.contact_id,
      contact_name: name(c.contact_id),
      direction: c.direction,
      status: c.status,
      quote: c.quote,
      action: c.action,
      due_date: c.due_date,
      suggested_due: c.suggested_due,
      source: c.source,
      record_id: record?.source_record_id ?? c.record_key,
      occurred_at: record?.occurred_at ?? null,
      evidence_valid: c.evidence_valid !== false,
    };
  };
  const byDue = (a: DeskItem, b: DeskItem): number =>
    (a.due_date ?? a.suggested_due ?? "9999").localeCompare(
      b.due_date ?? b.suggested_due ?? "9999",
    ) || a.commitment_id.localeCompare(b.commitment_id);
  const time = (value: string): number => Date.parse(value) || 0;
  const recent = (a: NormalizedRecord, b: NormalizedRecord): number =>
    time(b.occurred_at) - time(a.occurred_at) ||
    a.record_key.localeCompare(b.record_key);
  const messages = records.filter((r) => r.source !== "calendar").sort(recent);
  const held = messages.filter((r) => instructionLike(r.body_text));
  const heldKeys = new Set(held.map((r) => r.record_key));
  // A candidate on instruction-like text is never shown as a promise, whatever the extractor did.
  const open = input.commitments.filter(
    (c) => !closed.has(c.status) && !heldKeys.has(c.record_key),
  );
  const confirmed = open.filter((c) => c.status === "confirmed").map(item);
  const pending = open
    .filter((c) => c.status === "pending")
    .map(item)
    .sort(byDue);
  const linked = new Map(input.commitments.map((c) => [c.record_key, c]));
  const line = (r: NormalizedRecord, reason: string): DeskRecordLine => ({
    record_id: r.source_record_id,
    source: r.source,
    occurred_at: r.occurred_at,
    contact_name: name(r.contact_id),
    direction: r.direction,
    text: clip(r.authored_text ?? r.body_text),
    reason,
  });
  const notPromises = messages.filter((r) => {
    const c = linked.get(r.record_key);
    return !heldKeys.has(r.record_key) && (!c || c.status === "dismissed");
  });
  const reasonFor = (r: NormalizedRecord): string =>
    linked.get(r.record_key)?.status === "dismissed"
      ? "You marked it: not a promise"
      : /\?\s*$/.test(r.body_text)
        ? "A question, nothing owed"
        : "No promise found";
  const nowIso = input.now.toISOString();
  const meeting = records
    .filter(
      (r) =>
        r.source === "calendar" && time(r.occurred_at) >= input.now.getTime(),
    )
    .sort((a, b) => time(a.occurred_at) - time(b.occurred_at))[0];
  const meetingContacts = meeting
    ? new Set([meeting.contact_id, ...(meeting.contact_ids ?? [])])
    : new Set<string>();
  const lastMessage = meeting
    ? messages.find(
        (r) =>
          !heldKeys.has(r.record_key) &&
          r.direction === "received" &&
          meetingContacts.has(r.contact_id),
      )
    : undefined;
  const counts = new Map<Source, number>();
  for (const r of records)
    counts.set(r.source, (counts.get(r.source) ?? 0) + 1);
  const failures = input.failures;
  return {
    generated_at: nowIso,
    you_owe: confirmed.filter((c) => c.direction === "owed_by_me").sort(byDue),
    owed_to_you: confirmed
      .filter((c) => c.direction === "owed_to_me")
      .sort(byDue),
    pending,
    not_promises: notPromises
      .slice(0, LIST_LIMIT)
      .map((r) => line(r, reasonFor(r))),
    not_promises_total: notPromises.length,
    held_back: held
      .slice(0, LIST_LIMIT)
      .map((r) => line(r, "Instruction-like text, kept as data only")),
    held_back_total: held.length,
    next_meeting: meeting
      ? {
          record_id: meeting.source_record_id,
          title: clip(meeting.body_text),
          starts_at: meeting.occurred_at,
          contact_id: meeting.contact_id,
          contact_name: name(meeting.contact_id),
          open: [...confirmed, ...pending]
            .filter((c) => meetingContacts.has(c.contact_id))
            .sort(byDue),
          last_message: lastMessage
            ? line(lastMessage, "Last message from them")
            : null,
        }
      : null,
    coverage: [...counts]
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => a.source.localeCompare(b.source)),
    pipeline: [
      {
        id: "sources",
        label: "01–05 · SOURCES",
        detail: `${counts.size} sources · ${records.length} records`,
        state: records.length ? "ok" : "unknown",
      },
      {
        id: "store",
        label: "06 · STORE",
        detail: "Normalized, one ledger",
        state: "ok",
      },
      {
        id: "ai",
        label: "07 · LOCAL AI",
        detail: `${input.commitments.length} candidates · exact quotes only`,
        state: "ok",
      },
      {
        id: "review",
        label: "YOU · REVIEW",
        detail: pending.length
          ? `${pending.length} waiting for your yes`
          : "Review clear",
        state: pending.length ? "waiting" : "ok",
      },
      {
        id: "telegram",
        label: "08 / 10 · TELEGRAM",
        detail: "/today /prep /confirm",
        state: "ok",
      },
      {
        id: "errors",
        label: "21 / 22 · ERROR HANDLERS",
        detail:
          failures === null
            ? "Failure log not connected"
            : `${failures.length} ${failures.length === 1 ? "failure" : "failures"} logged`,
        state:
          failures === null ? "unknown" : failures.length ? "attention" : "ok",
      },
    ],
  };
}

export const workflowCatalog: [string, string, DeskWorkflowRun["lane"]][] = [
  ["01", "Gmail adapter (fictional)", "classroom"],
  ["02", "Calendar adapter (fictional)", "classroom"],
  ["03", "WhatsApp personal adapter (fictional)", "classroom"],
  ["04", "WhatsApp business adapter (fictional)", "classroom"],
  ["05", "LinkedIn adapter (fictional)", "classroom"],
  ["06", "Normalize and store (sub-workflow)", "classroom"],
  ["07", "Extract commitments, local AI, pending only", "classroom"],
  ["08", "Assistant router and briefing", "classroom"],
  ["09", "Bounded retry fixture (synthetic 429)", "classroom"],
  ["21", "Error handler, names only", "classroom"],
  ["23", "Outreach planner (fictional)", "classroom"],
  ["24", "Approved outreach to mock Gmail drafts", "classroom"],
  ["10", "Private Telegram control", "private"],
  ["11", "Read-only Gmail sync", "private"],
  ["12", "Read-only Calendar sync", "private"],
  ["13", "Google normalize and store (sub-workflow)", "private"],
  ["14", "Google owner control", "private"],
  ["15", "Local AI on new Google evidence", "private"],
  ["16", "Cited briefing or review draft", "private"],
  ["17", "WhatsApp personal read page", "private"],
  ["18", "LinkedIn read page", "private"],
  ["19", "WhatsApp business read page", "private"],
  ["20", "Daily owner briefing, 09:00 Paris", "private"],
  ["22", "Error handler, guard messages only", "private"],
  ["25", "Outreach planner, inactive template", "private"],
  ["26", "Approved outreach to Gmail drafts, inactive template", "private"],
];
export function buildDeskRuns(
  runs: DeskWorkflowRun[] | null,
  failures: DeskFailure[] | null,
): DeskRuns {
  const statuses = ["success", "error", "running", "unknown"];
  const reported = new Map(
    (runs ?? []).map((r) => [
      r.id,
      {
        ...r,
        last_status: statuses.includes(r.last_status)
          ? r.last_status
          : ("unknown" as const),
      },
    ]),
  );
  const workflows: DeskWorkflowRun[] = workflowCatalog.map(
    ([id, name, lane]) => ({
      id,
      name,
      lane,
      last_status: reported.get(id)?.last_status ?? "unknown",
      last_run_at: reported.get(id)?.last_run_at ?? null,
    }),
  );
  for (const run of reported.values())
    if (!workflowCatalog.some(([id]) => id === run.id))
      workflows.push({
        id: String(run.id).slice(0, 8),
        name: String(run.name).slice(0, 120),
        lane: run.lane === "classroom" ? "classroom" : "private",
        last_status: statuses.includes(run.last_status)
          ? run.last_status
          : "unknown",
        last_run_at:
          typeof run.last_run_at === "string" ? run.last_run_at : null,
      });
  return {
    workflows,
    failures: (failures ?? []).slice(-50).map((f) => ({
      workflow: String(f.workflow).slice(0, 120),
      node: String(f.node).slice(0, 120),
      message: String(f.message).slice(0, 200),
      execution_id: String(f.execution_id).slice(0, 40),
    })),
    failure_log_connected: failures !== null,
    runs_connected: runs !== null,
  };
}

const plain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);
// Drops malformed outreach items instead of rendering partial data.
export function parseOutreachList(value: unknown): OutreachItem[] {
  if (!plain(value) || !Array.isArray(value.items)) return [];
  const items: OutreachItem[] = [];
  for (const raw of value.items) {
    if (
      !plain(raw) ||
      typeof raw.id !== "string" ||
      typeof raw.contact_id !== "string" ||
      typeof raw.contact_name !== "string" ||
      typeof raw.draft_text !== "string" ||
      typeof raw.text_code !== "string" ||
      typeof raw.expires_at !== "string" ||
      !oneOf(outreachChannels, raw.channel) ||
      !oneOf(outreachReasons, raw.reason) ||
      !oneOf(outreachStatuses, raw.status) ||
      !Array.isArray(raw.evidence)
    )
      continue;
    const evidence = raw.evidence.filter(
      (e): e is OutreachItem["evidence"][number] =>
        plain(e) &&
        typeof e.source === "string" &&
        typeof e.text === "string" &&
        typeof e.reference === "string",
    );
    items.push({
      id: raw.id,
      contact_id: raw.contact_id,
      contact_name: raw.contact_name,
      channel: raw.channel,
      reason: raw.reason,
      draft_text: raw.draft_text,
      text_code: raw.text_code,
      evidence: evidence.map(({ source, text, reference }) => ({
        source,
        text,
        reference,
      })),
      status: raw.status,
      expires_at: raw.expires_at,
      ...(typeof raw.deep_link === "string" || raw.deep_link === null
        ? { deep_link: raw.deep_link }
        : {}),
      ...(typeof raw.recipient === "string"
        ? { recipient: raw.recipient }
        : {}),
    });
  }
  return items;
}
// true or false when the outreach service reports its kill switch; null when it does not say.
export function outreachSending(value: unknown): boolean | null {
  return plain(value) && typeof value.sending_enabled === "boolean"
    ? value.sending_enabled
    : null;
}
export const outreachReasonLabels: Record<OutreachItem["reason"], string> = {
  overdue_owed_to_you: "Nudge: something owed to you is overdue",
  you_owe_soon: "Status update: you owe something soon",
  after_meeting: "Follow-up after a meeting",
  reply_waiting: "Reply: a thread is waiting on you",
};
export function outreachActionable(item: OutreachItem, now: Date): boolean {
  return (
    item.status === "pending" && Date.parse(item.expires_at) > now.getTime()
  );
}
export function reviewPosition(
  total: number,
  index: number,
): { index: number; label: string; prev: boolean; next: boolean } {
  if (total <= 0)
    return { index: 0, label: "0 left", prev: false, next: false };
  const i = Math.min(Math.max(0, index), total - 1);
  return {
    index: i,
    label: `${i + 1} of ${total}`,
    prev: i > 0,
    next: i < total - 1,
  };
}
const numberWords = [
  "No",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
];
const count = (n: number): string => numberWords[n] ?? String(n);
export function deskHeadline(
  desk: Pick<DeskSnapshot, "you_owe" | "owed_to_you" | "pending">,
): string {
  const open = desk.you_owe.length + desk.owed_to_you.length,
    waiting = desk.pending.length;
  return (
    `${count(open)} ${open === 1 ? "promise" : "promises"} in motion. ` +
    (waiting
      ? `${count(waiting)} ${waiting === 1 ? "waits" : "wait"} for your yes.`
      : "Your review is clear.")
  );
}
export function deskItemTitle(
  item: Pick<DeskItem, "direction" | "contact_name" | "action">,
): string {
  const action = item.action.charAt(0).toUpperCase() + item.action.slice(1);
  return item.direction === "owed_by_me"
    ? `You: ${action}`
    : `${item.contact_name}: ${action}`;
}
