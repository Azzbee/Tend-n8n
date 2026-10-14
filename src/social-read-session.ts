import { randomUUID } from "node:crypto";
import { isRecord, type TendStore, type SourceState } from "./engine.ts";
import type { LiveStore } from "./live-store.ts";
import {
  parseSocialPolicy,
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
import { handleSocialSync } from "./social-api.ts";
interface Options {
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
  proof_id?: string;
} {
  if (!isRecord(value)) throw new Error("invalid_social_selector");
  allowed(value, ["source", "account_id", "phase", "proof_id"]);
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
  private readonly store: TendStore | LiveStore;
  private readonly principal: string;
  private readonly clock: () => Date;
  private planning = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly proofs = new Map<string, Proof>();
  constructor(options: Options) {
    this.policy = parseSocialPolicy(options.policy)!;
    this.store = options.store;
    this.principal = options.principal_id;
    this.clock = options.clock ?? (() => new Date());
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
      if (selected.phase !== "identity") {
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
            state.status === "current" &&
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
          if (state.status === "current") {
            const window = socialWindow(now);
            state = await this.store.prepareLiveSnapshot(
              this.principal,
              selected.source,
              selected.account_id,
              window.start,
              window.end,
            );
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
