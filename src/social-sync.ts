import { createHash } from "node:crypto";
import type { Contact, Identity, LiveBatch } from "./engine.ts";
import {
  normalizeUnipileMessage,
  normalizeUnipileWebhook,
  normalizeMetaWebhook,
  normalizeLinkedInSnapshot,
  normalizeLinkedInChange,
  type MessagingContext,
  type MessagingResult,
  type MessagingSource,
} from "./messaging-records.ts";
import {
  socialAccount,
  socialWindow,
  type SocialPolicy,
} from "./social-policy.ts";
export type SocialFormat =
  | "unipile_messages"
  | "unipile_webhook"
  | "meta_webhook"
  | "linkedin_snapshot"
  | "linkedin_changes";
export interface SocialSyncRequest {
  source: MessagingSource;
  account_id: string;
  format: SocialFormat;
  items: unknown[];
  cursor: string | null;
  expected_cursor: string | null;
  complete: boolean;
  coverage_start: string;
  coverage_end: string;
  reconcile: boolean;
}
export interface SocialSyncContext {
  principal_id: string;
  now: Date;
  authenticated: MessagingContext["authenticated"];
  original_message_times?: Readonly<Record<string, string>>;
  max_body_bytes?: number;
}
export interface NormalizedSocialPage {
  batch: LiveBatch;
  /** Stable wire-page digest, independent of ingestion clock and object key order. */
  page_hash: string;
  invalidated_record_ids: string[];
}
function cursor(value: unknown): void {
  if (
    value !== null &&
    (typeof value !== "string" ||
      !value ||
      value.length > 8192 ||
      Array.from(value).some(
        (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
      ))
  )
    throw new Error("invalid social cursor");
}
function exactTime(value: unknown): number {
  if (typeof value !== "string") throw new Error("invalid social window");
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value)
    throw new Error("invalid social window");
  return ms;
}
function stable(
  value: unknown,
  depth = 0,
  budget = { nodes: 0, bytes: 0 },
  ancestors = new Set<object>(),
): unknown {
  if (++budget.nodes > 20000 || depth > 20)
    throw new Error("social page limit");
  if (typeof value === "string") {
    budget.bytes += Buffer.byteLength(value);
    if (budget.bytes > 4 * 1024 * 1024) throw new Error("social page limit");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid social number");
    return value;
  }
  if (value === null || typeof value === "boolean") return value;
  if (value && typeof value === "object") {
    if (ancestors.has(value)) throw new Error("invalid social cycle");
    ancestors.add(value);
    let result: unknown;
    if (Array.isArray(value))
      result = value.map((v) => stable(v, depth + 1, budget, ancestors));
    else {
      const output: Record<string, unknown> = Object.create(null) as Record<
        string,
        unknown
      >;
      for (const key of Object.keys(value).sort()) {
        budget.bytes += Buffer.byteLength(key);
        if (budget.bytes > 4 * 1024 * 1024)
          throw new Error("social page limit");
        output[key] = stable(
          (value as Record<string, unknown>)[key],
          depth + 1,
          budget,
          ancestors,
        );
      }
      result = output;
    }
    ancestors.delete(value);
    return result;
  }
  throw new Error("invalid social value");
}
export function normalizeSocialBatch(
  policy: SocialPolicy,
  request: SocialSyncRequest,
  context: SocialSyncContext,
): NormalizedSocialPage {
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new Error("invalid social batch");
  const allowed = [
    "source",
    "account_id",
    "format",
    "items",
    "cursor",
    "expected_cursor",
    "complete",
    "coverage_start",
    "coverage_end",
    "reconcile",
  ];
  if (
    Object.keys(request).some((key) => !allowed.includes(key)) ||
    !Object.hasOwn(request, "expected_cursor")
  )
    throw new Error("unknown social batch field");
  cursor(request.cursor);
  cursor(request.expected_cursor);
  if (
    typeof request.complete !== "boolean" ||
    typeof request.reconcile !== "boolean" ||
    !Array.isArray(request.items) ||
    request.items.length > 1000
  )
    throw new Error("invalid social page");
  if (request.complete && request.cursor !== null)
    throw new Error("completed social page has cursor");
  const account = socialAccount(policy, request.source, request.account_id);
  if (
    !context.authenticated ||
    context.authenticated.provider !== account.provider ||
    context.authenticated.account_id !== account.account_id
  )
    throw new Error("social response authentication required");
  const expectedFormats = {
    unipile: ["unipile_messages", "unipile_webhook"],
    meta: ["meta_webhook"],
    linkedin: ["linkedin_snapshot", "linkedin_changes"],
  };
  if (!expectedFormats[account.provider].includes(request.format))
    throw new Error("social provider format mismatch");
  const start = exactTime(request.coverage_start),
    end = exactTime(request.coverage_end),
    now = context.now.getTime();
  if (
    !Number.isFinite(now) ||
    end > now ||
    end < start ||
    end - start > 30 * 86400000
  )
    throw new Error("unapproved social window");
  if (end < now - 30 * 86400000) throw new Error("expired social window");
  const canonical = stable(request);
  const page_hash = createHash("sha256")
    .update(JSON.stringify([context.principal_id, canonical]))
    .digest("hex");
  const normalizeContext: MessagingContext = {
    principal_id: context.principal_id,
    account_id: account.account_id,
    owner_identity: account.owner_identity,
    now: context.now,
    authenticated: context.authenticated,
    ...(context.original_message_times
      ? { original_message_times: context.original_message_times }
      : {}),
    ...(context.max_body_bytes !== undefined
      ? { max_body_bytes: context.max_body_bytes }
      : {}),
    ...(account.provider === "meta"
      ? { business_phone_number_id: account.business_phone_number_id }
      : {}),
    ...(account.provider === "linkedin"
      ? {
          linkedin_profile_bindings: Object.fromEntries(
            account.profile_bindings.map((b) => [b.profile_url, b.member_urn]),
          ),
        }
      : {}),
  };
  const results: MessagingResult[] = request.items.flatMap(
    (item): MessagingResult[] => {
      switch (request.format) {
        case "unipile_messages":
          return [normalizeUnipileMessage(item, normalizeContext)];
        case "unipile_webhook":
          return [normalizeUnipileWebhook(item, normalizeContext)];
        case "meta_webhook":
          return normalizeMetaWebhook(item, normalizeContext);
        case "linkedin_snapshot":
          return [normalizeLinkedInSnapshot(item, normalizeContext)];
        case "linkedin_changes":
          return [normalizeLinkedInChange(item, normalizeContext)];
        default:
          throw new Error("unsupported social format");
      }
    },
  );
  const records: LiveBatch["records"] = [],
    contacts = new Map<string, Contact>(),
    identities = new Map<string, Identity>(),
    removed = new Set<string>(),
    seen = new Set<string>(),
    invalidated = new Set<string>();
  const quarantines: NonNullable<LiveBatch["quarantines"]> = [];
  for (const result of results) {
    if (result.kind === "accepted") {
      const occurred = Date.parse(result.record.occurred_at);
      if (occurred < start || occurred > end) {
        quarantines.push({
          source_record_id: result.record.source_record_id,
          reason: "outside_snapshot_window",
          observed_at: context.now.toISOString(),
        });
        continue;
      }
      const prior = records.find(
        (r) => r.source_record_id === result.record.source_record_id,
      );
      if (prior) {
        if (
          prior.body_text !== result.record.body_text ||
          prior.actor_identity !== result.record.actor_identity ||
          prior.occurred_at !== result.record.occurred_at
        )
          throw new Error("conflicting social page duplicate");
        continue;
      }
      records.push({
        ...result.record,
        observed_at: request.coverage_end,
        coverage_start: request.coverage_start,
        coverage_end: request.coverage_end,
      });
      seen.add(result.record.source_record_id);
      for (const contact of result.contacts)
        contacts.set(contact.contact_id, contact);
      for (const identity of result.identities) {
        const prior = identities.get(identity.identity);
        if (prior && prior.contact_id !== identity.contact_id)
          throw new Error("inconsistent social identity");
        identities.set(identity.identity, identity);
      }
    } else if (
      result.kind === "deleted" ||
      result.kind === "expired" ||
      result.kind === "invalidated"
    ) {
      removed.add(result.source_record_id);
      if (result.kind === "invalidated")
        invalidated.add(result.source_record_id);
    } else
      quarantines.push({
        source_record_id: result.source_record_id,
        reason: result.reason,
        observed_at: context.now.toISOString(),
      });
  }
  for (const record of records)
    if (removed.has(record.source_record_id))
      throw new Error("conflicting social page mutation");
  const complete = request.complete && quarantines.length === 0;
  return {
    page_hash,
    invalidated_record_ids: [...invalidated].sort(),
    batch: {
      owner_id: context.principal_id,
      source: request.source,
      account_id: request.account_id,
      records,
      cursor: request.cursor,
      expected_cursor: request.expected_cursor,
      complete,
      coverage_start: request.coverage_start,
      coverage_end: request.coverage_end,
      reconcile: request.reconcile && complete,
      seen_record_ids: [...seen].sort(),
      contacts: [...contacts.values()],
      identities: [...identities.values()],
      removed_record_ids: [...removed].sort(),
      quarantines,
    },
  };
}
export { socialWindow };
