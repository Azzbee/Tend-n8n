CREATE EXTENSION IF NOT EXISTS vector WITH VERSION '0.8.2';
DO $$ BEGIN
 IF (SELECT extversion FROM pg_extension WHERE extname='vector') <> '0.8.2' THEN
  RAISE EXCEPTION 'pgvector 0.8.2 required; extension upgrade is not permitted';
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS live_semantic_snapshots (
 owner_id text PRIMARY KEY REFERENCES live_runtime_principal ON DELETE CASCADE,
 model_digest text NOT NULL CHECK(model_digest ~ '^[a-f0-9]{64}$'),
 scope_fingerprint text NOT NULL CHECK(scope_fingerprint ~ '^[a-f0-9]{64}$'),
 watermark timestamptz NOT NULL,
 total_records integer NOT NULL DEFAULT 0 CHECK(total_records>=0),
 state text NOT NULL CHECK(state IN ('indexing','complete','paused')),
 reason text,
 UNIQUE(owner_id,model_digest,scope_fingerprint)
);
CREATE TABLE IF NOT EXISTS live_semantic_snapshot_records (
 owner_id text NOT NULL REFERENCES live_semantic_snapshots ON DELETE CASCADE,
 record_key text NOT NULL,
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 status text NOT NULL CHECK(status IN ('pending','complete','withdrawn','failed')),
 failure_reason text CHECK(failure_reason IN ('input_bound','context_limit')),
 CHECK((status='failed')=(failure_reason IS NOT NULL)),
 PRIMARY KEY(owner_id,record_key)
);
CREATE TABLE IF NOT EXISTS live_semantic_chunks (
 owner_id text NOT NULL,
 record_key text NOT NULL,
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 passage_index integer NOT NULL CHECK(passage_index>=0),
 passage_start integer NOT NULL CHECK(passage_start>=0),
 passage_end integer NOT NULL CHECK(passage_end>passage_start),
 passage_hash text NOT NULL CHECK(passage_hash ~ '^[a-f0-9]{64}$'),
 model_digest text NOT NULL CHECK(model_digest ~ '^[a-f0-9]{64}$'),
 scope_fingerprint text NOT NULL CHECK(scope_fingerprint ~ '^[a-f0-9]{64}$'),
 embedding vector(768) NOT NULL,
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL CHECK(expires_at>created_at),
 PRIMARY KEY(owner_id,record_key,passage_index),
 FOREIGN KEY(owner_id,record_key) REFERENCES live_records ON DELETE CASCADE,
 FOREIGN KEY(owner_id,model_digest,scope_fingerprint) REFERENCES live_semantic_snapshots(owner_id,model_digest,scope_fingerprint) ON DELETE CASCADE,
 CHECK(vector_norm(embedding)>0)
);
CREATE INDEX IF NOT EXISTS live_semantic_expiry ON live_semantic_chunks(owner_id,expires_at);
CREATE INDEX IF NOT EXISTS live_semantic_pending ON live_semantic_snapshot_records(owner_id,record_key) WHERE status='pending';
CREATE OR REPLACE FUNCTION invalidate_live_semantic_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.cancelled OR NEW.body_text IS DISTINCT FROM OLD.body_text OR NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.contact_ids IS DISTINCT FROM OLD.contact_ids OR NEW.source IS DISTINCT FROM OLD.source OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at OR NEW.end_at IS DISTINCT FROM OLD.end_at OR NEW.actor_identity IS DISTINCT FROM OLD.actor_identity OR NEW.participant_identities IS DISTINCT FROM OLD.participant_identities OR NEW.attribution IS DISTINCT FROM OLD.attribution THEN
  DELETE FROM live_semantic_chunks WHERE owner_id=OLD.owner_id AND record_key=OLD.record_key;
  UPDATE live_semantic_snapshot_records SET status='withdrawn',failure_reason=NULL WHERE owner_id=OLD.owner_id AND record_key=OLD.record_key;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS live_semantic_record_invalidation ON live_records;
CREATE TRIGGER live_semantic_record_invalidation BEFORE UPDATE OR DELETE ON live_records FOR EACH ROW EXECUTE FUNCTION invalidate_live_semantic_record();
CREATE OR REPLACE FUNCTION revoke_live_semantic_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state->>'status'='revoked' THEN
  DELETE FROM live_semantic_chunks c USING live_records r WHERE c.owner_id=r.owner_id AND c.record_key=r.record_key AND r.owner_id=NEW.owner_id AND r.source=NEW.source AND r.account_id=NEW.account_id;
  UPDATE live_semantic_snapshot_records s SET status='withdrawn',failure_reason=NULL FROM live_records r WHERE s.owner_id=r.owner_id AND s.record_key=r.record_key AND r.owner_id=NEW.owner_id AND r.source=NEW.source AND r.account_id=NEW.account_id;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS live_semantic_account_revocation ON live_accounts;
CREATE TRIGGER live_semantic_account_revocation AFTER UPDATE OF state ON live_accounts FOR EACH ROW EXECUTE FUNCTION revoke_live_semantic_account();
