import { isRecord, type TendStore } from "./engine.ts";
import type { LiveStore } from "./live-store.ts";
import { socialAccount, type SocialPolicy } from "./social-policy.ts";
import { normalizeSocialBatch, type SocialSyncRequest } from "./social-sync.ts";
import type { MessagingSource } from "./messaging-records.ts";
export interface SocialSyncOptions {
  policy: SocialPolicy;
  store: TendStore | LiveStore;
  principal_id: string;
  now: Date;
  request: unknown;
}
/** Only the authenticated internal route may assert a provider response here. */
export async function handleSocialSync({
  policy,
  store,
  principal_id,
  now,
  request,
}: SocialSyncOptions): Promise<{
  source: MessagingSource;
  accepted: number;
  quarantined: number;
  removed: number;
  complete: boolean;
  pagination_complete: boolean;
  evidence_partial: boolean;
  status: string;
  page_hash: string;
}> {
  if (
    !isRecord(request) ||
    !["whatsapp_personal", "whatsapp_business", "linkedin"].includes(
      String(request.source),
    ) ||
    typeof request.account_id !== "string"
  )
    throw new Error("invalid social account selector");
  const source = request.source as MessagingSource,
    account = socialAccount(policy, source, request.account_id);
  const state = (await store.sourceStatus(principal_id)).find(
    (s) => s.source === source && s.account_id === account.account_id,
  );
  if (!state || state.mode !== "live")
    throw new Error("unregistered live social account");
  if (state.status === "revoked")
    throw new Error("social source revoked; explicit reconnect required");
  if (
    request.coverage_start !== state.coverage_start ||
    request.coverage_end !== state.coverage_end
  )
    throw new Error("stale social sync window");
  const original_message_times = await store.originalMessageTimes(
    principal_id,
    source,
    account.account_id,
  );
  const normalized = normalizeSocialBatch(
    policy,
    request as unknown as SocialSyncRequest,
    {
      principal_id,
      now,
      authenticated: {
        provider: account.provider,
        account_id: account.account_id,
      },
      original_message_times,
    },
  );
  normalized.batch.operation_hash = normalized.page_hash;
  normalized.batch.removed_record_ids = [
    ...new Set([
      ...(normalized.batch.removed_record_ids ?? []),
      ...normalized.invalidated_record_ids,
    ]),
  ].sort();
  const accepted = await store.commitLiveBatch(normalized.batch);
  const current = (await store.sourceStatus(principal_id)).find(
    (s) => s.source === source && s.account_id === account.account_id,
  );
  return {
    source,
    accepted: accepted.length,
    quarantined: normalized.batch.quarantines?.length ?? 0,
    removed: normalized.batch.removed_record_ids.length,
    complete: normalized.batch.complete && current?.status === "current",
    pagination_complete: current?.pagination_complete === true,
    evidence_partial: current?.evidence_incomplete === true,
    status: current?.status ?? "unavailable",
    page_hash: normalized.page_hash,
  };
}
