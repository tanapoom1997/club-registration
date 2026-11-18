-- Up Migration

-- The rule loginIdSchema (packages/shared/src/auth.ts) applies before every write, now held by
-- the DB as well (CLAUDE.md rule 1): lower-case a-z, 0-9, ".", "_", "-", 1 to 64 characters.
-- UNIQUE (login_id) alone would let "Admin" and "admin" become two accounts as soon as one
-- writer skipped the schema, e.g. a psql fix-up or a future endpoint. Change both rules together;
-- test/schema.test.ts checks them against the same cases.
--
-- Adding the constraint checks every existing row, so a deploy whose database holds an id that
-- breaks the rule stops at the migrate service, before the api starts. Find such rows with:
--   SELECT id FROM users WHERE login_id !~ '^[a-z0-9._-]{1,64}$';
ALTER TABLE users
  ADD CONSTRAINT users_login_id_format CHECK (login_id ~ '^[a-z0-9._-]{1,64}$');

-- Down Migration

ALTER TABLE users DROP CONSTRAINT users_login_id_format;
