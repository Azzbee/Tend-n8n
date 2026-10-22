-- Promise threads: the same ask from the same person, seen on several channels, counted once.
-- Quotes stay on each obligation; these tables only record which obligations are one promise.
CREATE TABLE IF NOT EXISTS commitment_threads (
 owner_id text NOT NULL REFERENCES live_runtime_principal ON DELETE CASCADE,
 thread_id text NOT NULL CHECK(thread_id ~ '^T[A-Za-z0-9_-]{1,80}$'),
 created_at text NOT NULL,
 PRIMARY KEY(owner_id,thread_id)
);
CREATE TABLE IF NOT EXISTS commitment_thread_members (
 owner_id text NOT NULL,
 thread_id text NOT NULL,
 commitment_id text NOT NULL,
 linked_by text NOT NULL CHECK(linked_by IN ('auto','owner')),
 similarity real CHECK(similarity IS NULL OR (similarity>=0 AND similarity<=1)),
 created_at text NOT NULL,
 PRIMARY KEY(owner_id,commitment_id),
 FOREIGN KEY(owner_id,thread_id) REFERENCES commitment_threads ON DELETE CASCADE,
 FOREIGN KEY(owner_id,commitment_id) REFERENCES live_obligations ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS commitment_thread_members_thread ON commitment_thread_members(owner_id,thread_id);
-- Owner overrides ("Not the same ask"): automatic linking never joins these pairs again.
CREATE TABLE IF NOT EXISTS commitment_thread_overrides (
 owner_id text NOT NULL,
 commitment_id text NOT NULL,
 other_commitment_id text NOT NULL CHECK(other_commitment_id<>commitment_id),
 created_at text NOT NULL,
 PRIMARY KEY(owner_id,commitment_id,other_commitment_id),
 FOREIGN KEY(owner_id,commitment_id) REFERENCES live_obligations ON DELETE CASCADE,
 FOREIGN KEY(owner_id,other_commitment_id) REFERENCES live_obligations ON DELETE CASCADE
);
