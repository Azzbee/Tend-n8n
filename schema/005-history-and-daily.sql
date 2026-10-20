CREATE TABLE IF NOT EXISTS live_history_backfills (
 owner_id text NOT NULL REFERENCES live_runtime_principal,
 source text NOT NULL,
 account_id text NOT NULL,
 version integer NOT NULL CHECK(version=1),
 data jsonb NOT NULL,
 PRIMARY KEY(owner_id,source,account_id,version),
 FOREIGN KEY(owner_id,source,account_id) REFERENCES live_accounts,
 CHECK(data->>'owner_id'=owner_id AND data->>'source'=source AND data->>'account_id'=account_id)
);
CREATE TABLE IF NOT EXISTS live_history_seen (
 owner_id text NOT NULL, source text NOT NULL, account_id text NOT NULL,
 version integer NOT NULL CHECK(version=1), record_id text NOT NULL,
 PRIMARY KEY(owner_id,source,account_id,version,record_id),
 FOREIGN KEY(owner_id,source,account_id,version) REFERENCES live_history_backfills
);
CREATE TABLE IF NOT EXISTS live_daily_briefings (
 owner_id text NOT NULL REFERENCES live_runtime_principal,
 paris_date text NOT NULL CHECK(paris_date ~ '^\d{4}-\d{2}-\d{2}$'),
 revision integer NOT NULL CHECK(revision>=0),
 state text NOT NULL CHECK(state IN ('pending','sending','sent','uncertain','missed')),
 data jsonb NOT NULL,
 PRIMARY KEY(owner_id,paris_date),
 CHECK(data->>'owner_id'=owner_id AND data->>'paris_date'=paris_date
  AND (data->>'revision')::integer=revision AND data->>'state'=state)
);
