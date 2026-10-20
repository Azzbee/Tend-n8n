import type { TendStore, StoreOptions } from "./engine.ts";
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
