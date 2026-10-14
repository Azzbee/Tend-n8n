import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Contact, Identity } from "./engine.ts";
import type { LiveRecord } from "./google-records.ts";
import { authoredSpans } from "./authored-promises.ts";
export type MessagingSource =
  "whatsapp_personal" | "whatsapp_business" | "linkedin";
export type MessagingProvider = "unipile" | "meta" | "linkedin";
export interface MessagingContext {
  principal_id: string;
  account_id: string;
  owner_identity: string;
  now: Date;
  /** Caller supplies this only after authenticating the HTTP response/callback. */
  authenticated: { provider: MessagingProvider; account_id: string } | null;
  business_phone_number_id?: string;
  linkedin_profile_bindings?: Readonly<Record<string, string>>;
  max_body_bytes?: number;
  /** Keyed by original provider message ID; edits never reset the retention clock. */
  original_message_times?: Readonly<Record<string, string>>;
}
export type MessagingResult =
  | {
      kind: "accepted";
      record: LiveRecord;
      contacts: Contact[];
      identities: Identity[];
    }
  | {
      kind: "quarantined" | "expired" | "deleted" | "invalidated" | "excluded";
      source: MessagingSource;
      account_id: string;
      source_record_id: string;
      reason: string;
    };
function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_object");
  return value as Record<string, unknown>;
}
function str(value: unknown, max = 1024): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    Array.from(value).some(
      (c) =>
        (c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0))) ||
        c.charCodeAt(0) === 127,
    )
  )
    throw new Error("invalid_string");
  return value;
}
function id(value: unknown): string {
  const v = str(value);
  if (!v || /\s/u.test(v)) throw new Error("invalid_identity");
  return v;
}
function list(value: unknown, max = 1000): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error("invalid_array");
  return value;
}
function bounded(
  value: unknown,
  depth = 0,
  budget = { nodes: 0, bytes: 0 },
  seen = new Set<object>(),
): void {
  if (++budget.nodes > 20000 || depth > 20) throw new Error("payload_limit");
  if (typeof value === "string") {
    budget.bytes += Buffer.byteLength(value);
    if (budget.bytes > 4 * 1024 * 1024) throw new Error("payload_limit");
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid_number");
  } else if (value !== null && typeof value === "object") {
    if (seen.has(value)) throw new Error("invalid_cycle");
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      budget.bytes += Buffer.byteLength(key);
      if (budget.bytes > 4 * 1024 * 1024) throw new Error("payload_limit");
      bounded(child, depth + 1, budget, seen);
    }
    seen.delete(value);
  } else if (!["boolean", "undefined"].includes(typeof value) && value !== null)
    throw new Error("invalid_value");
}
function authenticate(
  context: MessagingContext,
  provider: MessagingProvider,
): void {
  if (
    !context.authenticated ||
    context.authenticated.provider !== provider ||
    context.authenticated.account_id !== context.account_id
  )
    throw new Error("unauthenticated_account");
  id(context.account_id);
  id(context.principal_id);
  id(context.owner_identity);
  if (!Number.isFinite(context.now.getTime())) throw new Error("invalid_clock");
}
function hash(values: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
function originalTime(context: MessagingContext, recordId: string): Date {
  const value = context.original_message_times?.[recordId];
  if (!value) throw new Error("original_message_time_required");
  return instant(value);
}
function identity(
  provider: MessagingProvider,
  context: MessagingContext,
  raw: string,
): string {
  return `${provider}:${context.account_id}:${raw}`;
}
function reject(
  source: MessagingSource,
  context: MessagingContext,
  recordId: string,
  reason: string,
  kind:
    | "quarantined"
    | "expired"
    | "deleted"
    | "invalidated"
    | "excluded" = "quarantined",
): MessagingResult {
  return {
    kind,
    source,
    account_id: context.account_id,
    source_record_id: recordId,
    reason,
  };
}
function safe(
  source: MessagingSource,
  context: MessagingContext,
  input: unknown,
  fn: () => MessagingResult,
): MessagingResult {
  let recordId: string | undefined;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const raw = input as Record<string, unknown>;
    try {
      recordId = id(raw.id ?? raw.message_id);
    } catch {
      // Malformed identifiers use a bounded payload digest below.
    }
  }
  try {
    bounded(input);
    if (recordId === undefined)
      recordId = `invalid-record:${hash([source, input])}`;
    return fn();
  } catch (error) {
    return reject(
      source,
      context,
      recordId ?? "invalid-record",
      error instanceof Error && /^[a-z_]+$/.test(error.message)
        ? error.message
        : "invalid_provider_record",
    );
  }
}
function instant(
  value: unknown,
  kind: "iso" | "seconds" | "milliseconds" = "iso",
): Date {
  let ms: number;
  if (kind === "iso") {
    const s = str(value, 80);
    if (
      !/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d| UTC)$/.test(
        s,
      )
    )
      throw new Error("invalid_timestamp");
    const parts = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)/.exec(s)!;
    const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
    if (
      year! < 1970 ||
      month! < 1 ||
      month! > 12 ||
      day! < 1 ||
      day! > new Date(Date.UTC(year!, month!, 0)).getUTCDate() ||
      hour! > 23 ||
      minute! > 59 ||
      second! > 59
    )
      throw new Error("invalid_timestamp");
    ms = Date.parse(s.replace(/ UTC$/, "Z").replace(" ", "T"));
  } else {
    if (typeof value === "string" && /^\d+$/.test(value)) ms = Number(value);
    else if (typeof value === "number") ms = value;
    else throw new Error("invalid_timestamp");
    if (!Number.isSafeInteger(ms)) throw new Error("invalid_timestamp");
    if (kind === "seconds") ms *= 1000;
  }
  if (
    !Number.isFinite(ms) ||
    !Number.isSafeInteger(ms) ||
    !Number.isFinite(new Date(ms).getTime())
  )
    throw new Error("invalid_timestamp");
  return new Date(ms);
}
interface MessageFields {
  source: MessagingSource;
  provider: MessagingProvider;
  recordId: string;
  threadId: string;
  actor: string;
  participants: string[];
  when: Date;
  text: string;
  group?: boolean;
  membershipKnown: boolean;
  mode: "snapshot" | "live";
  names?: Readonly<Record<string, string>>;
}
function message(
  fields: MessageFields,
  context: MessagingContext,
): MessagingResult {
  const { source, provider, recordId, threadId, actor, when } = fields;
  const start = new Date(context.now.getTime() - 30 * 86400000).toISOString();
  if (when.getTime() < Date.parse(start))
    return reject(
      source,
      context,
      recordId,
      "outside_message_window",
      "expired",
    );
  if (when.getTime() > context.now.getTime())
    return reject(source, context, recordId, "future_message");
  const maxBytes = context.max_body_bytes ?? 262144;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 262144 ||
    Buffer.byteLength(fields.text) > maxBytes
  )
    throw new Error("body_size_limit");
  const members = [...new Set(fields.participants)];
  if (
    fields.membershipKnown &&
    (!members.includes(actor) || !members.includes(context.owner_identity))
  )
    throw new Error("unverified_participants");
  const others = members.filter((p) => p !== context.owner_identity);
  const attribution =
    fields.group || others.length > 1
      ? "group"
      : fields.membershipKnown && others.length === 1
        ? "direct"
        : "unknown";
  const contacts = others.map((p): Contact => ({
    owner_id: context.principal_id,
    contact_id: `M${hash([context.principal_id, provider, context.account_id, p])}`,
    name: fields.names?.[p]?.slice(0, 200) || p,
  }));
  const identities: Identity[] = members.map((p) => ({
    owner_id: context.principal_id,
    identity: identity(provider, context, p),
    contact_id:
      p === context.owner_identity
        ? "OWNER"
        : `M${hash([context.principal_id, provider, context.account_id, p])}`,
  }));
  const spans = authoredSpans(fields.text);
  return {
    kind: "accepted",
    contacts,
    identities,
    record: {
      owner_id: context.principal_id,
      source,
      account_id: context.account_id,
      source_record_id: recordId,
      source_thread_id: threadId,
      kind: "message",
      direction: actor === context.owner_identity ? "sent" : "received",
      actor_identity: identity(provider, context, actor),
      participant_identities: members
        .filter((p) => p !== actor)
        .map((p) => identity(provider, context, p)),
      occurred_at: when.toISOString(),
      observed_at: context.now.toISOString(),
      body_text: fields.text,
      authored_text: fields.text,
      authored_spans: spans,
      contact_ids: contacts.map((c) => c.contact_id).sort(),
      attribution,
      eligible_for_extraction: attribution === "direct" && spans.length > 0,
      evidence_reference: `tend-source:${source}/${encodeURIComponent(context.account_id)}/${encodeURIComponent(recordId)}`,
      ingestion_mode: fields.mode,
      coverage_start: start,
      coverage_end: context.now.toISOString(),
      cancelled: false,
    },
  };
}
function unipileMembers(raw: Record<string, unknown>): {
  participants: string[];
  names: Record<string, string>;
  membershipKnown: boolean;
} {
  if (raw.attendees === undefined)
    return { participants: [], names: {}, membershipKnown: false };
  const names: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  const participants = list(raw.attendees, 1000).map((entry) => {
    const a = obj(entry),
      key = id(a.attendee_provider_id);
    if (a.attendee_name !== undefined) names[key] = str(a.attendee_name, 200);
    return key;
  });
  return { participants, names, membershipKnown: true };
}
export function normalizeUnipileMessage(
  input: unknown,
  context: MessagingContext,
  source: "whatsapp_personal" | "whatsapp_business",
): MessagingResult {
  if (!["whatsapp_personal", "whatsapp_business"].includes(source))
    throw new Error("unapproved_unipile_source");
  return safe(source, context, input, () => {
    authenticate(context, "unipile");
    const raw = obj(input);
    if (id(raw.account_id) !== context.account_id)
      throw new Error("foreign_account");
    for (const flag of ["hidden", "deleted", "edited", "is_event"]) {
      const value = raw[flag];
      if (
        value !== undefined &&
        ![true, false, 0, 1].includes(value as boolean | number)
      )
        throw new Error("invalid_message_flag");
    }
    const stableId = id(raw.id ?? raw.message_id);
    if (raw.is_event === true || raw.is_event === 1)
      return reject(
        source,
        context,
        stableId,
        "provider_system_event",
        "excluded",
      );
    if (
      (typeof raw.event_type === "number" && raw.event_type !== 0) ||
      raw.is_hidden === true
    )
      throw new Error("unsupported_message_event");
    if (raw.deleted === 1 || raw.deleted === true)
      return reject(source, context, stableId, "provider_deleted", "deleted");
    if (raw.hidden === 1 || raw.hidden === true)
      return reject(
        source,
        context,
        stableId,
        "provider_hidden",
        "invalidated",
      );
    const actor = id(raw.sender_id);
    if (
      typeof raw.is_sender !== "boolean" &&
      raw.is_sender !== 0 &&
      raw.is_sender !== 1
    )
      throw new Error("invalid_direction");
    if (Boolean(raw.is_sender) !== (actor === context.owner_identity))
      throw new Error("sender_direction_mismatch");
    const members = unipileMembers(raw);
    if (!members.membershipKnown)
      members.participants = [...new Set([context.owner_identity, actor])];
    return message(
      {
        source,
        provider: "unipile",
        recordId: id(raw.id ?? raw.message_id),
        threadId: id(raw.chat_id),
        actor,
        when:
          (raw.edited === 1 || raw.edited === true) &&
          context.original_message_times?.[stableId]
            ? originalTime(context, stableId)
            : instant(raw.timestamp),
        text: str(raw.text, 262144),
        ...members,
        mode: "snapshot",
      },
      context,
    );
  });
}
export function normalizeUnipileWebhook(
  input: unknown,
  context: MessagingContext,
  source: "whatsapp_personal" | "whatsapp_business",
): MessagingResult {
  if (!["whatsapp_personal", "whatsapp_business"].includes(source))
    throw new Error("unapproved_unipile_source");
  return safe(source, context, input, () => {
    authenticate(context, "unipile");
    const raw = obj(input);
    if (
      id(raw.account_id) !== context.account_id ||
      raw.account_type !== "WHATSAPP" ||
      id(obj(raw.account_info).user_id) !== context.owner_identity
    )
      throw new Error("foreign_account");
    const recordId = id(raw.message_id);
    if (raw.event === "message_deleted")
      return reject(source, context, recordId, "provider_deleted", "deleted");
    if (!["message_received", "message_edited"].includes(str(raw.event)))
      throw new Error("unsupported_event");
    const eventTime = instant(raw.timestamp);
    if (eventTime.getTime() > context.now.getTime())
      throw new Error("future_message_event");
    if (raw.event === "message_edited") {
      if (!context.original_message_times?.[recordId])
        return reject(
          source,
          context,
          recordId,
          "original_message_time_required",
          "invalidated",
        );
      try {
        str(raw.message, 262144);
      } catch {
        return reject(
          source,
          context,
          recordId,
          "edited_content_unavailable",
          "invalidated",
        );
      }
    }
    const actor = id(obj(raw.sender).attendee_provider_id),
      members = unipileMembers(raw);
    if (!members.membershipKnown)
      members.participants = [...new Set([context.owner_identity, actor])];
    return message(
      {
        source,
        provider: "unipile",
        recordId,
        threadId: id(raw.chat_id),
        actor,
        when:
          raw.event === "message_edited"
            ? originalTime(context, recordId)
            : instant(raw.timestamp),
        text: str(raw.message, 262144),
        ...members,
        mode: "live",
      },
      context,
    );
  });
}
export function verifyMetaSignature(
  body: Uint8Array,
  signature: string | undefined,
  secret: string,
): boolean {
  if (
    body.byteLength > 4 * 1024 * 1024 ||
    !secret ||
    !signature ||
    !/^sha256=[0-9a-f]{64}$/.test(signature)
  )
    return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}
function phone(value: unknown): string {
  const s = id(value);
  if (!/^\d{7,15}$/.test(s)) throw new Error("invalid_phone_identity");
  return s;
}
function metaMessage(
  input: unknown,
  field: string,
  context: MessagingContext,
  thread?: string,
): MessagingResult {
  const raw = obj(input),
    eventId = id(raw.id),
    actor = phone(raw.from);
  const echo = field === "smb_message_echoes";
  if (field === "messages" && actor === context.owner_identity)
    throw new Error("unexpected_outgoing_message");
  if (
    field === "messages" &&
    raw.to !== undefined &&
    phone(raw.to) !== context.owner_identity
  )
    throw new Error("foreign_recipient");
  if (echo && actor !== context.owner_identity)
    throw new Error("unverified_echo_sender");
  const peer =
    actor === context.owner_identity ? phone(raw.to ?? thread) : actor;
  if (thread && thread !== peer) throw new Error("history_thread_mismatch");
  const eventTime = instant(raw.timestamp, "seconds");
  if (eventTime.getTime() > context.now.getTime())
    throw new Error("future_message_event");
  if ((raw.type === "edit" || raw.type === "revoke") && field !== "messages")
    throw new Error("unsupported_business_event");
  if (raw.type === "revoke")
    return reject(
      "whatsapp_business",
      context,
      id(obj(raw.revoke).original_message_id),
      "provider_revoked",
      "deleted",
    );
  let recordId = eventId,
    when = eventTime,
    content = raw;
  if (raw.type === "edit") {
    const edit = obj(raw.edit);
    recordId = id(edit.original_message_id);
    try {
      content = obj(edit.message);
      if (content.type !== "text")
        return reject(
          "whatsapp_business",
          context,
          recordId,
          "edited_content_unavailable",
          "invalidated",
        );
      when = originalTime(context, recordId);
      str(obj(content.text).body, 262144);
    } catch {
      return reject(
        "whatsapp_business",
        context,
        recordId,
        context.original_message_times?.[recordId]
          ? "edited_content_unavailable"
          : "original_message_time_required",
        "invalidated",
      );
    }
  } else if (raw.type !== "text")
    return reject(
      "whatsapp_business",
      context,
      recordId,
      "unsupported_message_type",
    );
  return message(
    {
      source: "whatsapp_business",
      provider: "meta",
      recordId,
      threadId: peer,
      actor,
      participants: [context.owner_identity, peer],
      membershipKnown: true,
      when,
      text: str(obj(content.text).body, 262144),
      mode: field === "history" ? "snapshot" : "live",
    },
    context,
  );
}
export function normalizeMetaWebhook(
  input: unknown,
  context: MessagingContext,
): MessagingResult[] {
  const results: MessagingResult[] = [];
  const outcome = safe("whatsapp_business", context, input, () => {
    authenticate(context, "meta");
    phone(context.owner_identity);
    const raw = obj(input);
    if (raw.object !== "whatsapp_business_account")
      throw new Error("invalid_business_object");
    for (const entry of list(raw.entry, 100)) {
      const e = obj(entry);
      if (id(e.id) !== context.account_id) throw new Error("foreign_account");
      for (const change of list(e.changes, 100)) {
        const c = obj(change),
          field = str(c.field),
          value = obj(c.value);
        if (
          !context.business_phone_number_id ||
          id(obj(value.metadata).phone_number_id) !==
            context.business_phone_number_id
        )
          throw new Error("foreign_phone_number");
        if (field === "history") {
          for (const history of list(value.history, 100))
            for (const thread of list(obj(history).threads, 1000)) {
              const t = obj(thread),
                tid = phone(t.id);
              for (const m of list(t.messages, 1000))
                results.push(metaMessage(m, field, context, tid));
            }
        } else if (["messages", "smb_message_echoes"].includes(field))
          for (const m of list(value.messages ?? value.message_echoes, 1000))
            results.push(metaMessage(m, field, context));
        else throw new Error("unsupported_business_event");
      }
    }
    return reject(
      "whatsapp_business",
      context,
      "empty-envelope",
      "empty_envelope",
    );
  });
  if (outcome.kind === "quarantined" && outcome.reason !== "empty_envelope")
    return [outcome];
  return results;
}
function liIdentity(value: unknown): string {
  const v = id(value);
  if (!/^urn:li:person:[A-Za-z0-9_-]+$/.test(v))
    throw new Error("unverified_member_identity");
  return v;
}
function liMembershipIdentity(value: unknown): string {
  const raw = obj(value),
    key = id(raw.identity);
  if (/^urn:li:salesIdentity:[A-Za-z0-9_-]+$/.test(key))
    return liIdentity(obj(raw["identity~"]).member);
  return liIdentity(key);
}
export function normalizeLinkedInChange(
  input: unknown,
  context: MessagingContext,
): MessagingResult {
  return safe("linkedin", context, input, () => {
    authenticate(context, "linkedin");
    const raw = obj(input);
    if (
      liIdentity(raw.owner) !== context.owner_identity ||
      context.account_id !== context.owner_identity
    )
      throw new Error("foreign_account");
    if (raw.resourceName !== "messages")
      throw new Error("unsupported_resource");
    const recordId = id(raw.resourceId);
    id(raw.activityId);
    instant(raw.processedAt, "milliseconds");
    if (
      raw.activityStatus !== undefined &&
      !["SUCCESS", "SUCCESSFUL_REPLAY"].includes(str(raw.activityStatus))
    )
      throw new Error("provider_processing_failure");
    if (raw.method === "DELETE")
      return reject(
        "linkedin",
        context,
        recordId,
        "provider_deleted",
        "deleted",
      );
    if (!["CREATE", "UPDATE", "PARTIAL_UPDATE"].includes(str(raw.method)))
      throw new Error("unsupported_method");
    const a = obj(raw.processedActivity);
    if (
      raw.method !== "CREATE" &&
      a.createdAt === undefined &&
      !context.original_message_times?.[recordId]
    )
      return reject(
        "linkedin",
        context,
        recordId,
        "original_message_time_required",
        "invalidated",
      );
    const actor = liIdentity(raw.actor);
    if (liIdentity(a.author) !== actor) throw new Error("actor_mismatch");
    const membership =
      a["thread~"] === undefined ? undefined : obj(a["thread~"]).membership;
    const participants =
      membership === undefined
        ? [...new Set([context.owner_identity, actor])]
        : list(membership, 1000).map((m) => liMembershipIdentity(m));
    const content = obj(a.content);
    return message(
      {
        source: "linkedin",
        provider: "linkedin",
        recordId,
        threadId: id(a.thread),
        actor,
        participants,
        membershipKnown: membership !== undefined,
        when:
          a.createdAt !== undefined
            ? instant(a.createdAt, "milliseconds")
            : raw.method === "CREATE"
              ? instant(raw.capturedAt, "milliseconds")
              : originalTime(context, recordId),
        text: str(obj(content.content).string, 262144),
        mode: "live",
      },
      context,
    );
  });
}
function boundProfile(value: unknown, context: MessagingContext): string {
  const v = str(value, 2048);
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new Error("unverified_snapshot_identity");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "www.linkedin.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/in\/[^/]+\/?$/.test(url.pathname)
  )
    throw new Error("unverified_snapshot_identity");
  const binding = context.linkedin_profile_bindings?.[v];
  if (!binding) throw new Error("unverified_snapshot_identity");
  return liIdentity(binding);
}
export function normalizeLinkedInSnapshot(
  input: unknown,
  context: MessagingContext,
): MessagingResult {
  return safe("linkedin", context, input, () => {
    authenticate(context, "linkedin");
    if (liIdentity(context.account_id) !== context.owner_identity)
      throw new Error("foreign_account");
    const raw = obj(input),
      actor = boundProfile(raw.FROM, context),
      recipient = boundProfile(raw.TO, context),
      threadId = id(raw["CONVERSATION ID"]),
      when = instant(raw.DATE),
      text = str(raw.CONTENT, 262144);
    return message(
      {
        source: "linkedin",
        provider: "linkedin",
        recordId: `snapshot:${hash([threadId, actor, recipient, when.toISOString(), text])}`,
        threadId,
        actor,
        participants: [actor, recipient],
        membershipKnown: true,
        when,
        text,
        mode: "snapshot",
      },
      context,
    );
  });
}
