import type { SourceState } from "./engine.ts";
import type { MessagingSource } from "./messaging-records.ts";
import {
  assertSocialRead,
  socialAccount,
  socialWindow,
  type SocialPolicy,
} from "./social-policy.ts";
import type { SocialSyncRequest } from "./social-sync.ts";
export type SocialReadPhase =
  "identity" | "snapshot" | "changes" | "connections";
export interface ProviderReadPlan {
  kind: "request";
  method: "GET";
  url: string;
  headers: Readonly<Record<string, string>>;
  follow_redirects: false;
  timeout_ms: 5000;
  operation: string;
  response_kind:
    | "unipile_account"
    | "unipile_messages"
    | "linkedin_identity"
    | "linkedin_snapshot"
    | "linkedin_connections"
    | "linkedin_changes";
  source: MessagingSource;
  account_id: string;
  expected_owner_identity: string;
  expected_cursor: string | null;
  coverage_start: string;
  coverage_end: string;
  limit: number;
  requested_at: string;
  page_start?: number;
  watermark?: number;
  connections_cursor?: string | null;
}
export type ProviderReadMapping =
  | {
      kind: "page";
      request: SocialSyncRequest;
      watermark?: number;
      metadata?: {
        unhandled_activity_count: number;
        connection_changelog_supported: false;
        connection_changelog_gap: boolean;
      };
    }
  | {
      kind: "connections";
      source: "linkedin";
      account_id: string;
      owner_identity: string;
      rows: Record<string, string>[];
      next_cursor: string | null;
      complete: boolean;
      identity_bindings_verified: false;
      requires_owner_review: true;
      schema_verified: false;
      omitted_row_count: number;
      unknown_field_count: number;
      truncated_value_count: number;
    }
  | {
      kind: "identity";
      source: MessagingSource;
      account_id: string;
      owner_identity: string;
      owner_verified: true;
      provider: "unipile" | "linkedin";
      verified_at: string;
      baseline_cursor?: string;
    }
  | { kind: "quarantined"; reason: string };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_provider_shape");
  return value as Record<string, unknown>;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error("provider_page_limit");
  return value;
}
function token(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 8192 ||
    Array.from(value).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    )
  )
    throw new Error("invalid_provider_cursor");
  return value;
}
function timestamp(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isFinite(new Date(value).getTime())
  )
    throw new Error("invalid_provider_timestamp");
  return value;
}
function exactTime(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value)
    throw new Error("invalid_provider_window");
  return ms;
}
function bounded(
  value: unknown,
  maxNodes = 20000,
  depth = 0,
  budget = { nodes: 0, bytes: 0 },
  seen = new Set<object>(),
): void {
  if (++budget.nodes > maxNodes || depth > 20)
    throw new Error("provider_payload_limit");
  if (typeof value === "string") {
    budget.bytes += Buffer.byteLength(value);
    if (budget.bytes > 4 * 1024 * 1024)
      throw new Error("provider_payload_limit");
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid_provider_number");
  } else if (value && typeof value === "object") {
    if (seen.has(value)) throw new Error("invalid_provider_cycle");
    seen.add(value);
    for (const [key, item] of Object.entries(value)) {
      budget.bytes += Buffer.byteLength(key);
      if (budget.bytes > 4 * 1024 * 1024)
        throw new Error("provider_payload_limit");
      bounded(item, maxNodes, depth + 1, budget, seen);
    }
    seen.delete(value);
  } else if (value !== null && typeof value !== "boolean")
    throw new Error("invalid_provider_value");
}
export function linkedInChangeCursor(processedAt: number): string {
  return `li-change:${timestamp(processedAt)}`;
}
function snapshotStart(cursor: string | null): number {
  if (cursor === null) return 0;
  const match = /^li-snapshot:(0|[1-9]\d*)$/.exec(cursor);
  if (
    !match ||
    !Number.isSafeInteger(Number(match[1])) ||
    Number(match[1]) > 1000000
  )
    throw new Error("invalid_snapshot_cursor");
  return Number(match[1]);
}
function connectionStart(cursor: string | null): number {
  if (cursor === null) return 0;
  const match = /^li-connections:(0|[1-9]\d*)$/.exec(cursor);
  if (
    !match ||
    !Number.isSafeInteger(Number(match[1])) ||
    Number(match[1]) > 1000000
  )
    throw new Error("invalid_connections_cursor");
  return Number(match[1]);
}
function changeStart(cursor: string | null, now: number): number {
  const match =
    cursor === null ? null : /^li-change:(0|[1-9]\d*)$/.exec(cursor);
  if (!match) throw new Error("proven_changelog_watermark_required");
  const ms = timestamp(Number(match[1]));
  if (ms > now || ms < now - 28 * 86400000)
    throw new Error("changelog_retention_gap");
  return ms;
}
/** This plan contains no credential and must run with redirects disabled. */
export function planSocialProviderRead(
  policy: SocialPolicy,
  source: MessagingSource,
  accountId: string,
  state: SourceState,
  phase: SocialReadPhase,
  now: Date,
  limit = 20,
  connectionsCursor: string | null = null,
): ProviderReadPlan | { kind: "webhook_only"; reason: string } {
  const account = socialAccount(policy, source, accountId),
    when = now.getTime();
  if (
    !Number.isFinite(when) ||
    state.source !== source ||
    state.account_id !== accountId ||
    state.mode !== "live" ||
    state.status === "revoked"
  )
    throw new Error("unavailable_social_account");
  if (state.retry_after_until && Date.parse(state.retry_after_until) > when)
    throw new Error("provider_retry_not_due");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250)
    throw new Error("invalid_provider_limit");
  if (!["identity", "snapshot", "changes", "connections"].includes(phase))
    throw new Error("invalid_provider_phase");
  if (phase === "connections" && account.provider !== "linkedin")
    throw new Error("connections_require_linkedin");
  if (phase !== "connections" && connectionsCursor !== null)
    throw new Error("unexpected_connections_cursor");
  if (account.provider === "meta")
    return {
      kind: "webhook_only",
      reason: "official_meta_history_requires_authenticated_webhooks",
    };
  const window =
    phase === "identity"
      ? socialWindow(now)
      : {
          start: state.coverage_start,
          end: state.coverage_end,
        };
  const start = exactTime(window.start),
    end = exactTime(window.end);
  if (
    start > end ||
    end > when ||
    end - start > 30 * 86400000 ||
    end < when - 30 * 86400000
  )
    throw new Error("unapproved_provider_window");
  if (phase !== "identity" && state.cursor !== null) token(state.cursor);
  const base = {
    kind: "request" as const,
    method: "GET" as const,
    follow_redirects: false as const,
    timeout_ms: 5000 as const,
    source,
    account_id: accountId,
    expected_owner_identity: account.owner_identity,
    expected_cursor: phase === "connections" ? connectionsCursor : state.cursor,
    coverage_start: window.start,
    coverage_end: window.end,
    requested_at: now.toISOString(),
  };
  let operation: string,
    response_kind: ProviderReadPlan["response_kind"],
    url: URL,
    count = limit;
  const headers: Record<string, string> = { Accept: "application/json" };
  let page_start: number | undefined, watermark: number | undefined;
  if (account.provider === "unipile") {
    operation =
      phase === "identity" ? "unipile.accounts.get" : "unipile.messages.list";
    response_kind =
      phase === "identity" ? "unipile_account" : "unipile_messages";
    url = new URL(
      phase === "identity"
        ? `/api/v1/accounts/${encodeURIComponent(accountId)}`
        : "/api/v1/messages",
      account.api_base_url,
    );
    if (phase !== "identity") {
      url.searchParams.set("account_id", accountId);
      url.searchParams.set("limit", String(count));
      url.searchParams.set("after", new Date(start - 1).toISOString());
      url.searchParams.set("before", new Date(end + 1).toISOString());
      if (state.cursor !== null) url.searchParams.set("cursor", state.cursor);
    }
  } else {
    headers["Linkedin-Version"] = "202312";
    if (phase === "identity") {
      operation = "linkedin.memberAuthorizations.get";
      response_kind = "linkedin_identity";
      url = new URL(
        "https://api.linkedin.com/rest/memberAuthorizations?q=memberAndApplication",
      );
    } else if (phase === "snapshot" || phase === "connections") {
      operation = "linkedin.memberSnapshotData.get";
      response_kind =
        phase === "connections" ? "linkedin_connections" : "linkedin_snapshot";
      count = 10;
      page_start =
        phase === "connections"
          ? connectionStart(connectionsCursor)
          : snapshotStart(state.cursor);
      url = new URL(
        "https://api.linkedin.com/rest/memberSnapshotData?q=criteria",
      );
      url.searchParams.set(
        "domain",
        phase === "connections" ? "CONNECTIONS" : "INBOX",
      );
      url.searchParams.set("start", String(page_start));
      url.searchParams.set("count", String(count));
    } else {
      operation = "linkedin.memberChangeLogs.get";
      response_kind = "linkedin_changes";
      count = 50;
      watermark = changeStart(state.cursor, when);
      url = new URL(
        "https://api.linkedin.com/rest/memberChangeLogs?q=memberAndApplication",
      );
      url.searchParams.set("startTime", String(watermark));
      url.searchParams.set("count", String(count));
    }
  }
  assertSocialRead(policy, source, accountId, operation);
  return {
    ...base,
    url: url.toString(),
    headers,
    operation,
    response_kind,
    limit: count,
    ...(page_start !== undefined ? { page_start } : {}),
    ...(watermark !== undefined ? { watermark } : {}),
    ...(phase === "connections"
      ? { connections_cursor: connectionsCursor }
      : {}),
  };
}
function pageRequest(
  plan: ProviderReadPlan,
  items: unknown[],
  cursor: string | null,
  complete: boolean,
): SocialSyncRequest {
  return {
    source: plan.source,
    account_id: plan.account_id,
    format:
      plan.response_kind === "unipile_messages"
        ? "unipile_messages"
        : plan.response_kind === "linkedin_changes"
          ? "linkedin_changes"
          : "linkedin_snapshot",
    items,
    cursor,
    expected_cursor: plan.expected_cursor,
    complete,
    coverage_start: plan.coverage_start,
    coverage_end: plan.coverage_end,
    reconcile: plan.response_kind !== "linkedin_changes" && complete,
  };
}
function snapshotNext(
  plan: ProviderReadPlan,
  body: Record<string, unknown>,
): number {
  const paging = object(body.paging),
    start = plan.page_start!;
  if (paging.start !== start || paging.count !== plan.limit)
    throw new Error("snapshot_paging_mismatch");
  let next: number | undefined;
  for (const inputLink of array(paging.links, 10)) {
    const link = object(inputLink);
    if (link.rel !== "next") continue;
    if (next !== undefined) throw new Error("duplicate_next_link");
    const url = new URL(token(link.href), "https://api.linkedin.com");
    if (
      url.origin !== "https://api.linkedin.com" ||
      url.pathname !== "/rest/memberSnapshotData" ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error("unsafe_next_link");
    const allowed = ["q", "domain", "start", "count"];
    if (
      [...url.searchParams.keys()].some(
        (key) =>
          !allowed.includes(key) || url.searchParams.getAll(key).length !== 1,
      ) ||
      url.searchParams.get("q") !== "criteria" ||
      url.searchParams.get("domain") !==
        (plan.response_kind === "linkedin_connections"
          ? "CONNECTIONS"
          : "INBOX") ||
      (url.searchParams.has("count") &&
        url.searchParams.get("count") !== String(plan.limit)) ||
      url.searchParams.get("start") !== String(start + 1)
    )
      throw new Error("unsafe_next_link");
    next = start + 1;
  }
  // LinkedIn says to continue until its explicit no-data error, even without a next link.
  return next ?? start + 1;
}
function connectionPreview(
  plan: ProviderReadPlan,
  inputRows: unknown[],
  next_cursor: string | null,
  complete: boolean,
): ProviderReadMapping {
  const allowed = new Set([
    "First Name",
    "Last Name",
    "Company",
    "Position",
    "Connected On",
  ]);
  let unknown_field_count = 0,
    truncated_value_count = 0;
  const rows = inputRows.slice(0, 20).map((input) => {
    const raw = object(input),
      row: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!allowed.has(key) || typeof value !== "string") {
        unknown_field_count++;
        continue;
      }
      if (Buffer.byteLength(value) > 512) {
        truncated_value_count++;
        let output = "";
        for (const char of value) {
          if (Buffer.byteLength(output + char) > 512) break;
          output += char;
        }
        row[key] = output;
      } else row[key] = value;
    }
    return row;
  });
  return {
    kind: "connections",
    source: "linkedin",
    account_id: plan.account_id,
    owner_identity: plan.expected_owner_identity,
    rows,
    next_cursor,
    complete,
    identity_bindings_verified: false,
    requires_owner_review: true,
    schema_verified: false,
    omitted_row_count: Math.max(0, inputRows.length - 20),
    unknown_field_count,
    truncated_value_count,
  };
}
export function mapSocialProviderResponse(
  plan: ProviderReadPlan,
  status: number,
  body: unknown,
): ProviderReadMapping {
  try {
    bounded(
      body,
      plan.response_kind === "linkedin_connections" ? 100000 : 20000,
    );
    if (
      ["linkedin_snapshot", "linkedin_connections"].includes(
        plan.response_kind,
      ) &&
      [400, 404].includes(status) &&
      (object(body).message === "No data found for this memberId" ||
        (status === 404 &&
          object(body).status === 404 &&
          object(body).message ===
            "No data found for this domain and memberId."))
    ) {
      if (!plan.page_start) throw new Error("snapshot_not_ready");
      return plan.response_kind === "linkedin_connections"
        ? connectionPreview(plan, [], null, true)
        : { kind: "page", request: pageRequest(plan, [], null, true) };
    }
    if (
      plan.response_kind === "unipile_messages" &&
      plan.operation === "unipile.messages.list" &&
      ["whatsapp_personal", "whatsapp_business"].includes(plan.source) &&
      (status === 599 || status === 429)
    ) {
      const reason = object(body).error;
      const allowed =
        status === 429
          ? ["whatsapp_chat_rate_limited"]
          : [
              "whatsapp_chat_response_count",
              "whatsapp_chat_response_budget",
              "whatsapp_chat_transport_failed",
              "whatsapp_chat_http_failed",
              "whatsapp_chat_identity_mismatch",
              "whatsapp_chat_peer_invalid",
              "whatsapp_chat_provider_mismatch",
            ];
      if (typeof reason === "string" && allowed.includes(reason))
        throw new Error(reason);
    }
    if (status !== 200) throw new Error("provider_read_failed");
    const raw = object(body);
    if (plan.response_kind === "unipile_account") {
      if (
        raw.object !== "Account" ||
        raw.type !== "WHATSAPP" ||
        raw.id !== plan.account_id ||
        object(object(raw.connection_params).im).phone_number !==
          plan.expected_owner_identity
      )
        throw new Error("unverified_provider_owner");
      const sources = array(raw.sources, 100);
      if (!sources.length || sources.some((s) => object(s).status !== "OK"))
        throw new Error("provider_account_not_connected");
      return {
        kind: "identity",
        provider: "unipile",
        verified_at: plan.requested_at,
        source: plan.source,
        account_id: plan.account_id,
        owner_identity: plan.expected_owner_identity,
        owner_verified: true,
      };
    }
    if (plan.response_kind === "linkedin_identity") {
      const entries = array(raw.elements, 10);
      if (entries.length !== 1) throw new Error("ambiguous_provider_owner");
      const entry = object(entries[0]);
      if (
        object(entry.memberComplianceAuthorizationKey).member !==
          plan.expected_owner_identity ||
        !array(entry.memberComplianceScopes, 10).includes("DMA")
      )
        throw new Error("unverified_provider_owner");
      const consent = timestamp(entry.regulatedAt);
      if (consent > Date.parse(plan.requested_at))
        throw new Error("invalid_provider_timestamp");
      return {
        kind: "identity",
        provider: "linkedin",
        verified_at: plan.requested_at,
        source: plan.source,
        account_id: plan.account_id,
        owner_identity: plan.expected_owner_identity,
        owner_verified: true,
        baseline_cursor: linkedInChangeCursor(consent),
      };
    }
    if (plan.response_kind === "unipile_messages") {
      if (raw.object !== "MessageList" || !Object.hasOwn(raw, "cursor"))
        throw new Error("invalid_message_list");
      const items = array(raw.items, Math.min(plan.limit, 250));
      if (items.some((m) => object(m).account_id !== plan.account_id))
        throw new Error("foreign_provider_account");
      const next = raw.cursor === null ? null : token(raw.cursor);
      if (next !== null && next === plan.expected_cursor)
        throw new Error("nonadvancing_provider_cursor");
      return {
        kind: "page",
        request: pageRequest(plan, items, next, next === null),
      };
    }
    if (
      plan.response_kind === "linkedin_snapshot" ||
      plan.response_kind === "linkedin_connections"
    ) {
      const elements = array(raw.elements, 1);
      if (
        elements.length !== 1 ||
        object(elements[0]).snapshotDomain !==
          (plan.response_kind === "linkedin_connections"
            ? "CONNECTIONS"
            : "INBOX")
      )
        throw new Error("unexpected_snapshot_domain");
      const items = array(
          object(elements[0]).snapshotData,
          plan.response_kind === "linkedin_connections" ? 10000 : 2000,
        ),
        next = snapshotNext(plan, raw);
      return plan.response_kind === "linkedin_connections"
        ? connectionPreview(plan, items, `li-connections:${next}`, false)
        : {
            kind: "page",
            request: pageRequest(plan, items, `li-snapshot:${next}`, false),
          };
    }
    const events = array(raw.elements, Math.min(plan.limit, 50)),
      items: unknown[] = [];
    let watermark = plan.watermark!,
      unhandled_activity_count = 0;
    for (const inputEvent of events) {
      const event = object(inputEvent);
      if (event.owner !== plan.expected_owner_identity)
        throw new Error("foreign_provider_account");
      const processed = timestamp(event.processedAt);
      if (
        processed < plan.watermark! ||
        processed > Date.parse(plan.requested_at)
      )
        throw new Error("invalid_provider_timestamp");
      watermark = Math.max(watermark, processed);
      if (event.resourceName === "messages") {
        if (event.activityStatus === "FAILURE")
          throw new Error("message_processing_failure");
        items.push(inputEvent);
      } else unhandled_activity_count++;
    }
    if (
      events.length === plan.limit &&
      events.every((event) => object(event).processedAt === plan.watermark)
    )
      throw new Error("changelog_timestamp_tie_requires_reconciliation");
    return {
      kind: "page",
      request: pageRequest(plan, items, linkedInChangeCursor(watermark), false),
      watermark,
      metadata: {
        unhandled_activity_count,
        connection_changelog_supported: false,
        connection_changelog_gap: unhandled_activity_count > 0,
      },
    };
  } catch (error) {
    return {
      kind: "quarantined",
      reason:
        error instanceof Error && /^[a-z_]+$/.test(error.message)
          ? error.message
          : "invalid_provider_response",
    };
  }
}
