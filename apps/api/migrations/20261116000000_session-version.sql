-- Up Migration

-- Every JWT carries the version it was issued under; bumping it on logout or password change
-- revokes all earlier tokens, which matters on shared computer-lab machines.
ALTER TABLE users ADD COLUMN session_version integer NOT NULL DEFAULT 0;

-- Down Migration

ALTER TABLE users DROP COLUMN session_version;
