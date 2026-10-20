import { randomUUID } from "node:crypto";
import { isRecord, type TendStore, type SourceState } from "./engine.ts";
import type { LiveStore } from "./live-store.ts";
import {
  parseSocialPolicy,
  allAvailableHistory,
  HISTORY_START,
  socialAccount,
  socialWindow,
  type SocialPolicy,
} from "./social-policy.ts";
import {
  planSocialProviderRead,
  mapSocialProviderResponse,
  type ProviderReadPlan,
  type ProviderReadMapping,
  type SocialReadPhase,
} from "./social-provider-reads.ts";
import type { MessagingSource } from "./messaging-records.ts";
import { normalizeSocialBatch } from "./social-sync.ts";
import { handleSocialSync } from "./social-api.ts";
interface Options {
  historyResourceGate?: () => Promise<string | null>;
  policy: SocialPolicy;
  store: TendStore | LiveStore;
  principal_id: string;
  clock?: () => Date;
}
interface Proof {
  source: MessagingSource;
  account_id: string;
  provider: string;
  expires_at: number;
  baseline_cursor?: string;
  connections_cursor?: string | null;
  connections_complete?: boolean;
}
interface Pending {
  lane?: "history";
  plan: ProviderReadPlan;
  proof_id?: string;
  expires_at: number;
}
export type SocialReadInput =
  | { available: true; request_id: string; plan: ProviderReadPlan }
  | { available: false; reason: string };
export type SocialReadResult =
  | { kind: "blocked"; reason: string }
  | {
      kind: "identity";
      proof_id: string;
      source: MessagingSource;
      account_id: string;
      verified_at: string;
      expires_at: string;
    }
  | (Omit<
      Extract<ProviderReadMapping, { kind: "connections" }>,
      "owner_identity" | "next_cursor"
    > & { transient: true; expires_at: string })
  | ({
      kind: "page";
      gap_free: false;
      metadata?: Extract<ProviderReadMapping, { kind: "page" }>["metadata"];
    } & Awaited<ReturnType<typeof handleSocialSync>>);
function allowed(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((k) => !keys.includes(k)))
    throw new Error("unknown_social_session_field");
}
function selector(value: unknown): {
  source: MessagingSource;
  account_id: string;
  phase: SocialReadPhase;
  lane?: "history";
  proof_id?: string;
} {
  if (!isRecord(value)) throw new Error("invalid_social_selector");
  allowed(value, ["source", "account_id", "phase", "proof_id", "lane"]);
  if (value.lane !== undefined && value.lane !== "history")
    throw new Error("invalid_history_lane");
  if (
    !["whatsapp_personal", "whatsapp_business", "linkedin"].includes(
      String(value.source),
    ) ||
    typeof value.account_id !== "string" ||
    !["identity", "snapshot", "changes", "connections"].includes(
      String(value.phase),
    )
  )
    throw new Error("invalid_social_selector");
  if (value.phase === "identity" && value.proof_id !== undefined)
    throw new Error("identity_read_cannot_supply_proof");
  if (
    value.phase !== "identity" &&
    (typeof value.proof_id !== "string" || value.proof_id.length > 80)
  )
    throw new Error("fresh_identity_proof_required");
  return {
    source: value.source as MessagingSource,
    account_id: value.account_id,
    phase: value.phase as SocialReadPhase,
    ...(value.lane === "history" ? { lane: "history" as const } : {}),
    ...(typeof value.proof_id === "string" ? { proof_id: value.proof_id } : {}),
  };
}
function reason(error: unknown): string {
  return error instanceof Error && /^[a-z_]{1,100}$/.test(error.message)
    ? error.message
    : "social_read_state_changed_or_unavailable";
}
export class SocialReadSessions {
  private readonly policy: SocialPolicy;
  private readonly historyResourceGate:
    (() => Promise<string | null>) | undefined;
  private readonly store: TendStore | LiveStore;
  private readonly principal: string;
  private readonly clock: () => Date;
  private planning = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly proofs = new Map<string, Proof>();
  constructor(options: Options) {
    this.policy = parseSocialPolicy(options.policy)!;
    this.historyResourceGate = options.historyResourceGate;
    this.store = options.store;
    this.principal = options.principal_id;
    this.clock = options.clock ?? (() => new Date());
  }
  private async checkHistoryResources(
    source: MessagingSource,
    account: string,
  ): Promise<void> {
    let blocked: string | null;
    try {
      blocked = this.historyResourceGate
        ? await this.historyResourceGate()
        : "history_resource_gate_required";
    } catch {
      blocked = "history_resource_measurement_unavailable";
    }
    if (blocked !== null) {
      const code = /^[a-z0-9_:-]{1,120}$/.test(blocked)
        ? blocked
        : "history_resource_measurement_unavailable";
      await this.store.pauseHistoryBackfill(
        this.principal,
        source,
        account,
        code,
        null,
        true,
      );
      throw new Error(code);
    }
  }
  private clean(now: number): void {
    if (!Number.isFinite(now)) throw new Error("invalid_social_clock");
    for (const [id, p] of this.pending)
      if (p.expires_at <= now) this.pending.delete(id);
    for (const [id, p] of this.proofs)
      if (p.expires_at <= now) this.proofs.delete(id);
  }
  private async state(
    source: MessagingSource,
    account_id: string,
  ): Promise<SourceState> {
    const state = (await this.store.sourceStatus(this.principal)).find(
      (s) => s.source === source && s.account_id === account_id,
    );
    if (!state || state.mode !== "live" || state.status === "revoked")
      throw new Error("unavailable_social_account");
    return state;
  }
  private proof(
    id: string | undefined,
    source: MessagingSource,
    account_id: string,
    provider: string,
  ): Proof {
    const proof = id ? this.proofs.get(id) : undefined;
    if (
      !proof ||
      proof.source !== source ||
      proof.account_id !== account_id ||
      proof.provider !== provider
    )
      throw new Error("fresh_identity_proof_required");
    return proof;
  }
  async plan(input: unknown): Promise<SocialReadInput> {
    let reserved = false;
    try {
      const now = this.clock();
      this.clean(now.getTime());
      if (this.pending.size + this.planning >= 32)
        return { available: false, reason: "social_read_capacity_reached" };
      this.planning++;
      reserved = true;
      const selected = selector(input),
        account = socialAccount(
          this.policy,
          selected.source,
          selected.account_id,
        );
      if (
        selected.lane === "history" &&
        (!allAvailableHistory(this.policy) ||
          !["snapshot", "identity"].includes(selected.phase))
      )
        throw new Error("unapproved_history_operation");
      let state = await this.state(selected.source, selected.account_id);
      const verified =
        selected.phase === "identity"
          ? undefined
          : this.proof(
              selected.proof_id,
              selected.source,
              selected.account_id,
              account.provider,
            );
      if (selected.lane === "history" && selected.phase !== "identity") {
        const checkpoint = await this.store.beginHistoryBackfill(
          this.principal,
          selected.source,
          selected.account_id,
          now.toISOString(),
        );
        if (checkpoint.status === "complete")
          throw new Error("history_backfill_complete");
        if (
          checkpoint.status === "paused" &&
          checkpoint.last_error === "history_page_requires_review"
        )
          throw new Error("history_page_requires_review");
        if (
          checkpoint.retry_after_until &&
          Date.parse(checkpoint.retry_after_until) > now.getTime()
        )
          throw new Error("provider_retry_not_due");
        await this.checkHistoryResources(selected.source, selected.account_id);
        state = {
          ...state,
          status: "partial",
          coverage_start: HISTORY_START,
          coverage_end: checkpoint.watermark,
          cursor: checkpoint.cursor,
        };
      }
      if (selected.phase !== "identity" && selected.lane !== "history") {
        const proof = this.proof(
          selected.proof_id,
          selected.source,
          selected.account_id,
          account.provider,
        );
        if (selected.phase === "connections") {
          if (selected.source !== "linkedin")
            throw new Error("connections_require_linkedin");
          if (proof.connections_complete)
            throw new Error("connections_preview_complete");
        } else if (
          selected.source === "linkedin" &&
          selected.phase === "changes"
        ) {
          let resume: string;
          if (state.cursor?.startsWith("li-change:")) resume = state.cursor;
          else if (
            (state.status === "current" ||
              (state.status === "partial" &&
                state.pagination_complete === true)) &&
            state.cursor === null &&
            proof.baseline_cursor
          )
            resume = proof.baseline_cursor;
          else throw new Error("completed_snapshot_required_before_changes");
          const window = socialWindow(now),
            projected = {
              ...state,
              status: "partial",
              cursor: resume,
              coverage_start: window.start,
              coverage_end: window.end,
            };
          planSocialProviderRead(
            this.policy,
            selected.source,
            selected.account_id,
            projected,
            selected.phase,
            now,
          );
          state = await this.store.prepareLiveSnapshot(
            this.principal,
            selected.source,
            selected.account_id,
            window.start,
            window.end,
            resume,
          );
        } else {
          if (
            selected.source === "linkedin" &&
            state.cursor?.startsWith("li-change:")
          )
            throw new Error("changelog_cannot_reset_to_snapshot");
          if (
            state.status === "current" ||
            state.pagination_complete === true
          ) {
            const window = socialWindow(now);
            state = await this.store.prepareLiveSnapshot(
              this.principal,
              selected.source,
              selected.account_id,
              window.start,
              window.end,
            );
          } else if (
            Date.parse(state.coverage_end) <
            now.getTime() - 30 * 86400000
          ) {
            const window = socialWindow(now);
            await this.store.reconnectLiveSource(
              this.principal,
              selected.source,
              selected.account_id,
              window.start,
              window.end,
              true,
            );
            state = await this.state(selected.source, selected.account_id);
          }
        }
      }
      const plan = planSocialProviderRead(
        this.policy,
        selected.source,
        selected.account_id,
        state,
        selected.phase,
        now,
        20,
        selected.phase === "connections"
          ? (verified?.connections_cursor ?? null)
          : null,
      );
      if (plan.kind === "webhook_only")
        return { available: false, reason: plan.reason };
      const request_id = randomUUID();
      this.pending.set(request_id, {
        plan,
        ...(selected.lane ? { lane: selected.lane } : {}),
        expires_at: now.getTime() + 120000,
        ...(selected.proof_id ? { proof_id: selected.proof_id } : {}),
      });
      return { available: true, request_id, plan: structuredClone(plan) };
    } catch (error) {
      return { available: false, reason: reason(error) };
    } finally {
      if (reserved) this.planning--;
    }
  }
  async result(input: unknown): Promise<SocialReadResult> {
    try {
      const now = this.clock();
      this.clean(now.getTime());
      if (!isRecord(input)) throw new Error("invalid_social_result");
      allowed(input, ["request_id", "status", "body", "headers"]);
      let retryAfter: string | undefined;
      if (input.headers !== undefined) {
        if (
          !isRecord(input.headers) ||
          Object.keys(input.headers).length > 1 ||
          Object.entries(input.headers).some(
            ([key, value]) =>
              key.toLowerCase() !== "retry-after" ||
              typeof value !== "string" ||
              value.length > 128,
          )
        )
          throw new Error("invalid_retry_header");
        retryAfter = Object.values(input.headers)[0] as string | undefined;
      }
      if (
        typeof input.request_id !== "string" ||
        !Number.isInteger(input.status) ||
        typeof input.status !== "number" ||
        input.status < 100 ||
        input.status > 599 ||
        !Object.hasOwn(input, "body")
      )
        throw new Error("invalid_social_result");
      const pending = this.pending.get(input.request_id);
      if (!pending) throw new Error("social_request_expired_or_consumed");
      this.pending.delete(input.request_id);
      const account = socialAccount(
        this.policy,
        pending.plan.source,
        pending.plan.account_id,
      );
      await this.state(account.source, account.account_id);
      const isIdentity = ["unipile_account", "linkedin_identity"].includes(
        pending.plan.response_kind,
      );
      if (!isIdentity)
        this.proof(
          pending.proof_id,
          account.source,
          account.account_id,
          account.provider,
        );
      const mapped = mapSocialProviderResponse(
        pending.plan,
        input.status,
        input.body,
      );
      if (mapped.kind === "quarantined") {
        if (input.status === 401 || input.status === 403) {
          await this.store.revokeSource(this.principal, account.source);
          for (const [id, proof] of this.proofs)
            if (
              proof.source === account.source &&
              proof.account_id === account.account_id
            )
              this.proofs.delete(id);
        } else {
          const state = await this.state(account.source, account.account_id);
          const parsed =
            retryAfter === undefined
              ? NaN
              : /^\d+$/.test(retryAfter)
                ? Number(retryAfter)
                : Math.ceil((Date.parse(retryAfter) - now.getTime()) / 1000);
          const seconds = Number.isFinite(parsed)
            ? Math.min(86400, Math.max(1, parsed))
            : Math.min(8, 2 ** Math.min(3, state.attempt_count ?? 0));
          if (pending.lane === "history")
            await this.store.pauseHistoryBackfill(
              this.principal,
              account.source,
              account.account_id,
              mapped.reason,
              new Date(now.getTime() + seconds * 1000).toISOString(),
            );
          else
            await this.store.markLiveSyncError(
              this.principal,
              account.source,
              account.account_id,
              false,
              new Date(now.getTime() + seconds * 1000).toISOString(),
              input.status === 200 ? 599 : input.status,
            );
        }
        return { kind: "blocked", reason: mapped.reason };
      }
      if (mapped.kind === "identity") {
        if (this.proofs.size >= 32)
          throw new Error("identity_proof_capacity_reached");
        const expires_at = Date.parse(mapped.verified_at) + 300000;
        if (expires_at <= now.getTime())
          throw new Error("identity_proof_expired");
        const proof_id = randomUUID();
        this.proofs.set(proof_id, {
          source: mapped.source,
          account_id: mapped.account_id,
          provider: mapped.provider,
          expires_at,
          ...(mapped.baseline_cursor
            ? { baseline_cursor: mapped.baseline_cursor }
            : {}),
        });
        return {
          kind: "identity",
          proof_id,
          source: mapped.source,
          account_id: mapped.account_id,
          verified_at: mapped.verified_at,
          expires_at: new Date(expires_at).toISOString(),
        };
      }
      if (mapped.kind === "connections") {
        const verified = this.proof(
          pending.proof_id,
          account.source,
          account.account_id,
          account.provider,
        );
        if (
          (verified.connections_cursor ?? null) !== pending.plan.expected_cursor
        )
          throw new Error("stale_connections_preview_cursor");
        verified.connections_cursor = mapped.next_cursor;
        verified.connections_complete = mapped.complete;
        return {
          kind: "connections",
          source: mapped.source,
          account_id: mapped.account_id,
          rows: mapped.rows,
          complete: mapped.complete,
          identity_bindings_verified: false,
          requires_owner_review: true,
          schema_verified: false,
          omitted_row_count: mapped.omitted_row_count,
          unknown_field_count: mapped.unknown_field_count,
          truncated_value_count: mapped.truncated_value_count,
          transient: true,
          expires_at: new Date(verified.expires_at).toISOString(),
        };
      }
      if (pending.lane === "history") {
        const original_message_times = await this.store.originalMessageTimes(
          this.principal,
          account.source,
          account.account_id,
        );
        const normalized = normalizeSocialBatch(this.policy, mapped.request, {
          history_watermark: pending.plan.coverage_end,
          principal_id: this.principal,
          now,
          authenticated: {
            provider: account.provider,
            account_id: account.account_id,
          },
          original_message_times,
        });
        const removed = [
          ...new Set([
            ...(normalized.batch.removed_record_ids ?? []),
            ...normalized.invalidated_record_ids,
          ]),
        ];
        try {
          await this.checkHistoryResources(account.source, account.account_id);
        } catch (error) {
          if (removed.length) {
            const paused = (
              await this.store.historyBackfills(this.principal)
            ).find(
              (checkpoint) =>
                checkpoint.source === account.source &&
                checkpoint.account_id === account.account_id,
            );
            if (
              !paused ||
              paused.status !== "paused" ||
              paused.last_error === null
            )
              throw error;
            await this.store.commitHistoryBackfill({
              owner_id: this.principal,
              source: account.source,
              account_id: account.account_id,
              version: 1,
              watermark: pending.plan.coverage_end,
              expected_cursor: pending.plan.expected_cursor,
              cursor: pending.plan.expected_cursor,
              advance: false,
              operation_hash: normalized.page_hash,
              complete: false,
              records: [],
              removed_record_ids: removed,
              withdrawals_observed_at: now.toISOString(),
            });
          }
          throw error;
        }
        if (normalized.batch.evidence_incomplete) {
          if (removed.length) {
            await this.store.commitHistoryBackfill({
              owner_id: this.principal,
              source: account.source,
              account_id: account.account_id,
              version: 1,
              watermark: pending.plan.coverage_end,
              expected_cursor: pending.plan.expected_cursor,
              cursor: pending.plan.expected_cursor,
              advance: false,
              operation_hash: normalized.page_hash,
              complete: false,
              records: [],
              removed_record_ids: removed,
              withdrawals_observed_at: now.toISOString(),
            });
          }
          await this.store.pauseHistoryBackfill(
            this.principal,
            account.source,
            account.account_id,
            "history_page_requires_review",
            null,
          );
          throw new Error("history_page_requires_review");
        }
        const historicalRecords = normalized.batch.records
          .filter(
            (record) =>
              Date.parse(record.occurred_at) <=
              Date.parse(pending.plan.coverage_end),
          )
          .map((record) => ({ ...record, observed_at: now.toISOString() }));
        const historicalContacts = new Set([
          "OWNER",
          ...historicalRecords.flatMap((record) => record.contact_ids),
        ]);
        const historicalIdentities = new Set(
          historicalRecords.flatMap((record) => [
            record.actor_identity,
            ...record.participant_identities,
          ]),
        );
        const accepted = await this.store.commitHistoryBackfill({
          owner_id: this.principal,
          source: account.source,
          account_id: account.account_id,
          version: 1,
          watermark: pending.plan.coverage_end,
          expected_cursor: pending.plan.expected_cursor,
          cursor: normalized.batch.cursor,
          operation_hash: normalized.page_hash,
          complete: normalized.batch.complete,
          records: historicalRecords,
          removed_record_ids: removed,
          withdrawals_observed_at: now.toISOString(),
          ...(normalized.batch.contacts
            ? {
                contacts: normalized.batch.contacts.filter((contact) =>
                  historicalContacts.has(contact.contact_id),
                ),
              }
            : {}),
          ...(normalized.batch.identities
            ? {
                identities: normalized.batch.identities.filter((identity) =>
                  historicalIdentities.has(identity.identity),
                ),
              }
            : {}),
        });
        return {
          kind: "page",
          gap_free: false,
          source: account.source,
          accepted: accepted.length,
          quarantined: 0,
          removed: removed.length,
          complete: normalized.batch.complete,
          pagination_complete: normalized.batch.complete,
          evidence_partial: false,
          status: normalized.batch.complete ? "current" : "partial",
          page_hash: normalized.page_hash,
          ...(mapped.metadata ? { metadata: mapped.metadata } : {}),
        };
      }
      const receipt = await handleSocialSync({
        policy: this.policy,
        store: this.store,
        principal_id: this.principal,
        now,
        request: mapped.request,
      });
      return {
        kind: "page",
        gap_free: false,
        ...receipt,
        ...(mapped.metadata ? { metadata: mapped.metadata } : {}),
      };
    } catch (error) {
      return { kind: "blocked", reason: reason(error) };
    }
  }
}
