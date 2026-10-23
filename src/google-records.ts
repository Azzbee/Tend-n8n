import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";
import type { Contact, Identity, RawRecord } from "./engine.ts";
import {
  assertGoogleRead,
  calendarWindow,
  gmailWindow,
  zonedLocalInstant,
  type LivePolicy,
} from "./live-policy.ts";

export interface NormalizationContext {
  policy: LivePolicy;
  now: Date;
  account_email: string;
  calendar_id?: string;
}
export interface AuthoredSpan {
  start: number;
  end: number;
  text: string;
}
export interface LiveRecord extends RawRecord {
  contact_ids: string[];
  authored_text: string;
  authored_spans: AuthoredSpan[];
  attribution: "direct" | "group" | "unknown";
  eligible_for_extraction: boolean;
  end_at?: string;
  all_day?: boolean;
}
export type NormalizationResult =
  | {
      kind: "accepted";
      record: LiveRecord;
      contacts: Contact[];
      identities: Identity[];
    }
  | {
      kind: "quarantined" | "expired" | "cancelled";
      source: "gmail" | "calendar";
      source_record_id: string;
      reason: string;
    };
interface Mailbox {
  email: string;
  name: string;
}
interface Header {
  name: string;
  value: string;
}
interface GmailPart {
  mimeType: string;
  filename?: string;
  headers: Header[];
  body: { data?: string; attachmentId?: string };
  parts: GmailPart[];
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid_provider_object");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid_provider_string");
  return value;
}
function id(value: unknown): string {
  const text = string(value);
  if (
    !text ||
    text.length > 1024 ||
    Array.from(text).some(
      (c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127,
    )
  )
    throw new Error("invalid_provider_id");
  return text;
}
function fallbackId(input: unknown): string {
  try {
    return id(object(input).id);
  } catch {
    return "invalid-record";
  }
}
function rejection(
  source: "gmail" | "calendar",
  input: unknown,
  kind: "quarantined" | "expired" | "cancelled",
  reason: string,
): NormalizationResult {
  return { kind, source, source_record_id: fallbackId(input), reason };
}
const recordReasonCodes = new Set([
  "invalid_provider_object",
  "invalid_provider_string",
  "invalid_provider_id",
  "unsupported_email_identity",
  "invalid_email_identity",
  "invalid_base64_body",
  "invalid_body_charset",
  "invalid_header_newline",
  "invalid_encoded_header",
  "invalid_address_header",
  "unsupported_group_address_header",
  "invalid_mime_headers",
  "invalid_from_header",
  "mime_structure_limit",
  "invalid_mime_parts",
  "malformed_html",
  "html_structure_limit",
  "malformed_suppressed_html",
  "body_size_limit",
  "invalid_message_labels",
  "invalid_internal_date",
  "ambiguous_sender",
  "invalid_calendar_date",
  "invalid_calendar_time",
  "invalid_event_status",
  "invalid_event_recurrence",
  "invalid_event_interval",
  "invalid_event_attendees",
  "unverified_owner_alias",
]);
/** Library exceptions may interpolate private provider input. Persist codes only. */
function recordReason(error: unknown, fallback: string): string {
  return error instanceof Error && recordReasonCodes.has(error.message)
    ? error.message
    : fallback;
}
/** Domains are case-insensitive; generic local parts remain exact. Gmail local case is insensitive, but dots/plus aliases are never merged. */
export function canonicalEmail(value: string): string {
  const email = value.trim();
  if (/[^\x21-\x7e]/.test(email)) throw new Error("unsupported_email_identity");
  const at = email.lastIndexOf("@");
  if (at < 1 || email.indexOf("@") !== at)
    throw new Error("invalid_email_identity");
  let local = email.slice(0, at);
  const domain = domainToASCII(email.slice(at + 1)).toLowerCase();
  if (
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
    local.length > 64 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !domain.includes(".") ||
    domain
      .split(".")
      .some((p) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(p)) ||
    email.length > 254
  )
    throw new Error("invalid_email_identity");
  if (domain === "gmail.com" || domain === "googlemail.com")
    local = local.toLowerCase();
  return `${local}@${domain}`;
}
export function contactIdForEmail(principal_id: string, email: string): string {
  return `E${createHash("sha256")
    .update(JSON.stringify([principal_id, canonicalEmail(email)]))
    .digest("hex")}`;
}
function decodeBytes(
  data: string,
  encoding: "base64url" | "base64",
  charset = "utf-8",
): string {
  const valid =
    encoding === "base64url"
      ? /^[A-Za-z0-9_-]*={0,2}$/
      : /^[A-Za-z0-9+/]*={0,2}$/;
  if (!valid.test(data) || data.replace(/=+$/, "").length % 4 === 1)
    throw new Error("invalid_base64_body");
  const bytes = Buffer.from(data, encoding);
  if (bytes.toString(encoding).replace(/=+$/, "") !== data.replace(/=+$/, ""))
    throw new Error("invalid_base64_body");
  try {
    return new TextDecoder(charset, { fatal: true }).decode(bytes);
  } catch {
    throw new Error("invalid_body_charset");
  }
}
function decodedHeader(value: string): string {
  const unfolded = value.replace(/\r?\n[\t ]+/g, " ");
  if (Array.from(unfolded).some((c) => [0, 10, 13].includes(c.charCodeAt(0))))
    throw new Error("invalid_header_newline");
  return unfolded.replace(
    /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
    (_match: string, charset: string, mode: string, payload: string) => {
      if (mode.toLowerCase() === "b")
        return decodeBytes(payload, "base64", charset);
      const bytes: number[] = [];
      for (let index = 0; index < payload.length; index++) {
        const c = payload[index]!;
        if (c === "=") {
          const hex = payload.slice(index + 1, index + 3);
          if (!/^[0-9a-f]{2}$/i.test(hex))
            throw new Error("invalid_encoded_header");
          bytes.push(parseInt(hex, 16));
          index += 2;
        } else bytes.push(c === "_" ? 32 : c.charCodeAt(0));
      }
      try {
        return new TextDecoder(charset, { fatal: true }).decode(
          new Uint8Array(bytes),
        );
      } catch {
        throw new Error("invalid_encoded_header");
      }
    },
  );
}
function parseAddresses(value: string): Mailbox[] {
  const text = value.replace(/\r?\n[\t ]+/g, " ");
  if (Array.from(text).some((c) => [0, 10, 13].includes(c.charCodeAt(0))))
    throw new Error("invalid_address_header");
  const segments: string[] = [];
  let start = 0,
    quoted = false,
    escaped = false,
    angle = false;
  for (let index = 0; index < text.length; index++) {
    const c = text[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && c === "\\") {
      escaped = true;
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (!quoted) {
      if (c === "<") {
        if (angle) throw new Error("invalid_address_header");
        angle = true;
      }
      if (c === ">") {
        if (!angle) throw new Error("invalid_address_header");
        angle = false;
      }
      if (";:()".includes(c))
        throw new Error("unsupported_group_address_header");
      if (c === "," && !angle) {
        segments.push(text.slice(start, index));
        start = index + 1;
      }
    }
  }
  if (quoted || escaped || angle) throw new Error("invalid_address_header");
  segments.push(text.slice(start));
  return segments
    .filter((s) => s.trim())
    .map((segment) => {
      const item = segment.trim(),
        match = /^(.*?)<([^<>]+)>$/.exec(item);
      const email = canonicalEmail(match ? match[2]! : item);
      const label = match
        ? match[1]!
            .trim()
            .replace(/^"(.*)"$/, "$1")
            .replace(/\\(["\\])/g, "$1")
        : email;
      const name = Array.from(decodedHeader(label))
        .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c))
        .join("")
        .trim()
        .slice(0, 200);
      return { email, name: name || email };
    });
}
function headers(value: unknown): Header[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000)
    throw new Error("invalid_mime_headers");
  return value.map((h) => {
    const v = object(h);
    return { name: string(v.name).toLowerCase(), value: string(v.value) };
  });
}
function headerValue(all: Header[], name: string, single = false): string {
  const values = all.filter((h) => h.name === name).map((h) => h.value);
  if (single && values.length !== 1) throw new Error(`invalid_${name}_header`);
  return values.join(", ");
}
function part(value: unknown, budget: { nodes: number }, depth = 0): GmailPart {
  if (++budget.nodes > 200 || depth > 30)
    throw new Error("mime_structure_limit");
  const p = object(value),
    body = p.body === undefined ? {} : object(p.body);
  const parsedBody: GmailPart["body"] = {};
  if (body.data !== undefined) parsedBody.data = string(body.data);
  if (body.attachmentId !== undefined)
    parsedBody.attachmentId = string(body.attachmentId);
  if (p.parts !== undefined && !Array.isArray(p.parts))
    throw new Error("invalid_mime_parts");
  const result: GmailPart = {
    mimeType: string(p.mimeType).toLowerCase(),
    headers: headers(p.headers),
    body: parsedBody,
    parts: (Array.isArray(p.parts) ? p.parts : []).map((child) =>
      part(child, budget, depth + 1),
    ),
  };
  if (p.filename !== undefined) result.filename = string(p.filename);
  return result;
}
function entities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    hellip: "…",
    copy: "©",
  };
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (whole: string, key: string) => {
      if (key[0] !== "#") return named[key.toLowerCase()] ?? whole;
      const code =
        key[1]?.toLowerCase() === "x"
          ? parseInt(key.slice(2), 16)
          : parseInt(key.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : "�";
    },
  );
}
/** Text-only HTML tokenizer. Attributes are never interpreted as URLs or fetched. */
function htmlText(html: string): string {
  const stack: { tag: string; suppressed: boolean; ownSuppression: boolean }[] =
    [];
  const voidTags = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);
  const blocks = new Set([
    "p",
    "div",
    "li",
    "tr",
    "h1",
    "h2",
    "h3",
    "h4",
    "section",
    "article",
    "pre",
  ]);
  let text = "";
  for (let offset = 0; offset < html.length;) {
    let end: number;
    if (html[offset] !== "<") {
      end = html.indexOf("<", offset);
      if (end < 0) end = html.length;
    } else if (html.startsWith("<!--", offset)) {
      const close = html.indexOf("-->", offset + 4);
      if (close < 0) throw new Error("malformed_html");
      end = close + 3;
    } else {
      let quote = "";
      for (end = offset + 1; end < html.length; end++) {
        const char = html[end]!;
        if (quote) {
          if (char === quote) quote = "";
        } else if (char === '"' || char === "'") quote = char;
        else if (char === ">") break;
        else if (char === "<") throw new Error("malformed_html");
      }
      if (end === html.length) throw new Error("malformed_html");
      end++;
    }
    const token = html.slice(offset, end);
    offset = end;
    if (token.startsWith("<!--") || token.startsWith("<!")) continue;
    if (token === "<") throw new Error("malformed_html");
    if (!token.startsWith("<")) {
      if (!stack.some((s) => s.suppressed)) text += entities(token);
      continue;
    }
    let content = token.slice(1, -1).trimStart();
    const closing = content.startsWith("/");
    if (closing) content = content.slice(1).trimStart();
    const match = /^([a-z][a-z0-9:-]*)\b([\s\S]*)$/i.exec(content);
    if (!match) throw new Error("malformed_html");
    const tag = match[1]!.toLowerCase(),
      attrs = entities(match[2]!);
    // Stop at a quotation/signature marker. Following unmarked text may still
    // be part of a wrapped quoted reply, rather than newly authored evidence.
    if (
      !closing &&
      (tag === "blockquote" ||
        /(?:gmail_quote|gmail_attr|gmail_signature|yahoo_quoted|moz-cite-prefix|moz-signature|divRplyFwdMsg)/i.test(
          attrs,
        ))
    )
      return text;
    const parentBlocked = stack.some((s) => s.suppressed);
    if (closing) {
      let index = stack.length - 1;
      while (index >= 0 && stack[index]?.tag !== tag) index--;
      if (index < 0) {
        if (voidTags.has(tag)) continue;
        throw new Error("malformed_html");
      }
      if (stack.slice(index + 1).some((s) => s.ownSuppression))
        throw new Error("malformed_suppressed_html");
      stack.splice(index);
      if (blocks.has(tag) && !stack.some((s) => s.suppressed)) text += "\n";
      continue;
    }
    const ownSuppression =
      [
        "blockquote",
        "script",
        "style",
        "head",
        "title",
        "iframe",
        "object",
        "svg",
        "math",
        "noscript",
        "template",
      ].includes(tag) ||
      /(?:gmail_quote|gmail_attr|gmail_signature|yahoo_quoted|moz-cite-prefix|moz-signature)/i.test(
        attrs,
      ) ||
      /(?:\bhidden\b|display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs);
    const suppressed = parentBlocked || ownSuppression;
    const selfClosing = /\/\s*$/.test(attrs);
    if (
      suppressed &&
      selfClosing &&
      !voidTags.has(tag) &&
      tag !== "svg" &&
      tag !== "math" &&
      !stack.some((s) => s.tag === "svg" || s.tag === "math")
    )
      throw new Error("malformed_suppressed_html");
    if (!suppressed && (blocks.has(tag) || tag === "br" || tag === "hr"))
      text += "\n";
    if (!voidTags.has(tag) && !selfClosing)
      stack.push({ tag, suppressed, ownSuppression });
    if (stack.length > 100) throw new Error("html_structure_limit");
    if (tag === "script" || tag === "style") {
      const close = new RegExp(`</${tag}(?=[\\t\\n\\f\\r />])`, "gi");
      close.lastIndex = offset;
      const match = close.exec(html);
      if (!match) throw new Error("malformed_suppressed_html");
      if (tag === "script") {
        // Double-escaped script data can contain an apparent closing script tag.
        let escaped = false;
        for (const marker of html
          .slice(offset, match.index)
          .matchAll(/<!--|-->|<script(?=[\t\n\f\r />])/gi)) {
          if (marker[0] === "<!--") escaped = true;
          else if (marker[0] === "-->") escaped = false;
          else if (escaped) throw new Error("malformed_suppressed_html");
        }
      }
      offset = match.index;
    }
  }
  if (stack.some((s) => s.suppressed))
    throw new Error("malformed_suppressed_html");
  return text;
}
function mimeText(
  p: GmailPart,
  budget: { bytes: number },
  maxBytes: number,
): string {
  if (
    p.filename ||
    p.body.attachmentId ||
    /attachment/i.test(headerValue(p.headers, "content-disposition")) ||
    p.mimeType === "message/rfc822"
  )
    return "";
  if (p.mimeType.startsWith("multipart/")) {
    if (p.mimeType === "multipart/alternative") {
      const preferred =
        p.parts.find(
          (c) =>
            c.mimeType === "text/plain" && !c.filename && !c.body.attachmentId,
        ) ??
        p.parts.find(
          (c) =>
            c.mimeType === "text/html" && !c.filename && !c.body.attachmentId,
        ) ??
        p.parts[0];
      return preferred ? mimeText(preferred, budget, maxBytes) : "";
    }
    return p.parts
      .map((child) => mimeText(child, budget, maxBytes))
      .filter(Boolean)
      .join("\n");
  }
  if (!["text/plain", "text/html"].includes(p.mimeType) || !p.body.data)
    return "";
  if (p.body.data.length > Math.ceil((maxBytes * 4) / 3) + 4)
    throw new Error("body_size_limit");
  const charset =
    /charset\s*=\s*["']?([^\s;"']+)/i.exec(
      headerValue(p.headers, "content-type"),
    )?.[1] ?? "utf-8";
  const text = decodeBytes(p.body.data, "base64url", charset);
  budget.bytes += Buffer.byteLength(text, "utf8");
  if (budget.bytes > maxBytes) throw new Error("body_size_limit");
  return p.mimeType === "text/html" ? htmlText(text) : text;
}
function authoredText(text: string): { text: string; spans: AuthoredSpan[] } {
  const lines = Array.from(text.replace(/\r\n?/g, "\n"))
    .filter(
      (c) =>
        (c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) ||
        [9, 10].includes(c.charCodeAt(0)),
    )
    .join("")
    .split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (
      /^\s*(?:--\s*$|Sent from my\b|Envoyé de mon\b|On .+wrote:\s*$|Le .+(?:écrit|ecrit)\s*:\s*$|[-_]{2,}\s*(?:Original Message|Forwarded message|Message transféré)|Begin forwarded message:|From:\s+.+@)/i.test(
        line,
      )
    )
      break;
    if (/^\s*>/.test(line)) break;
    kept.push(line.replace(/[\t ]+/g, " ").trimEnd());
  }
  const body = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const spans: AuthoredSpan[] = [];
  const regexp = /[^\n]+/g;
  let match: RegExpExecArray | null;
  while ((match = regexp.exec(body))) {
    const span = match[0].trim();
    if (span) {
      const start = match.index + match[0].indexOf(span);
      spans.push({ start, end: start + span.length, text: span });
    }
  }
  return { text: body, spans };
}
function contactRows(
  policy: LivePolicy,
  people: Mailbox[],
): { contacts: Contact[]; identities: Identity[]; contact_ids: string[] } {
  const owners = new Set(policy.verified_owner_emails.map(canonicalEmail));
  const unique = new Map(people.map((p) => [p.email, p]));
  const contacts: Contact[] = [],
    identities: Identity[] = [];
  for (const p of unique.values()) {
    const contact_id = owners.has(p.email)
      ? "OWNER"
      : contactIdForEmail(policy.principal_id, p.email);
    identities.push({
      owner_id: policy.principal_id,
      identity: p.email,
      contact_id,
    });
    if (contact_id !== "OWNER")
      contacts.push({
        owner_id: policy.principal_id,
        contact_id,
        name: p.name,
      });
  }
  return {
    contacts,
    identities,
    contact_ids: contacts.map((c) => c.contact_id).sort(),
  };
}
export function normalizeGmailMessage(
  input: unknown,
  context: NormalizationContext,
): NormalizationResult {
  assertGoogleRead(context.policy, context.account_email, "gmail.messages.get");
  const window = gmailWindow(context.policy, context.now);
  try {
    const raw = object(input),
      source_record_id = id(raw.id),
      thread = id(raw.threadId);
    if (
      !Array.isArray(raw.labelIds) ||
      raw.labelIds.some((l) => typeof l !== "string")
    )
      throw new Error("invalid_message_labels");
    const labels = raw.labelIds as string[];
    if (labels.includes("DRAFT"))
      return rejection("gmail", input, "quarantined", "unsent_draft");
    if (labels.some((l) => ["SPAM", "TRASH"].includes(l)))
      return rejection("gmail", input, "quarantined", "excluded_mail_label");
    const internalDate = string(raw.internalDate);
    if (
      !/^\d+$/.test(internalDate) ||
      !Number.isSafeInteger(Number(internalDate))
    )
      throw new Error("invalid_internal_date");
    const when = new Date(Number(internalDate));
    if (!Number.isFinite(when.getTime()))
      throw new Error("invalid_internal_date");
    if (
      when.getTime() < Date.parse(window.start) ||
      when.getTime() > Date.parse(window.end)
    )
      return rejection("gmail", input, "expired", "outside_mail_window");
    const payload = part(raw.payload, { nodes: 0 });
    const senders = parseAddresses(headerValue(payload.headers, "from", true));
    if (senders.length !== 1) throw new Error("ambiguous_sender");
    const sender = senders[0]!;
    const recipients = parseAddresses(
      ["to", "cc", "bcc"]
        .map((h) => headerValue(payload.headers, h))
        .filter(Boolean)
        .join(", "),
    );
    const owners = new Set(
      context.policy.verified_owner_emails.map(canonicalEmail),
    );
    const sent = owners.has(sender.email);
    if (labels.includes("SENT") && !sent)
      return rejection("gmail", input, "quarantined", "unverified_owner_alias");
    if (sent && !labels.includes("SENT"))
      return rejection(
        "gmail",
        input,
        "quarantined",
        "unverified_owner_authorship",
      );
    if (!sent && !recipients.some((r) => owners.has(r.email)))
      return rejection(
        "gmail",
        input,
        "quarantined",
        "unverified_recipient_attribution",
      );
    const people = contactRows(context.policy, [sender, ...recipients]);
    const group =
      people.contacts.length > 1 ||
      payload.headers.some((h) => ["list-id", "list-post"].includes(h.name));
    const attribution = group
      ? "group"
      : people.contacts.length === 1
        ? "direct"
        : "unknown";
    const authored = authoredText(
      mimeText(payload, { bytes: 0 }, context.policy.limits.max_body_bytes),
    );
    const record: LiveRecord = {
      owner_id: context.policy.principal_id,
      source: "gmail",
      account_id: context.policy.account_email,
      source_record_id,
      source_thread_id: thread,
      kind: "message",
      direction: sent ? "sent" : "received",
      actor_identity: sender.email,
      participant_identities: [...new Set(recipients.map((r) => r.email))],
      occurred_at: when.toISOString(),
      observed_at: context.now.toISOString(),
      body_text: authored.text,
      authored_text: authored.text,
      authored_spans: authored.spans,
      contact_ids: people.contact_ids,
      attribution,
      eligible_for_extraction:
        attribution === "direct" && authored.spans.length > 0,
      evidence_reference: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(context.policy.account_email)}#all/${encodeURIComponent(thread)}`,
      ingestion_mode: "live",
      coverage_start: window.start,
      coverage_end: window.end,
      cancelled: false,
    };
    return {
      kind: "accepted",
      record,
      contacts: people.contacts,
      identities: people.identities,
    };
  } catch (error: unknown) {
    return rejection(
      "gmail",
      input,
      "quarantined",
      recordReason(error, "invalid_gmail_record"),
    );
  }
}

function dateOnly(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  )
    throw new Error("invalid_calendar_date");
  return value;
}
function eventInstant(
  input: unknown,
  timezone: string,
): { at: Date; all_day: boolean } {
  const value = object(input);
  if (typeof value.date === "string" && value.dateTime === undefined)
    return {
      at: zonedLocalInstant(`${dateOnly(value.date)}T00:00:00`, timezone),
      all_day: true,
    };
  if (typeof value.dateTime !== "string" || value.date !== undefined)
    throw new Error("invalid_calendar_time");
  const text = value.dateTime;
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(text) &&
    typeof value.timeZone === "string"
  )
    return { at: zonedLocalInstant(text, value.timeZone), all_day: false };
  if (
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      text,
    )
  )
    throw new Error("invalid_calendar_time");
  dateOnly(text.slice(0, 10));
  const at = new Date(text);
  if (!Number.isFinite(at.getTime())) throw new Error("invalid_calendar_time");
  return { at, all_day: false };
}
export function normalizeCalendarEvent(
  input: unknown,
  context: NormalizationContext,
): NormalizationResult {
  assertGoogleRead(
    context.policy,
    context.account_email,
    "calendar.events.get",
    context.calendar_id,
  );
  const window = calendarWindow(context.policy, context.now);
  try {
    const raw = object(input),
      source_record_id = id(raw.id);
    if (raw.status === "cancelled")
      return rejection("calendar", input, "cancelled", "provider_cancelled");
    if (
      raw.status !== undefined &&
      !["confirmed", "tentative"].includes(string(raw.status))
    )
      throw new Error("invalid_event_status");
    if (
      raw.recurrence !== undefined &&
      (!Array.isArray(raw.recurrence) ||
        raw.recurrence.some((rule) => typeof rule !== "string"))
    )
      throw new Error("invalid_event_recurrence");
    if (Array.isArray(raw.recurrence) && raw.recurrence.length)
      return rejection(
        "calendar",
        input,
        "quarantined",
        "unexpanded_recurrence",
      );
    const start = eventInstant(raw.start, context.policy.timezone),
      end = eventInstant(raw.end, context.policy.timezone);
    if (start.all_day !== end.all_day || end.at.getTime() <= start.at.getTime())
      throw new Error("invalid_event_interval");
    if (
      start.at.getTime() >= Date.parse(window.end) ||
      end.at.getTime() <= Date.parse(window.start)
    )
      return rejection("calendar", input, "expired", "outside_calendar_window");
    const people: Mailbox[] = [];
    if (raw.attendees !== undefined && !Array.isArray(raw.attendees))
      throw new Error("invalid_event_attendees");
    for (const item of Array.isArray(raw.attendees) ? raw.attendees : []) {
      const attendee = object(item);
      if (attendee.resource === true) continue;
      if (typeof attendee.email === "string") {
        const email = canonicalEmail(attendee.email);
        // Calendar's self flag means this calendar copy, not necessarily the
        // mailbox owner. Exact selected timetable identities are not contacts.
        if (email === context.calendar_id) continue;
        if (
          attendee.self === true &&
          !context.policy.verified_owner_emails
            .map(canonicalEmail)
            .includes(email)
        )
          throw new Error("unverified_owner_alias");
        people.push({
          email,
          name:
            typeof attendee.displayName === "string"
              ? attendee.displayName.slice(0, 200)
              : email,
        });
      }
    }
    let actor = canonicalEmail(context.policy.account_email);
    if (raw.organizer !== undefined) {
      const organizer = object(raw.organizer);
      if (typeof organizer.email === "string") {
        actor = canonicalEmail(organizer.email);
        people.push({
          email: actor,
          name:
            typeof organizer.displayName === "string"
              ? organizer.displayName.slice(0, 200)
              : actor,
        });
      }
    }
    // Timetable service organizers identify the calendar, not a personal contact.
    const calendar = context.calendar_id!;
    if (actor === calendar) {
      for (let index = people.length - 1; index >= 0; index--)
        if (people[index]?.email === calendar) people.splice(index, 1);
      actor = canonicalEmail(context.policy.account_email);
    }
    people.push({
      email: canonicalEmail(context.policy.account_email),
      name: "Owner",
    });
    const rows = contactRows(context.policy, people);
    const summary =
      raw.summary === undefined ? "(Untitled event)" : string(raw.summary);
    const description =
      raw.description === undefined ? "" : htmlText(string(raw.description));
    const location = raw.location === undefined ? "" : string(raw.location);
    const body_text = [summary, description, location]
      .filter(Boolean)
      .join("\n")
      .trim();
    if (
      Buffer.byteLength(body_text, "utf8") >
      context.policy.limits.max_body_bytes
    )
      throw new Error("body_size_limit");
    const record: LiveRecord = {
      owner_id: context.policy.principal_id,
      source: "calendar",
      account_id: calendar,
      source_record_id,
      source_thread_id:
        raw.recurringEventId === undefined
          ? source_record_id
          : id(raw.recurringEventId),
      kind: "meeting",
      direction: "event",
      actor_identity: actor,
      participant_identities: [...new Set(people.map((p) => p.email))],
      occurred_at: start.at.toISOString(),
      end_at: end.at.toISOString(),
      all_day: start.all_day,
      observed_at: context.now.toISOString(),
      body_text,
      authored_text: "",
      authored_spans: [],
      contact_ids: rows.contact_ids,
      attribution:
        rows.contacts.length > 1 || raw.attendeesOmitted === true
          ? "group"
          : rows.contacts.length === 1
            ? "direct"
            : "unknown",
      eligible_for_extraction: false,
      evidence_reference: `https://calendar.google.com/calendar/u/0/r?authuser=${encodeURIComponent(context.policy.account_email)}&cid=${encodeURIComponent(calendar)}&eid=${encodeURIComponent(Buffer.from(`${source_record_id} ${calendar}`).toString("base64url"))}`,
      ingestion_mode: "live",
      coverage_start: window.start,
      coverage_end: window.end,
      cancelled: false,
    };
    return {
      kind: "accepted",
      record,
      contacts: rows.contacts,
      identities: rows.identities,
    };
  } catch (error: unknown) {
    return rejection(
      "calendar",
      input,
      "quarantined",
      recordReason(error, "invalid_calendar_record"),
    );
  }
}
