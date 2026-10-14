CREATE TABLE IF NOT EXISTS live_runtime_principal (
 owner_id text PRIMARY KEY, user_id text NOT NULL, chat_id text NOT NULL,
 CHECK(length(owner_id)>0 AND length(user_id)>0 AND length(chat_id)>0)
);
CREATE TABLE IF NOT EXISTS live_contacts (
 owner_id text NOT NULL REFERENCES live_runtime_principal, contact_id text NOT NULL, name text NOT NULL,
 PRIMARY KEY(owner_id,contact_id)
);
CREATE TABLE IF NOT EXISTS live_identities (
 owner_id text NOT NULL REFERENCES live_runtime_principal, identity text NOT NULL, contact_id text NOT NULL,
 PRIMARY KEY(owner_id,identity)
);
CREATE TABLE IF NOT EXISTS live_accounts (
 owner_id text NOT NULL REFERENCES live_runtime_principal, source text NOT NULL CHECK(source IN ('gmail','calendar','whatsapp_personal','whatsapp_business','linkedin')),
 account_id text NOT NULL, state jsonb NOT NULL,
 PRIMARY KEY(owner_id,source,account_id),
 CHECK(state->>'owner_id'=owner_id AND state->>'source'=source AND state->>'account_id'=account_id)
);
CREATE TABLE IF NOT EXISTS live_records (
 owner_id text NOT NULL REFERENCES live_runtime_principal, record_key text NOT NULL, source text NOT NULL, account_id text NOT NULL,
 source_record_id text NOT NULL, source_thread_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('message','meeting')),
 direction text NOT NULL CHECK(direction IN ('sent','received','event')), actor_identity text NOT NULL,
 participant_identities text[] NOT NULL, occurred_at text NOT NULL, observed_at text NOT NULL, body_text text NOT NULL,
 evidence_reference text NOT NULL, ingestion_mode text NOT NULL CHECK(ingestion_mode='live'), coverage_start text NOT NULL, coverage_end text NOT NULL,
 cancelled boolean NOT NULL, contact_id text, content_hash text NOT NULL, contact_ids text[] NOT NULL,
 authored_text text NOT NULL, authored_spans jsonb NOT NULL, attribution text NOT NULL, eligible_for_extraction boolean NOT NULL,
 end_at text, all_day boolean,
 PRIMARY KEY(owner_id,record_key), UNIQUE(owner_id,source,account_id,source_record_id),
 FOREIGN KEY(owner_id,source,account_id) REFERENCES live_accounts
);
CREATE TABLE IF NOT EXISTS live_interaction_contacts (
 owner_id text NOT NULL, record_key text NOT NULL, contact_id text NOT NULL,
 PRIMARY KEY(owner_id,record_key,contact_id), FOREIGN KEY(owner_id,record_key) REFERENCES live_records ON DELETE CASCADE,
 FOREIGN KEY(owner_id,contact_id) REFERENCES live_contacts
);
CREATE TABLE IF NOT EXISTS live_obligations (
 owner_id text NOT NULL REFERENCES live_runtime_principal, commitment_id text NOT NULL, record_key text NOT NULL,
 contact_id text NOT NULL, source text NOT NULL, quote text NOT NULL, action text NOT NULL, suggested_due text,
 direction text NOT NULL CHECK(direction IN ('owed_by_me','owed_to_me')), status text NOT NULL,
 due_date text, evidence_valid boolean NOT NULL,
 PRIMARY KEY(owner_id,commitment_id), UNIQUE(owner_id,record_key)
);
CREATE TABLE IF NOT EXISTS live_review_quarantines (
 owner_id text NOT NULL REFERENCES live_runtime_principal, source text NOT NULL, account_id text NOT NULL, record_id text NOT NULL,
 reason text NOT NULL, observed_at text NOT NULL, PRIMARY KEY(owner_id,source,account_id,record_id)
);
CREATE TABLE IF NOT EXISTS live_seen (
 owner_id text NOT NULL, source text NOT NULL, account_id text NOT NULL, record_id text NOT NULL,
 PRIMARY KEY(owner_id,source,account_id,record_id), FOREIGN KEY(owner_id,source,account_id) REFERENCES live_accounts
);
CREATE TABLE IF NOT EXISTS live_attempts (
 owner_id text NOT NULL, record_key text NOT NULL, content_hash text NOT NULL, attempted_at text NOT NULL,
 PRIMARY KEY(owner_id,record_key), FOREIGN KEY(owner_id,record_key) REFERENCES live_records ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS live_reply_ledger (
 owner_id text NOT NULL REFERENCES live_runtime_principal, channel_id text NOT NULL, update_id bigint NOT NULL CHECK(update_id>=0),
 payload_hash text NOT NULL, reply_data jsonb NOT NULL, status text NOT NULL CHECK(status IN ('reply_pending','sent')),
 telegram_message_id bigint, PRIMARY KEY(owner_id,channel_id,update_id)
);
CREATE INDEX IF NOT EXISTS live_records_source_time ON live_records(owner_id,source,occurred_at);
CREATE INDEX IF NOT EXISTS live_contacts_record ON live_interaction_contacts(owner_id,contact_id,record_key);
