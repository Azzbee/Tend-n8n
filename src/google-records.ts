import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";
import {
  parse,
  defaultTreeAdapter,
  type DefaultTreeAdapterTypes,
  type TreeAdapter,
  type DefaultTreeAdapterMap,
} from "parse5";
import type { Contact, Identity, RawRecord } from "./engine.ts";
import {
  assertGoogleRead,
  calendarWindow,
  gmailWindow,
  zonedLocalInstant,
  validateLivePolicy,
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
  "unsupported_css_visibility",
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
function inlineStyleHides(style: string): boolean {
  if (style.length > 4096 || /[\\@{}()]|\/\*|\*\//.test(style))
    throw new Error("unsupported_css_visibility");
  const declarations = style
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  if (declarations.length > 64) throw new Error("unsupported_css_visibility");
  let hidden = false;
  const spacing =
    /^(?:0|(?:\d+(?:\.\d+)?|\.\d+)(?:px|pt|em|rem|%))(?: (?:0|(?:\d+(?:\.\d+)?|\.\d+)(?:px|pt|em|rem|%))){0,3}$/;
  for (const declaration of declarations) {
    const pair = /^([a-z-]+)\s*:\s*(.*?)\s*(?:!important)?$/i.exec(declaration);
    if (!pair) throw new Error("unsupported_css_visibility");
    const name = pair[1]!.toLowerCase(),
      value = pair[2]!.trim().toLowerCase();
    if (
      (name === "display" && value === "none") ||
      (name === "visibility" && ["hidden", "collapse"].includes(value)) ||
      (name === "opacity" &&
        Number(value) === 0 &&
        /^(?:0+(?:\.0*)?|\.0+)$/.test(value)) ||
      (name === "font-size" &&
        /^0+(?:\.0+)?(?:px|pt|em|rem|%)?$/.test(value)) ||
      (name === "mso-hide" && value === "all") ||
      (name === "color" && value === "transparent")
    ) {
      hidden = true;
      continue;
    }
    const supported =
      (name === "display" && value === "inline") ||
      (name === "visibility" && value === "visible") ||
      (name === "opacity" && value === "1") ||
      (name === "mso-hide" && value === "none") ||
      (name === "font-weight" &&
        /^(?:normal|bold|bolder|lighter|[1-9]00)$/.test(value)) ||
      (name === "font-style" && /^(?:normal|italic|oblique)$/.test(value)) ||
      (name === "font-family" && /^[\p{L}\p{N} ,"'-]+$/u.test(value)) ||
      (name === "line-height" && value === "normal") ||
      (name === "text-align" &&
        /^(?:left|right|center|justify|start|end)$/.test(value)) ||
      (name === "text-decoration" &&
        /^(?:none|(?:underline|overline|line-through)(?: (?:underline|overline|line-through))*)$/.test(
          value,
        )) ||
      (name === "text-transform" &&
        /^(?:none|uppercase|lowercase|capitalize)$/.test(value)) ||
      ((/^(?:margin|padding)(?:-(?:top|right|bottom|left))?$/.test(name) ||
        ["letter-spacing", "word-spacing"].includes(name)) &&
        spacing.test(value)) ||
      (name === "overflow" && /^(?:hidden|visible|auto|scroll)$/.test(value));
    if (!supported) throw new Error("unsupported_css_visibility");
  }
  return hidden;
}
/** HTML5 AST text only. Parsing never fetches resources or executes scripts. */
function htmlText(html: string): string {
  if (Buffer.byteLength(html, "utf8") > 1048576)
    throw new Error("body_size_limit");
  let lexicalWork = 0,
    whitespace = false;
  for (let i = 0; i < html.length; i++) {
    const code = html.charCodeAt(i);
    const space =
      code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
    if ((space && !whitespace) || code === 47 || code === 61)
      if (++lexicalWork > 4096) throw new Error("html_structure_limit");
    whitespace = space;
  }
  let parseErrors = 0;
  let allocated = 0;
  const allocate = (): void => {
    if (++allocated > 20000) throw new Error("html_structure_limit");
  };
  const depth = (parent: DefaultTreeAdapterTypes.ParentNode): void => {
    let n: DefaultTreeAdapterTypes.Node | null = parent,
      level = 0;
    while (n) {
      if (++level > 100) throw new Error("html_structure_limit");
      n = "parentNode" in n ? n.parentNode : null;
    }
  };
  const adapter: TreeAdapter<DefaultTreeAdapterMap> = {
    ...defaultTreeAdapter,
    createElement(...args) {
      allocate();
      return defaultTreeAdapter.createElement(...args);
    },
    createCommentNode(data) {
      allocate();
      return defaultTreeAdapter.createCommentNode(data);
    },
    createDocumentFragment() {
      allocate();
      return defaultTreeAdapter.createDocumentFragment();
    },
    createTextNode(data) {
      allocate();
      return defaultTreeAdapter.createTextNode(data);
    },
    appendChild(parent, child) {
      depth(parent);
      defaultTreeAdapter.appendChild(parent, child);
    },
    insertBefore(parent, child, reference) {
      depth(parent);
      defaultTreeAdapter.insertBefore(parent, child, reference);
    },
    insertText(parent, text) {
      const previous = parent.childNodes.at(-1);
      if (!previous || !defaultTreeAdapter.isTextNode(previous)) allocate();
      defaultTreeAdapter.insertText(parent, text);
    },
    insertTextBefore(parent, text, reference) {
      const previous =
        parent.childNodes[parent.childNodes.indexOf(reference) - 1];
      if (!previous || !defaultTreeAdapter.isTextNode(previous)) allocate();
      defaultTreeAdapter.insertTextBefore(parent, text, reference);
    },
  };
  const document = parse(html, {
    treeAdapter: adapter,
    sourceCodeLocationInfo: true,
    onParseError(error) {
      if (++parseErrors > 1000) throw new Error("malformed_html");
      if (
        [
          "non-void-html-element-start-tag-with-trailing-solidus",
          "eof-in-element-that-can-contain-only-text",
          "eof-in-script-html-comment-like-text",
        ].includes(error.code)
      )
        throw new Error("malformed_suppressed_html");
      if (["eof-in-comment", "eof-in-tag"].includes(error.code))
        throw new Error("malformed_html");
    },
  });
  const suppressedTags = new Set([
    "head",
    "script",
    "style",
    "title",
    "iframe",
    "object",
    "svg",
    "math",
    "noscript",
    "template",
    "noembed",
    "noframes",
    "datalist",
    "dialog",
    "video",
    "audio",
    "canvas",
    "rp",
    "details",
    "select",
    "option",
  ]);
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
    "td",
    "th",
    "ul",
    "ol",
    "h5",
    "h6",
  ]);
  const quoteMarker =
    /(?:gmail_quote|gmail_attr|gmail_signature|yahoo_quoted|moz-cite-prefix|moz-signature|divRplyFwdMsg)/i;
  const presentationalAttributes: Record<string, readonly string[]> = {
    color: ["font"],
    bgcolor: ["body", "table", "tr", "td", "th", "col", "colgroup"],
    background: ["body", "table", "td", "th"],
    text: ["body"],
    width: [
      "table",
      "tr",
      "td",
      "th",
      "col",
      "colgroup",
      "pre",
      "hr",
      "iframe",
      "object",
      "embed",
      "img",
      "video",
      "canvas",
      "input",
      "marquee",
    ],
    height: [
      "table",
      "tr",
      "td",
      "th",
      "iframe",
      "object",
      "embed",
      "img",
      "video",
      "canvas",
      "input",
      "marquee",
    ],
    size: ["font", "hr", "input", "select"],
  };
  const suppressedElements = new WeakSet<DefaultTreeAdapterTypes.Element>();
  const pending: { node: DefaultTreeAdapterTypes.Node; level: number }[] = [
    { node: document, level: 0 },
  ];
  let visited = 0,
    cutoff = html.length;
  while (pending.length) {
    const { node, level } = pending.pop()!;
    if (++visited > 20000 || level > 100)
      throw new Error("html_structure_limit");
    if (defaultTreeAdapter.isElementNode(node)) {
      const location = node.sourceCodeLocation;
      if (
        node.attrs.some(
          (a) =>
            Object.hasOwn(presentationalAttributes, a.name) &&
            presentationalAttributes[a.name]!.includes(node.tagName),
        )
      )
        throw new Error("unsupported_css_visibility");
      if (
        node.tagName === "style" &&
        node.childNodes.some(
          (child) => defaultTreeAdapter.isTextNode(child) && child.value.trim(),
        )
      )
        throw new Error("unsupported_css_visibility");
      if (
        node.tagName === "link" &&
        node.attrs.some(
          (a) =>
            a.name === "rel" &&
            a.value.toLowerCase().split(/\s+/).includes("stylesheet"),
        )
      )
        throw new Error("unsupported_css_visibility");
      const style = node.attrs.find((a) => a.name === "style")?.value ?? "";
      const styleHidden = inlineStyleHides(style);
      const suppressed =
        suppressedTags.has(node.tagName) ||
        node.attrs.some((a) => a.name === "hidden") ||
        styleHidden;
      if (suppressed) suppressedElements.add(node);
      if (
        node.tagName === "blockquote" ||
        node.attrs.some(
          (a) => ["class", "id"].includes(a.name) && quoteMarker.test(a.value),
        )
      ) {
        if (!location || !Number.isSafeInteger(location.startOffset))
          throw new Error("malformed_html");
        cutoff = Math.min(cutoff, location.startOffset);
      }
      if (
        suppressed &&
        location &&
        !location.endTag &&
        node.tagName !== "head" &&
        !voidTags.has(node.tagName) &&
        node.namespaceURI === "http://www.w3.org/1999/xhtml"
      )
        throw new Error("malformed_suppressed_html");
      if (
        node.tagName === "template" &&
        node.namespaceURI === "http://www.w3.org/1999/xhtml"
      )
        pending.push({
          node: defaultTreeAdapter.getTemplateContent(
            node as DefaultTreeAdapterTypes.Template,
          ),
          level: level + 1,
        });
    }
    if ("childNodes" in node)
      for (const child of node.childNodes)
        pending.push({ node: child, level: level + 1 });
  }
  let text = "";
  const render: {
    node: DefaultTreeAdapterTypes.Node;
    closing: boolean;
    preformatted: boolean;
  }[] = [{ node: document, closing: false, preformatted: false }];
  while (render.length) {
    const { node, closing, preformatted } = render.pop()!;
    if (defaultTreeAdapter.isTextNode(node)) {
      const location = node.sourceCodeLocation;
      if (location && location.endOffset <= cutoff)
        text += preformatted
          ? node.value
          : node.value.replace(/[\t\n\f\r ]+/g, " ");
      continue;
    }
    if (defaultTreeAdapter.isElementNode(node)) {
      if (
        suppressedElements.has(node) ||
        (node.sourceCodeLocation?.startOffset ?? -1) >= cutoff
      )
        continue;
      if (
        blocks.has(node.tagName) ||
        (!closing && ["br", "hr"].includes(node.tagName))
      )
        text += "\n";
    }
    if (!closing && "childNodes" in node) {
      const preserve =
        preformatted ||
        (defaultTreeAdapter.isElementNode(node) && node.tagName === "pre");
      render.push({ node, closing: true, preformatted: preserve });
      for (let i = node.childNodes.length - 1; i >= 0; i--)
        render.push({
          node: node.childNodes[i]!,
          closing: false,
          preformatted: preserve,
        });
    }
  }
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
    .replace(/^[^\S\n]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const replyHeader = /^\s*(?:From|De|Von)\s*:\s*\S/i.test(line);
    let nextHeader = "";
    if (replyHeader)
      for (let ahead = 1; ahead <= 3; ahead++) {
        nextHeader = lines[index + ahead] ?? "";
        if (nextHeader.trim()) break;
      }
    if (
      /^\s*_{10,}\s*$/.test(line) ||
      (replyHeader &&
        /^\s*(?:Sent|Envoyé|Envoye|Gesendet)\s*:/i.test(nextHeader))
    )
      break;
    if (
      /^\s*(?:--\s*$|Sent from my\b|Envoyé de mon\b|On .+wrote:\s*$|Le .+(?:écrit|ecrit)\s*:\s*$|[-_]{2,}\s*(?:Original Message|Forwarded message|Message transféré|Message d['’]origine|Ursprüngliche Nachricht)|Begin forwarded message:|From:\s+.+@)/i.test(
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
  return normalizeCalendarFields(input, context);
}
function normalizeCalendarFields(
  input: unknown,
  context: NormalizationContext,
): NormalizationResult {
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

export function calendarSnapshotDigest(input: unknown): string {
  const canonical = (value: unknown, depth: number): unknown => {
    if (depth > 8) throw new Error("calendar snapshot nesting limit");
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
      if (value.length > 32) throw new Error("calendar snapshot array limit");
      return value.map((item) => canonical(item, depth + 1));
    }
    const raw = object(value);
    return Object.fromEntries(
      Object.keys(raw)
        .sort()
        .map((key) => [key, canonical(raw[key], depth + 1)]),
    );
  };
  const text = JSON.stringify(canonical(input, 0));
  if (Buffer.byteLength(text) > 262_144)
    throw new Error("calendar snapshot size limit");
  return createHash("sha256").update(text).digest("hex");
}

/** Operator-inspected, exact-event capture; never evidence of a successful API read. */
export function normalizeCalendarSnapshot(
  input: unknown,
  policy: LivePolicy,
  now: Date,
): NormalizationResult {
  validateLivePolicy(policy);
  const capture = object(input);
  const exact = (value: Record<string, unknown>, fields: string[]): void => {
    if (Object.keys(value).some((key) => !fields.includes(key)))
      throw new Error("unsupported calendar snapshot field");
  };
  exact(capture, ["calendar_id", "event", "captured_at", "source_reference"]);
  if (Object.keys(capture).length !== 4)
    throw new Error("calendar snapshot capture proof required");
  const raw = object(capture.event),
    calendar_id = string(capture.calendar_id),
    captured_at = string(capture.captured_at),
    reference = new URL(string(capture.source_reference)),
    binding = policy.manual_calendar_snapshots?.find(
      (entry) => entry.calendar_id === calendar_id && entry.event_id === raw.id,
    );
  if (
    !binding ||
    binding.capture_sha256 !== calendarSnapshotDigest(capture) ||
    reference.origin !== "https://calendar.google.com" ||
    reference.username ||
    reference.password ||
    !/^\/calendar\/u\/\d+\/r$/.test(reference.pathname) ||
    reference.hash ||
    reference.searchParams.getAll("eid").length !== 1 ||
    [...reference.searchParams.keys()].some((key) => key !== "eid") ||
    Buffer.from(reference.searchParams.get("eid") ?? "", "base64url").toString(
      "utf8",
    ) !== `${String(raw.id)} ${calendar_id}` ||
    !Number.isFinite(Date.parse(captured_at)) ||
    new Date(captured_at).toISOString() !== captured_at ||
    Date.parse(captured_at) > now.getTime() ||
    now.getTime() - Date.parse(captured_at) > 3_600_000
  )
    throw new Error("unverified or stale calendar snapshot");
  exact(raw, [
    "id",
    "summary",
    "description",
    "location",
    "start",
    "end",
    "organizer",
    "attendees",
    "recurringEventId",
  ]);
  for (const time of [raw.start, raw.end])
    exact(object(time), ["date", "dateTime", "timeZone"]);
  const organizer = object(raw.organizer);
  exact(organizer, ["email", "displayName"]);
  const organizerEmail = canonicalEmail(string(organizer.email));
  if (
    !Array.isArray(raw.attendees) ||
    raw.attendees.length < 2 ||
    raw.attendees.length > 10
  )
    throw new Error("verified calendar snapshot guests required");
  const guests = raw.attendees.map((value: unknown) => {
    const guest = object(value);
    exact(guest, ["email", "displayName", "responseStatus", "self"]);
    const email = canonicalEmail(string(guest.email));
    if (
      guest.responseStatus !== "accepted" ||
      (guest.self !== undefined && typeof guest.self !== "boolean") ||
      (guest.self === true && email !== calendar_id)
    )
      throw new Error("unverified calendar snapshot guest");
    return { email, self: guest.self === true };
  });
  if (
    new Set(guests.map((g) => g.email)).size !== guests.length ||
    guests.filter((g) => g.self && g.email === calendar_id).length !== 1 ||
    !guests.some((g) => g.email === organizerEmail) ||
    organizerEmail === calendar_id ||
    policy.verified_owner_emails.includes(organizerEmail)
  )
    throw new Error("ambiguous calendar snapshot guests");
  const result = normalizeCalendarFields(raw, {
    policy: {
      ...policy,
      verified_owner_emails: [
        ...new Set([...policy.verified_owner_emails, calendar_id]),
      ],
    },
    now,
    account_email: policy.account_email,
    calendar_id,
  });
  if (result.kind === "accepted")
    result.record = {
      ...result.record,
      ingestion_mode: "snapshot",
      observed_at: captured_at,
      evidence_reference: reference.href,
    };
  return result;
}
