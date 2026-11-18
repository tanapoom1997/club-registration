-- Up Migration

-- club_app: the role the api connects as (src/db-role.ts). Created NOLOGIN; migrate gives it a
-- login and password from APP_DB_PASSWORD, a deployment secret that does not belong here. Roles
-- belong to the cluster, not the database, so a restore into a second database of the same
-- server (scripts/restore.sh) finds it already there.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'club_app') THEN
    CREATE ROLE club_app NOLOGIN;
  END IF;
END
$$;
ALTER ROLE club_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;

-- Postgres 15+ already leaves PUBLIC without CREATE on public; stated so a database made from an
-- older template cannot let the api create objects.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO club_app;

-- Exactly the statements the api runs, per table. SELECT ... FOR SHARE / FOR NO KEY UPDATE need
-- UPDATE (student_profiles, users, rounds), as does INSERT ... ON CONFLICT DO UPDATE. Deletes that
-- cascade (a round) run as the table owner, so the children need no DELETE here.
-- Every new table needs its grants in the migration that creates it, and the expected list in
-- test/db-role.test.ts changes with them.
GRANT SELECT, INSERT, UPDATE ON users, student_profiles, clubs TO club_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON rounds TO club_app;
GRANT SELECT, INSERT, DELETE ON club_advisors, registrations TO club_app;
-- Append-only by privilege as well as by the registration_events_append_only trigger.
GRANT SELECT, INSERT ON registration_events, password_issuances TO club_app;
-- Nothing on waitlist_entries and queue_tickets (Phase 2 grants them with its code) or on
-- pgmigrations.

-- Down Migration

REVOKE ALL ON users, student_profiles, clubs, rounds, club_advisors, registrations,
  registration_events, password_issuances FROM club_app;
REVOKE USAGE ON SCHEMA public FROM club_app;
-- The role stays: other databases of the cluster (a restore drill) may still grant to it.
