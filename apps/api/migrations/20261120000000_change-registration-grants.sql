-- Up Migration

-- What the atomic club change (src/services/registrations.ts, changeRegistration) needs on top
-- of 20261119000000_app-role.sql, and nothing more.
--
-- The change moves the student's one registrations row to the new club with an UPDATE, so the
-- row and its UNIQUE (round_id, student_id) slot are never given up mid-transaction. UPDATE is
-- granted on the two columns that statement writes only: round_id and student_id stay
-- unchangeable by the api, so a seat can never move to another student or round, and id never
-- changes. created_at is rewritten to the moment the new club was obtained.
GRANT UPDATE (club_id, created_at) ON registrations TO club_app;

-- The change refuses a club with a waitlist (no jumping the queue, README Phase 2), read in the
-- statement that takes the seat. Writes to the waitlist come with the waitlist endpoints.
GRANT SELECT ON waitlist_entries TO club_app;

-- Down Migration

REVOKE SELECT ON waitlist_entries FROM club_app;
REVOKE UPDATE (club_id, created_at) ON registrations FROM club_app;
