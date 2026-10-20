import type { TendStore, StoreOptions } from "./engine.ts";
import type { Source, Contact, Identity } from "./engine.ts";
import type { LiveRecord } from "./google-records.ts";
export interface HistoryCheckpoint {
  owner_id: string;
  source: Source;
  account_id: string;
  version: 1;
  watermark: string;
  cursor: string | null;
  page_count: number;
  record_count: number;
  oldest_at: string | null;
  newest_at: string | null;
  status: "pending" | "running" | "paused" | "complete";
  retry_after_until: string | null;
  last_error: string | null;
  last_operation_hash: string | null;
  last_request_hash: string | null;
  updated_at: string;
}
export interface HistoryPageCommit {
  owner_id: string;
  source: Source;
  account_id: string;
  version: 1;
  watermark: string;
  expected_cursor: string | null;
  cursor: string | null;
  operation_hash: string;
  complete: boolean;
  records: LiveRecord[];
  removed_record_ids?: string[];
  contacts?: Contact[];
  identities?: Identity[];
}
export type Principal = NonNullable<StoreOptions["principal"]>;
export type LiveStoreMethod =
  | "seed"
  | "counts"
  | "telegramDeliveryCounts"
  | "ingest"
  | "commitLiveBatch"
  | "prepareLiveSnapshot"
  | "reconnectLiveSource"
  | "markLiveSyncError"
  | "expireLiveEvidence"
  | "quarantineCount"
  | "cachedReplyText"
  | "validatePreparedRead"
  | "privateContacts"
  | "privateHistory"
  | "beginHistoryBackfill"
  | "historyBackfills"
  | "historyResourceUsage"
  | "commitHistoryBackfill"
  | "pauseHistoryBackfill"
  | "dailyBriefingGet"
  | "dailyBriefingLatest"
  | "dailyBriefingInsert"
  | "dailyBriefingReplace"
  | "contacts"
  | "sourceStatus"
  | "interactions"
  | "originalMessageTimes"
  | "extractionAttempted"
  | "markExtractionAttempt"
  | "extractionReviewCount"
  | "resolveContact"
  | "addCandidate"
  | "commitments"
  | "revokeSource"
  | "command"
  | "telegramCommand"
  | "commitTelegramReply"
  | "pendingTelegramReply"
  | "acknowledgeTelegramReply"
  | "close";
export type LiveStore = {
  [K in LiveStoreMethod]: TendStore[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<R>
    : never;
};
