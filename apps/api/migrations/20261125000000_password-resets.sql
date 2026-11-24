-- Up Migration

-- One row per committed reset of one student's password by an admin (src/services/password-reset.ts),
-- for a student who forgot it, including one who had already set their own. Like
-- password_issuances it is the audit trail and holds the idempotency key: the new password is
-- never stored, so a replayed request cannot be answered with it, and is refused with
-- idempotency_key_reused instead of silently resetting the password a second time. Never holds a
-- password, a hash or a name.
CREATE TABLE password_resets (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id integer NOT NULL REFERENCES users (id),
  student_id integer NOT NULL REFERENCES users (id),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Also serves as the index on admin_id.
  UNIQUE (admin_id, idempotency_key)
);

CREATE INDEX password_resets_student_id_idx ON password_resets (student_id);

-- Append-only for the api, like password_issuances: it records a reset and reads a key back,
-- nothing else. The reset's write to users needs no new grant (club_app updates users already).
GRANT SELECT, INSERT ON password_resets TO club_app;

-- Down Migration

REVOKE SELECT, INSERT ON password_resets FROM club_app;
DROP TABLE password_resets;
