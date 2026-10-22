BEGIN;
CREATE TABLE owners (owner_id text PRIMARY KEY, display_name text NOT NULL);
CREATE TABLE contacts (
 owner_id text NOT NULL REFERENCES owners, contact_id text NOT NULL, display_name text NOT NULL,
 PRIMARY KEY(owner_id,contact_id)
);
CREATE TABLE identities (
 owner_id text NOT NULL REFERENCES owners, identity_kind text NOT NULL,
 identity_value text NOT NULL, contact_id text, is_owner boolean NOT NULL DEFAULT false,
 PRIMARY KEY(owner_id,identity_kind,identity_value),
 FOREIGN KEY(owner_id,contact_id) REFERENCES contacts,
 CHECK((is_owner AND contact_id IS NULL) OR (NOT is_owner AND contact_id IS NOT NULL))
);
CREATE TABLE source_accounts (
 owner_id text NOT NULL REFERENCES owners, source text NOT NULL,
 account_id text NOT NULL, ingestion_mode text NOT NULL CHECK(ingestion_mode IN ('fixture','snapshot','live')),
 connection_state text NOT NULL, last_success timestamptz,
 coverage_start timestamptz, coverage_end timestamptz, cursor_value text,
 PRIMARY KEY(owner_id,source,account_id),
 CHECK(source IN ('gmail','calendar','whatsapp_personal','whatsapp_business','linkedin')),
 CHECK(coverage_end IS NULL OR coverage_start IS NULL OR coverage_start<=coverage_end)
);
CREATE TABLE interactions (
 owner_id text NOT NULL, source text NOT NULL, account_id text NOT NULL,
 source_record_id text NOT NULL, source_thread_id text, contact_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('message','meeting')),
 direction text NOT NULL CHECK(direction IN ('sent','received','event')),
 occurred_at timestamptz NOT NULL, observed_at timestamptz NOT NULL,
 body_text text NOT NULL, evidence_reference text NOT NULL, content_hash text NOT NULL,
 cancelled boolean NOT NULL DEFAULT false,
 PRIMARY KEY(owner_id,source,account_id,source_record_id),
 FOREIGN KEY(owner_id,source,account_id) REFERENCES source_accounts ON DELETE CASCADE,
 FOREIGN KEY(owner_id,contact_id) REFERENCES contacts
);
CREATE TABLE commitments (
 owner_id text NOT NULL REFERENCES owners, commitment_id text NOT NULL, contact_id text NOT NULL,
 action_text text NOT NULL, direction text NOT NULL CHECK(direction IN ('owed_by_me','owed_to_me','unresolved')),
 status text NOT NULL CHECK(status IN ('pending','confirmed','done','cancelled','dismissed','invalidated')),
 suggested_due date, confirmed_due date, quote_text text NOT NULL,
 PRIMARY KEY(owner_id,commitment_id), FOREIGN KEY(owner_id,contact_id) REFERENCES contacts,
 CHECK(status<>'confirmed' OR confirmed_due IS NOT NULL)
);
CREATE TABLE evidence_links (
 owner_id text NOT NULL, commitment_id text NOT NULL, source text NOT NULL,
 account_id text NOT NULL, source_record_id text NOT NULL,
 PRIMARY KEY(owner_id,commitment_id,source,account_id,source_record_id),
 FOREIGN KEY(owner_id,commitment_id) REFERENCES commitments ON DELETE CASCADE,
 FOREIGN KEY(owner_id,source,account_id,source_record_id) REFERENCES interactions ON DELETE CASCADE
);
CREATE TABLE run_outcomes (
 run_id text PRIMARY KEY, owner_id text NOT NULL REFERENCES owners, source text NOT NULL,
 started_at timestamptz NOT NULL, finished_at timestamptz, status text NOT NULL,
 records_written integer NOT NULL DEFAULT 0 CHECK(records_written>=0),
 redacted_error_code text, restart_cursor text
);
CREATE INDEX interactions_contact_time ON interactions(owner_id,contact_id,occurred_at DESC);
CREATE INDEX commitments_open_due ON commitments(owner_id,status,confirmed_due);
COMMIT;
