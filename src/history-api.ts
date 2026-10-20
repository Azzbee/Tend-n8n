import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";
import type { TendStore, Contact, Identity } from "./engine.ts";
import { isRecord } from "./engine.ts";
import type { LiveStore } from "./live-store.ts";
import {
  allAvailableHistory,
  HISTORY_START,
  type LivePolicy,
} from "./live-policy.ts";
import {
  normalizeGmailMessage,
  normalizeCalendarEvent,
  type LiveRecord,
} from "./google-records.ts";
export interface HistoryResources {
  free_bytes: number;
  database_bytes: number;
  index_bytes: number;
}
interface Options {
  store: TendStore | LiveStore;
  policy: LivePolicy;
  clock?: () => Date;
  resources?: () => Promise<HistoryResources>;
}
export function createHistoryAPI(options: Options) {
  const { store, policy } = options,
    owner = policy.principal_id,
    clock = options.clock ?? (() => new Date());
  let turn = 0;
  const resources =
    options.resources ??
    (async () => {
      const [disk, size] = await Promise.all([
        statfs(process.cwd()),
        store.historyResourceUsage(owner),
      ]);
      return { free_bytes: disk.bavail * disk.bsize, ...size };
    });
  async function gate(): Promise<string | null> {
    const size = await resources();
    if (Object.values(size).some((x) => !Number.isFinite(x) || x < 0))
      throw new Error("History resource measurement unavailable");
    if (size.free_bytes < 2 * 1024 ** 3) return "disk_floor";
    if (size.index_bytes >= 512 * 1024 ** 2) return "index_budget";
    return null;
  }
  const approved = (): void => {
    if (!allAvailableHistory(policy))
      throw new Error("Explicit approved history policy required");
  };
  async function state(
    source: "gmail" | "calendar",
  ): Promise<Record<string, unknown>> {
    approved();
    const states = (await store.sourceStatus(owner)).filter(
      (s) =>
        s.source === source &&
        s.mode === "live" &&
        (source === "gmail"
          ? s.account_id === policy.account_email
          : policy.calendar_ids.includes(s.account_id)),
    );
    if (!states.length) throw new Error("History source unavailable");
    const checkpoints = await store.historyBackfills(owner);
    const candidates = states.filter(
      (s) =>
        !checkpoints.some(
          (c) =>
            c.source === source &&
            c.account_id === s.account_id &&
            c.status === "complete",
        ),
    );
    const selected = candidates[turn++ % candidates.length];
    if (!selected)
      return {
        lane: "history",
        available: false,
        request_allowed: false,
        reason: "history_complete",
      };
    if (selected.status === "revoked")
      return {
        lane: "history",
        available: false,
        request_allowed: false,
        reason: "source_revoked",
      };
    const checkpoint = await store.beginHistoryBackfill(
      owner,
      source,
      selected.account_id,
      clock().toISOString(),
    );
    const blocked = await gate();
    if (blocked)
      await store.pauseHistoryBackfill(
        owner,
        source,
        selected.account_id,
        blocked,
        null,
      );
    const waiting =
      checkpoint.retry_after_until !== null &&
      Date.parse(checkpoint.retry_after_until) > clock().getTime();
    const end = checkpoint.watermark;
    return {
      lane: "history",
      history_version: 1,
      source,
      account_email: policy.account_email,
      ...(source === "calendar" ? { calendar_id: selected.account_id } : {}),
      window_start: HISTORY_START,
      window_end: end,
      watermark: checkpoint.watermark,
      cursor: checkpoint.cursor,
      status: checkpoint.status,
      reconnect_required: false,
      retry_after_until: checkpoint.retry_after_until,
      request_allowed:
        !blocked &&
        !waiting &&
        !checkpoint.last_error?.endsWith("requires_review"),
      reason:
        blocked ??
        (waiting
          ? "provider_retry_not_due"
          : checkpoint.last_error?.endsWith("requires_review")
            ? checkpoint.last_error
            : null),
      page_size: Math.min(
        10,
        policy.limits.max_page_size,
        policy.limits.max_records_per_run,
      ),
      budget: policy.limits,
    };
  }
  async function commit(
    value: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    approved();
    if (
      value.lane !== "history" ||
      value.history_version !== 1 ||
      !["gmail", "calendar"].includes(String(value.source)) ||
      value.account_email !== policy.account_email ||
      value.profile_account_email !== policy.account_email
    )
      throw new Error("Verified history account required");
    const source = value.source as "gmail" | "calendar";
    const account =
      source === "gmail" ? policy.account_email : value.calendar_id;
    if (
      typeof account !== "string" ||
      (source === "calendar" && !policy.calendar_ids.includes(account))
    )
      throw new Error("Unapproved history calendar");
    const state = (await store.sourceStatus(owner)).find(
      (s) =>
        s.source === source && s.account_id === account && s.mode === "live",
    );
    if (!state || state.status === "revoked")
      throw new Error("History source revoked or unavailable");
    const checkpoint = (await store.historyBackfills(owner)).find(
      (c) => c.source === source && c.account_id === account,
    );
    const end = checkpoint && checkpoint.watermark;
    const operation_hash = createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex");
    if (
      checkpoint &&
      value.watermark === checkpoint.watermark &&
      value.window_start === HISTORY_START &&
      value.window_end === end &&
      checkpoint.last_request_hash === operation_hash
    )
      return {
        accepted: 0,
        replayed: true,
        lane: "history",
        complete: checkpoint.status === "complete",
        outbound_sent: false,
      };
    if (
      !checkpoint ||
      value.watermark !== checkpoint.watermark ||
      value.window_start !== HISTORY_START ||
      value.window_end !== end ||
      value.previous_cursor !== checkpoint.cursor ||
      typeof value.complete !== "boolean" ||
      (value.advance !== undefined && typeof value.advance !== "boolean") ||
      (value.advance === false &&
        (value.cursor !== value.previous_cursor || value.complete)) ||
      !(value.cursor === null || typeof value.cursor === "string") ||
      (value.complete && value.cursor !== null) ||
      !Array.isArray(value.records) ||
      value.records.length > Math.min(10, policy.limits.max_records_per_run) ||
      Buffer.byteLength(JSON.stringify(value)) > policy.limits.max_body_bytes
    )
      throw new Error("Invalid or stale history page");
    const blocked = await gate();
    if (blocked) {
      await store.pauseHistoryBackfill(owner, source, account, blocked, null);
      return { accepted: 0, paused: true, reason: blocked };
    }
    const records: LiveRecord[] = [],
      contacts: Contact[] = [],
      identities: Identity[] = [],
      removed: string[] = [];
    let quarantined = 0;
    for (const raw of value.records) {
      const context = {
        policy,
        now: new Date(checkpoint.watermark),
        account_email: policy.account_email,
        ...(source === "calendar" ? { calendar_id: account } : {}),
      };
      const result =
        source === "gmail"
          ? normalizeGmailMessage(raw, context)
          : normalizeCalendarEvent(raw, context);
      if (result.kind === "accepted") {
        records.push({
          ...result.record,
          observed_at: clock().toISOString(),
          coverage_start: HISTORY_START,
          coverage_end: end!,
        });
        contacts.push(...result.contacts);
        identities.push(...result.identities);
      } else if (result.kind === "quarantined") quarantined++;
      else if (isRecord(raw) && raw.status === "cancelled")
        removed.push(result.source_record_id);
    }
    if (quarantined) {
      await store.pauseHistoryBackfill(
        owner,
        source,
        account,
        "history_page_requires_review",
        null,
      );
      return {
        accepted: 0,
        quarantined,
        paused: true,
        complete: false,
        reason: "history_page_requires_review",
        outbound_sent: false,
      };
    }
    await store.commitHistoryBackfill({
      owner_id: owner,
      source,
      account_id: account,
      version: 1,
      watermark: checkpoint.watermark,
      expected_cursor: checkpoint.cursor,
      cursor: value.cursor as string | null,
      operation_hash,
      complete: value.complete,
      ...(value.advance !== undefined
        ? { advance: value.advance as boolean }
        : {}),
      records,
      contacts,
      identities,
      removed_record_ids: removed,
      withdrawals_observed_at: clock().toISOString(),
    });
    return {
      accepted: records.length,
      quarantined,
      lane: "history",
      complete: value.complete,
      outbound_sent: false,
    };
  }
  async function error(
    value: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    approved();
    const source = value.source;
    const account =
      source === "gmail" ? policy.account_email : value.calendar_id;
    if (
      !["gmail", "calendar"].includes(String(source)) ||
      typeof account !== "string" ||
      (source === "calendar" && !policy.calendar_ids.includes(account)) ||
      !Number.isInteger(value.status_code) ||
      typeof value.status_code !== "number" ||
      value.status_code < 100 ||
      value.status_code > 599
    )
      throw new Error("Invalid history failure");
    const seconds =
      typeof value.retry_after_seconds === "number" &&
      Number.isFinite(value.retry_after_seconds)
        ? Math.max(60, value.retry_after_seconds)
        : 60;
    const retryAt = clock().getTime() + seconds * 1000;
    const representable =
      Number.isFinite(retryAt) && retryAt <= 8640000000000000;
    await store.pauseHistoryBackfill(
      owner,
      source as "gmail" | "calendar",
      account,
      representable
        ? "provider_" + value.status_code
        : "provider_wait_requires_review",
      representable ? new Date(retryAt).toISOString() : null,
    );
    const revoked =
      value.reconnect_required === true ||
      value.status_code === 401 ||
      value.status_code === 403;
    if (revoked)
      await store.revokeSource(owner, source as "gmail" | "calendar");
    return { recorded: true, lane: "history", reconnect_required: revoked };
  }
  return { state, commit, error, gate };
}
