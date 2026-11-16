-- Up Migration

-- NULL = an initial password was never issued. Together with must_change_password this tells
-- "never issued" from "issued, not yet changed by the student" from "student set their own".
ALTER TABLE users ADD COLUMN password_issued_at timestamptz;

-- One row per committed issuance: who issued which scope, when, and how many students got a new
-- password. It is the audit trail and holds the idempotency key, so a replayed request is refused
-- instead of silently invalidating the passwords already printed. Never holds passwords or names.
CREATE TABLE password_issuances (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id integer NOT NULL REFERENCES users (id),
  idempotency_key text NOT NULL,
  grade smallint NOT NULL CHECK (grade BETWEEN 1 AND 6),
  -- NULL = the whole grade.
  classroom text,
  only_unissued boolean NOT NULL,
  issued_count integer NOT NULL CHECK (issued_count > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Also serves as the index on admin_id.
  UNIQUE (admin_id, idempotency_key)
);

-- Down Migration

DROP TABLE password_issuances;
ALTER TABLE users DROP COLUMN password_issued_at;
