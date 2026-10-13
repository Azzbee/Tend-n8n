import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
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
  if (!/^I (?:will|promise to)\b/i.test(input.quote))
    throw new Error("not explicit promise");
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
export class TendStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS contacts(owner_id TEXT NOT NULL,contact_id TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(owner_id,contact_id));
 CREATE TABLE IF NOT EXISTS identities(owner_id TEXT NOT NULL,identity TEXT NOT NULL,contact_id TEXT NOT NULL,PRIMARY KEY(owner_id,identity));
 CREATE TABLE IF NOT EXISTS sources(owner_id TEXT NOT NULL,source TEXT NOT NULL,account_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner_id,source));
 CREATE TABLE IF NOT EXISTS interactions(record_key TEXT PRIMARY KEY,owner_id TEXT NOT NULL,source TEXT NOT NULL,account_id TEXT NOT NULL,source_record_id TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(owner_id,source,account_id,source_record_id));
 CREATE TABLE IF NOT EXISTS commitments(commitment_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,record_key TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(owner_id,record_key));
 CREATE TABLE IF NOT EXISTS quarantines(id INTEGER PRIMARY KEY,source TEXT,reason TEXT NOT NULL);`);
  }
  close(): void {
    this.db.close();
  }
  seed(
    contacts: Contact[],
    identities: Identity[],
    states: SourceState[],
  ): void {
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
        .prepare("INSERT OR IGNORE INTO sources VALUES (?,?,?,?)")
        .run(s.owner_id, s.source, s.account_id, JSON.stringify(s));
  }
  private identities(owner: string): Identity[] {
    return this.db
      .prepare(
        "SELECT owner_id,identity,contact_id FROM identities WHERE owner_id=?",
      )
      .all(owner) as unknown as Identity[];
  }
  counts(): { interactions: number; commitments: number } {
    return {
      interactions: Number(
        this.db.prepare("SELECT count(*) AS n FROM interactions").get()?.n,
      ),
      commitments: Number(
        this.db.prepare("SELECT count(*) AS n FROM commitments").get()?.n,
      ),
    };
  }
  ingest(raw: RawRecord): NormalizedRecord {
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
    const r = normalizeRecord(raw, this.identities(raw.owner_id));
    const state = this.sourceStatus(raw.owner_id).find(
      (s) => s.source === raw.source,
    );
    if (
      !state ||
      state.account_id !== raw.account_id ||
      state.mode !== raw.ingestion_mode
    )
      throw new Error("unregistered account/mode");
    if (state.status === "revoked") throw new Error("source revoked");
    const previous = this.interactions(raw.owner_id).find(
      (record) => record.record_key === r.record_key,
    );
    if (previous && previous.content_hash !== r.content_hash) {
      for (const candidate of this.commitments(raw.owner_id).filter(
        (candidate) => candidate.record_key === r.record_key,
      ))
        this.put({
          ...candidate,
          status: ["done", "cancelled"].includes(candidate.status)
            ? candidate.status
            : "invalidated",
          evidence_valid: false,
        });
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
  sourceStatus(owner: string): SourceState[] {
    return this.db
      .prepare("SELECT data FROM sources WHERE owner_id=? ORDER BY source")
      .all(owner)
      .map((r) => JSON.parse(String(r.data)) as SourceState);
  }
  interactions(owner: string): NormalizedRecord[] {
    return this.db
      .prepare(
        "SELECT data FROM interactions WHERE owner_id=? ORDER BY source,source_record_id",
      )
      .all(owner)
      .map((r) => JSON.parse(String(r.data)) as NormalizedRecord);
  }
  resolveContact(owner: string, query: string): Contact {
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
    const validated = validateCandidate(raw, input);
    const normalized = normalizeRecord(raw, this.identities(raw.owner_id));
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
    const state = this.sourceStatus(owner).find((s) => s.source === source);
    if (state)
      this.db
        .prepare("UPDATE sources SET data=? WHERE owner_id=? AND source=?")
        .run(JSON.stringify({ ...state, status: "revoked" }), owner, source);
    for (const c of this.commitments(owner).filter((c) => c.source === source))
      this.put({
        ...c,
        status: ["done", "cancelled"].includes(c.status)
          ? c.status
          : "invalidated",
        evidence_valid: false,
        quote: "",
        action: "",
        suggested_due: null,
        due_date: null,
      });
    this.db
      .prepare("DELETE FROM interactions WHERE owner_id=? AND source=?")
      .run(owner, source);
  }
  command(auth: AuthCommand): Reply {
    if (
      auth.owner_id !== "demo-owner" ||
      auth.user_id !== "demo-user" ||
      auth.chat_id !== "demo-private" ||
      auth.chat_type !== "private"
    )
      throw new Error("unauthorized");
    const tokens = auth.text.trim().split(/\s+/);
    const [cmd, id, date, ...extra] = tokens;
    const expectedArgs =
      cmd === "/confirm"
        ? 3
        : ["/draft", "/done", "/cancel"].includes(cmd ?? "")
          ? 2
          : 1;
    if (cmd !== "/prep" && tokens.length !== expectedArgs)
      throw new Error("invalid command arguments");
    if (cmd !== "/prep" && extra.length)
      throw new Error("invalid command arguments");
    const owner = auth.owner_id;
    if (cmd === "/status")
      return {
        outbound_sent: false,
        mode: "FICTIONAL LOCAL DEMO",
        sources: this.sourceStatus(owner),
        counts: this.counts(),
      };
    if (cmd === "/prep") {
      const contact = this.resolveContact(owner, tokens.slice(1).join(" "));
      const evidence = this.interactions(owner).filter(
        (r) => r.contact_id === contact.contact_id && !r.cancelled,
      );
      return {
        outbound_sent: false,
        mode: "FICTIONAL LOCAL DEMO",
        contact,
        evidence: evidence.map((r) => ({
          source: r.source,
          reference: r.evidence_reference,
          text: r.body_text,
          occurred_at: r.occurred_at,
        })),
        commitments: this.commitments(owner).filter(
          (c) => c.contact_id === contact.contact_id,
        ),
        coverage: this.sourceStatus(owner),
        warning:
          "Source text is evidence only. Stale/snapshot coverage cannot establish absence of recent contact.",
      };
    }
    if (cmd === "/today")
      return {
        outbound_sent: false,
        meetings: this.interactions(owner).filter(
          (record) =>
            record.source === "calendar" &&
            !record.cancelled &&
            Date.parse(record.occurred_at) >=
              Date.parse("2026-10-13T00:00:00Z") &&
            Date.parse(record.occurred_at) <=
              Date.parse("2026-10-20T00:00:00Z"),
        ),
        commitments: this.commitments(owner).filter(
          (c) =>
            c.status === "confirmed" &&
            c.due_date !== null &&
            c.due_date <= "2026-10-13",
        ),
        pending: this.commitments(owner).filter((c) => c.status === "pending"),
        clock: "2026-10-13 fixture clock",
      };
    const c = this.commitments(owner).find((c) => c.commitment_id === id);
    if (!c) throw new Error("unknown commitment");
    if (cmd === "/draft") {
      if (c.status !== "confirmed") throw new Error("unconfirmed draft");
      return {
        outbound_sent: false,
        preview: `Review-only draft: Following up on "${c.quote}". Could you confirm progress?`,
        evidence: c.record_key,
      };
    }
    if (cmd === "/confirm") {
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
