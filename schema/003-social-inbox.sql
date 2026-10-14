CREATE TABLE IF NOT EXISTS live_social_inbox (
 owner_id text NOT NULL, source text NOT NULL DEFAULT 'whatsapp_business' CHECK(source='whatsapp_business'),
 account_id text NOT NULL, event_id text NOT NULL, body_hash text NOT NULL CHECK(body_hash ~ '^[a-f0-9]{64}$'),
 payload jsonb, received_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','leased','processed','expired','revoked','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 available_at timestamptz NOT NULL, lease_id uuid, lease_until timestamptz,
 finished_at timestamptz, needs_resync boolean NOT NULL DEFAULT false, error_code text,
 PRIMARY KEY(owner_id,account_id,event_id), UNIQUE(owner_id,account_id,body_hash),
 FOREIGN KEY(owner_id,source,account_id) REFERENCES live_accounts ON DELETE CASCADE,
 CHECK((status IN ('pending','leased') AND payload IS NOT NULL) OR (status NOT IN ('pending','leased') AND payload IS NULL)),
 CHECK((status='leased' AND lease_id IS NOT NULL AND lease_until IS NOT NULL) OR (status<>'leased' AND lease_id IS NULL AND lease_until IS NULL)),
 CHECK(expires_at<=received_at+interval '24 hours')
);
CREATE INDEX IF NOT EXISTS live_social_inbox_ready ON live_social_inbox(owner_id,account_id,available_at,received_at) WHERE status IN ('pending','leased');
CREATE OR REPLACE FUNCTION expire_live_social_inbox(p_owner text, p_now timestamptz) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE changed integer;
BEGIN
 UPDATE live_social_inbox SET payload=NULL,status='expired',lease_id=NULL,lease_until=NULL,finished_at=p_now,needs_resync=true,error_code='payload_expired'
 WHERE owner_id=p_owner AND payload IS NOT NULL AND expires_at<=p_now;
 GET DIAGNOSTICS changed = ROW_COUNT;
 RETURN changed;
END $$;
CREATE OR REPLACE FUNCTION revoke_live_social_inbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source='whatsapp_business' AND NEW.state->>'status'='revoked' THEN
  UPDATE live_social_inbox SET payload=NULL,status='revoked',lease_id=NULL,lease_until=NULL,finished_at=clock_timestamp(),error_code='source_revoked'
  WHERE owner_id=NEW.owner_id AND account_id=NEW.account_id AND payload IS NOT NULL;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS live_social_inbox_revocation ON live_accounts;
CREATE TRIGGER live_social_inbox_revocation AFTER UPDATE OF state ON live_accounts FOR EACH ROW EXECUTE FUNCTION revoke_live_social_inbox();
