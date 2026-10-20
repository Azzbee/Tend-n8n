import type {
  Contact,
  NormalizedRecord,
  SourceState,
  Commitment,
  Reply,
  Source,
} from "./engine.ts";
export interface PrivateSessionResponse {
  unlocked: true;
  csrf: string;
  expires_at: string;
}
export interface PrivateContactActivity {
  count: number;
  last_at: string | null;
  sources: Source[];
}
export interface PrivateContactsResponse {
  contacts: (Contact & {
    emails: string[];
    verified_group?: boolean;
    provenance?: string;
    activity?: PrivateContactActivity;
  })[];
  next_cursor: string | null;
}
export interface PrivateHistoryResponse {
  records: NormalizedRecord[];
  next_cursor: string | null;
  total: number;
  sources: SourceState[];
  commitments: Commitment[];
}
export interface PrivateSearchResponse {
  records: NormalizedRecord[];
  matches?: {
    record_key: string;
    start: number;
    end: number;
    text: string;
    similarity: number;
  }[];
  mode: "keyword" | "semantic";
  coverage?: unknown;
  warning?: string;
}
export interface PrivateViewResponse {
  view_id: string;
  reply?: Reply;
  checked_at: string;
  expires_at: string;
  valid?: boolean;
}
export type PrivateSemanticSearch = (input: {
  query: string;
  selector?: string;
}) => Promise<PrivateSearchResponse>;
export interface PrivateHistoryQuery {
  contact_ids: string[];
  terms?: string[];
  activity_for?: {
    selector: string;
    contact_ids: string[];
    members?: { source: string; account_id: string; contact_id: string }[];
  }[];
  members?: { source: string; account_id: string; contact_id: string }[];
  snapshots?: { calendar_id: string; event_id: string }[];
  accounts: { source: string; account_id: string }[];
  now: string;
  message_start: string;
  calendar_start?: string;
  calendar_end: string;
  source?: string;
  direction?: string;
  from?: string;
  to?: string;
  after?: { occurred_at: string; record_key: string };
  limit: number;
}
export interface PrivateHistoryPage {
  records: NormalizedRecord[];
  total: number;
  revision: string;
  activity?: Record<string, PrivateContactActivity>;
}
