import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Reply } from "./engine.ts";
import {
  APPROVAL_TTL_MS,
  RATE_LIMIT_MS,
  approvalProblem,
  deepLink,
  draftProblem,
  evidenceHash,
  outreachDraftRequest,
  FALLBACK_DRAFT_MODEL,
  planOutreach,
  purposes,
  repeatsAny,
  modelOnlyProblem,
  styleOnly,
  textHash,
  verifiedRecipient,
  type OutreachChannel,
  type OutreachEvidence,
  type OutreachProposal,
  type OutreachReason,
  type OutreachSnapshot,
  type OutreachStatus,
} from "./outreach.ts";
const textCode = (text: string): string => textHash(text).slice(0, 8);
// Workflows 24/26 run every 10 minutes; a receipt later than this is overdue.
export const GMAIL_RECEIPT_GRACE_MS = 15 * 60000;
import { buildRawMessage } from "./outreach-gmail.ts";

// The shape the Desk renders (shared contract with improve/desk-ui), plus two
// optional extras: recipient and deep_link.
export interface OutreachItem {
  id: string;
  contact_id: string;
  contact_name: string;
  channel: OutreachChannel;
  reason: OutreachReason;
  draft_text: string;
  text_code: string;
  evidence: OutreachEvidence[];
  status: OutreachStatus;
  expires_at: string;
  recipient: string;
  deep_link: string | null;
  style_basis: "recipient_examples" | "default" | "owner_edit";
  // Handed to the Gmail step but no receipt after a grace period: the draft
  // may not exist, so the owner checks Gmail or approves again.
  gmail_unconfirmed: boolean;
}
interface StoredItem extends Omit<
  OutreachItem,
  "deep_link" | "style_basis" | "text_code" | "gmail_unconfirmed"
> {
  owner_id: string;
  item_key: string;
  evidence_keys: string[];
  evidence_hash: string;
  style_basis: "recipient_examples" | "default" | "owner_edit";
  draft_source: "template" | "model" | "owner_edit";
  created_at: string;
  approved_at: string | null;
  approved_text_hash: string | null;
  gmail_draft_id: string | null;
  expiry_reason: string | null;
  // Set when the approved email is handed to the Gmail draft step, so a run
  // whose receipt fails cannot create the same draft again.
  handed_at?: string | null;
  // Scrubbed style examples sent to the model, kept to catch echoes.
  style_examples?: string[];
  evidence_from?: string[];
}
export interface OutreachBookOptions {
  owner_id: string;
  lane: "fictional" | "private";
  clock?: () => Date;
  // Kill switch for the send path. Off means no item is ever handed to a
  // Gmail step and no Gmail receipt is accepted.
  sendingEnabled: boolean;
}
// Refusal reasons safe to show the owner; matches safeOutreachError in
// src/desk-api.ts. Anything else (and any draft text) stays generic.
const safeReasons = [
  /^unknown outreach item$/,
  /^cannot (approve|edit|skip) a [a-z_]+ item$/,
  /^recipient is not a verified identity of this contact$/,
  /^(empty draft|draft too long|dash not allowed|instruction-like draft)$/,
  /^fill in the bracketed placeholder first$/,
  /^draft is no longer replaceable$/,
  /^draft changed since you saw it$/,
];
export function safeOutreachReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("uncited detail: "))
    return "The draft mentions a link, address, number or date that is not in the cited messages.";
  return safeReasons.some((r) => r.test(message))
    ? message
    : "Outreach command failed.";
}
const subjects: Record<OutreachReason, string> = {
  overdue_owed_to_you: "Following up",
  you_owe_soon: "Quick update",
  after_meeting: "After our meeting",
  reply_waiting: "Re: your message",
};
export class OutreachBook {
  private db: DatabaseSync;
  private clock: () => Date;
  readonly options: OutreachBookOptions;
  constructor(path: string, options: OutreachBookOptions) {
    this.options = options;
    this.clock = options.clock ?? (() => new Date());
    this.db = new DatabaseSync(path);
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS outreach_items(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,item_key TEXT NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outreach_ledger(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner_id TEXT NOT NULL,item_id TEXT NOT NULL,action TEXT NOT NULL,at TEXT NOT NULL,detail TEXT NOT NULL);`);
  }
  close(): void {
    this.db.close();
  }
  private now(): Date {
    return this.clock();
  }
  // Filters in SQL so expired history is never parsed on a Desk read.
  private rows(where = "", ...params: string[]): StoredItem[] {
    return this.db
      .prepare(
        `SELECT data FROM outreach_items WHERE owner_id=?${where} ORDER BY created_at,id`,
      )
      .all(this.options.owner_id, ...params)
      .map((r) => JSON.parse(String(r.data)) as StoredItem);
  }
  private get(id: string): StoredItem {
    if (typeof id !== "string" || !/^O[a-f0-9]{10}$/.test(id))
      throw new Error("unknown outreach item");
    const row = this.db
      .prepare("SELECT data FROM outreach_items WHERE id=? AND owner_id=?")
      .get(id, this.options.owner_id);
    if (!row) throw new Error("unknown outreach item");
    return JSON.parse(String(row.data)) as StoredItem;
  }
  private put(item: StoredItem): void {
    this.db
      .prepare("UPDATE outreach_items SET data=? WHERE id=? AND owner_id=?")
      .run(JSON.stringify(item), item.id, item.owner_id);
  }
  private log(itemId: string, action: string, detail = ""): void {
    this.db
      .prepare(
        "INSERT INTO outreach_ledger(owner_id,item_id,action,at,detail) VALUES(?,?,?,?,?)",
      )
      .run(
        this.options.owner_id,
        itemId,
        action,
        this.now().toISOString(),
        detail.slice(0, 200),
      );
  }
  ledger(): { item_id: string; action: string; at: string; detail: string }[] {
    return this.db
      .prepare(
        "SELECT item_id,action,at,detail FROM outreach_ledger WHERE owner_id=? ORDER BY seq",
      )
      .all(this.options.owner_id) as unknown as {
      item_id: string;
      action: string;
      at: string;
      detail: string;
    }[];
  }
  // Lazily expire items whose approval window passed or whose cited evidence
  // (or the commitment behind them) changed since the draft was written.
  private refresh(snapshot: OutreachSnapshot): StoredItem[] {
    const now = this.now().getTime();
    const items = this.rows(
      " AND json_extract(data,'$.status') IN ('pending','approved')",
    );
    for (const item of items) {
      const records = item.evidence_keys
        .map((k) => snapshot.interactions.find((r) => r.record_key === k))
        .filter((r) => r !== undefined);
      const commitmentId = item.item_key.split(":")[1] ?? "";
      const commitmentGone =
        (item.reason === "overdue_owed_to_you" ||
          item.reason === "you_owe_soon") &&
        !snapshot.commitments.some(
          (c) =>
            c.commitment_id === commitmentId &&
            c.status === "confirmed" &&
            c.evidence_valid,
        );
      const reason =
        records.length !== item.evidence_keys.length ||
        records.some((r) => r.cancelled) ||
        evidenceHash(records) !== item.evidence_hash
          ? "evidence changed"
          : commitmentGone
            ? "commitment no longer open"
            : now >= Date.parse(item.expires_at)
              ? "approval window passed"
              : null;
      if (reason) {
        item.status = "expired";
        item.expiry_reason = reason;
        this.put(item);
        this.log(item.id, "expired", reason);
      }
    }
    return items;
  }
  private view(item: StoredItem): OutreachItem {
    return {
      id: item.id,
      contact_id: item.contact_id,
      contact_name: item.contact_name,
      channel: item.channel,
      reason: item.reason,
      draft_text: item.draft_text,
      text_code: textCode(item.draft_text),
      evidence: item.evidence,
      status: item.status,
      expires_at: item.expires_at,
      recipient: item.recipient,
      style_basis: item.style_basis,
      gmail_unconfirmed:
        item.status === "approved" &&
        item.channel === "email" &&
        !!item.handed_at &&
        this.now().getTime() - Date.parse(item.handed_at) >=
          GMAIL_RECEIPT_GRACE_MS,
      deep_link:
        item.status === "approved"
          ? deepLink(item.channel, item.recipient, item.draft_text)
          : null,
    };
  }
  // Rows withdrawn by re-keying owner_id keep their primary key, so a new
  // proposal can hash to an id already taken under another owner.
  private freshId(itemKey: string, createdAt: string): string {
    const taken = this.db.prepare("SELECT 1 FROM outreach_items WHERE id=?");
    for (let n = 0; ; n++) {
      const id =
        "O" +
        createHash("sha256")
          .update(
            `${this.options.owner_id}|${itemKey}|${createdAt}${n ? `|${n}` : ""}`,
          )
          .digest("hex")
          .slice(0, 10);
      if (!taken.get(id)) return id;
    }
  }
  plan(
    snapshot: OutreachSnapshot,
    model: string = FALLBACK_DRAFT_MODEL,
  ): {
    fictional: boolean;
    quiet_hours: boolean;
    held_back: string[];
    created: (OutreachItem & {
      request: ReturnType<typeof outreachDraftRequest>;
      style_basis: string;
    })[];
  } {
    this.refresh(snapshot);
    const now = this.now();
    // Same window as withinRateLimit: only items created in the last 3 days.
    const since = new Date(now.getTime() - RATE_LIMIT_MS).toISOString();
    const prior = this.rows(" AND created_at>?", since).map((i) => ({
      item_key: i.item_key,
      created_at: i.created_at,
    }));
    const result = planOutreach(snapshot, now, prior);
    const created = result.proposals.map((p: OutreachProposal) => {
      const created_at = now.toISOString();
      const item: StoredItem = {
        id: this.freshId(p.item_key, created_at),
        owner_id: this.options.owner_id,
        item_key: p.item_key,
        contact_id: p.contact_id,
        contact_name: p.contact_name,
        channel: p.channel,
        reason: p.reason,
        recipient: p.recipient,
        draft_text: p.fallback_text,
        evidence: p.evidence,
        evidence_keys: p.evidence_keys,
        evidence_hash: p.evidence_hash,
        style_basis: p.style_examples.length ? "recipient_examples" : "default",
        style_examples: p.style_examples.map(styleOnly),
        evidence_from: p.evidence_from,
        draft_source: "template",
        status: "pending",
        created_at,
        expires_at: new Date(now.getTime() + RATE_LIMIT_MS).toISOString(),
        approved_at: null,
        approved_text_hash: null,
        gmail_draft_id: null,
        expiry_reason: null,
      };
      this.db
        .prepare("INSERT INTO outreach_items VALUES(?,?,?,?,?)")
        .run(
          item.id,
          item.owner_id,
          item.item_key,
          created_at,
          JSON.stringify(item),
        );
      this.log(item.id, "planned", p.reason);
      return {
        ...this.view(item),
        style_basis: item.style_basis,
        request: outreachDraftRequest(p, model),
      };
    });
    return {
      fictional: this.options.lane === "fictional",
      quiet_hours: result.quiet_hours,
      held_back: result.held_back,
      created,
    };
  }
  // Model output replaces the template only if it passes the cited-evidence
  // check; otherwise the template draft stays.
  modelDraft(
    id: string,
    text: unknown,
    snapshot: OutreachSnapshot,
  ): { accepted: boolean; problem: string | null; item: OutreachItem } {
    this.refresh(snapshot);
    const item = this.get(id);
    if (item.status !== "pending" || item.draft_source !== "template")
      return {
        accepted: false,
        problem: "draft is no longer replaceable",
        item: this.view(item),
      };
    const problem =
      typeof text !== "string"
        ? "missing model text"
        : repeatsAny(
              text,
              item.evidence.map((e) => e.text),
            )
          ? "model repeated the cited message"
          : repeatsAny(text, [
                ...(item.style_examples ?? []),
                purposes[item.reason],
              ])
            ? "model repeated the prompt"
            : (draftProblem(text, item.evidence) ??
              modelOnlyProblem(
                text,
                item.evidence,
                item.evidence
                  .filter(
                    (_, i) =>
                      !["you", "calendar"].includes(
                        item.evidence_from?.[i] ?? "you",
                      ),
                  )
                  .map((e) => e.text),
              ));
    if (problem) {
      this.log(item.id, "model_draft_rejected", problem);
      return { accepted: false, problem, item: this.view(item) };
    }
    item.draft_text = String(text).trim();
    item.draft_source = "model";
    this.put(item);
    this.log(item.id, "model_draft", item.style_basis);
    return { accepted: true, problem: null, item: this.view(item) };
  }
  list(
    snapshot: OutreachSnapshot,
    includeExpired = true,
  ): {
    items: OutreachItem[];
    sending_enabled: boolean;
  } {
    this.refresh(snapshot);
    return {
      items: this.rows(
        includeExpired ? "" : " AND json_extract(data,'$.status')<>'expired'",
      ).map((i) => this.view(i)),
      sending_enabled: this.options.sendingEnabled,
    };
  }
  // `seen` is the text_code of the draft the owner was shown; a planner or
  // model rewrite in between makes it stale, so the owner reviews again.
  approve(id: string, seen: string, snapshot: OutreachSnapshot): OutreachItem {
    this.refresh(snapshot);
    const item = this.get(id);
    // The book is SQLite, outside the private bot's PostgreSQL transaction: if
    // the reply is rolled back after an approval, resending the same
    // /approve ID CODE returns that approval instead of an error. It never
    // extends the 24-hour window.
    if (
      item.status === "approved" &&
      seen === textCode(item.draft_text) &&
      item.approved_text_hash === textHash(item.draft_text)
    )
      return this.view(item);
    if (item.status !== "pending")
      throw new Error(`cannot approve a ${item.status} item`);
    if (seen !== textCode(item.draft_text))
      throw new Error("draft changed since you saw it");
    const contact = snapshot.contacts.find(
      (c) => c.contact_id === item.contact_id,
    );
    if (!contact?.emails.includes(item.recipient))
      throw new Error("recipient is not a verified identity of this contact");
    const problem = approvalProblem(item.draft_text, item.evidence);
    if (problem) throw new Error(problem);
    const now = this.now();
    item.status = "approved";
    item.approved_at = now.toISOString();
    item.handed_at = null;
    item.approved_text_hash = textHash(item.draft_text);
    item.expires_at = new Date(now.getTime() + APPROVAL_TTL_MS).toISOString();
    this.put(item);
    this.log(item.id, "approved", item.approved_text_hash.slice(0, 16));
    return this.view(item);
  }
  edit(id: string, text: string, snapshot: OutreachSnapshot): OutreachItem {
    this.refresh(snapshot);
    const item = this.get(id);
    if (item.status !== "pending" && item.status !== "approved")
      throw new Error(`cannot edit a ${item.status} item`);
    if (typeof text !== "string") throw new Error("text required");
    const problem = draftProblem(text, item.evidence);
    if (problem) throw new Error(problem);
    // An edit is a new message: any earlier approval no longer applies.
    item.draft_text = text.trim();
    item.draft_source = "owner_edit";
    item.style_basis = "owner_edit";
    item.status = "pending";
    item.approved_at = null;
    item.approved_text_hash = null;
    this.put(item);
    this.log(item.id, "edited", textHash(item.draft_text).slice(0, 16));
    return this.view(item);
  }
  skip(id: string, snapshot: OutreachSnapshot): OutreachItem {
    this.refresh(snapshot);
    const item = this.get(id);
    if (item.status !== "pending" && item.status !== "approved")
      throw new Error(`cannot skip a ${item.status} item`);
    item.status = "skipped";
    this.put(item);
    this.log(item.id, "skipped");
    return this.view(item);
  }
  private sendable(item: StoredItem, snapshot: OutreachSnapshot): boolean {
    const contact = snapshot.contacts.find(
      (c) => c.contact_id === item.contact_id,
    );
    return (
      this.options.sendingEnabled &&
      item.status === "approved" &&
      item.channel === "email" &&
      item.approved_text_hash === textHash(item.draft_text) &&
      verifiedRecipient(contact, "email") !== null &&
      contact!.emails.includes(item.recipient) &&
      (this.options.lane !== "fictional" ||
        item.recipient.endsWith("@example.invalid"))
    );
  }
  // Items the Gmail step may turn into drafts: approved email only, exact
  // approved text, re-verified recipient, kill switch on.
  approvedEmail(snapshot: OutreachSnapshot): {
    enabled: boolean;
    items: { id: string; approval_hash: string; message: { raw: string } }[];
  } {
    const items = this.refresh(snapshot).filter(
      (i) => !i.handed_at && this.sendable(i, snapshot),
    );
    for (const i of items) {
      i.handed_at = this.now().toISOString();
      this.put(i);
      this.log(i.id, "handed_to_gmail", i.approved_text_hash!.slice(0, 16));
    }
    return {
      enabled: this.options.sendingEnabled,
      items: items.map((i) => ({
        id: i.id,
        approval_hash: i.approved_text_hash!,
        message: {
          raw: buildRawMessage(i.recipient, subjects[i.reason], i.draft_text),
        },
      })),
    };
  }
  recordGmailDraft(
    id: string,
    approvalHash: unknown,
    draftId: unknown,
    snapshot: OutreachSnapshot,
  ): OutreachItem {
    this.refresh(snapshot);
    const item = this.get(id);
    if (
      !this.sendable(item, snapshot) ||
      approvalHash !== item.approved_text_hash
    )
      throw new Error("no current approval for this exact message");
    if (typeof draftId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(draftId))
      throw new Error("invalid Gmail draft receipt");
    item.status = "gmail_draft_created";
    item.gmail_draft_id = draftId;
    this.put(item);
    this.log(item.id, "gmail_draft_created", draftId);
    return this.view(item);
  }
  // Telegram /outreach, /approve <id> <code>, /edit <id> <text>, /skip <id>.
  // Returns null for any other command so the normal handler runs.
  telegram(text: string, snapshot: OutreachSnapshot): Reply | null {
    const match = /^\/(outreach|approve|edit|skip)(?:\s+([\s\S]*))?$/.exec(
      text.trim(),
    );
    if (!match) return null;
    const [, cmd, rest = ""] = match;
    const [id = "", ...words] = rest.trim().split(/\s+/);
    if (cmd === "outreach" && !rest.trim())
      return {
        outbound_sent: false,
        outreach: this.list(snapshot, false).items.filter(
          (i) => i.status === "pending" || i.status === "approved",
        ),
      };
    try {
      const item =
        cmd === "approve" && id && words.length === 1
          ? this.approve(id, words[0]!, snapshot)
          : cmd === "skip" && id && !words.length
            ? this.skip(id, snapshot)
            : cmd === "edit" && words.length
              ? this.edit(id, rest.trim().slice(id.length).trim(), snapshot)
              : null;
      if (!item)
        return {
          outbound_sent: false,
          outreach_error:
            "Use /outreach, /approve ID CODE, /edit ID text or /skip ID.",
        };
      return { outbound_sent: false, outreach_item: item };
    } catch (error) {
      return {
        outbound_sent: false,
        outreach_error: safeOutreachReason(error),
      };
    }
  }
}
