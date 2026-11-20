-- Up Migration

-- What the waitlist (src/services/waitlist.ts and waitlist-promote.ts) needs on top of
-- 20261120000000_change-registration-grants.sql, and nothing more.
--
-- Joining inserts the student's one entry for the round; leaving, and a promotion that hands the
-- student a seat, delete it. No UPDATE: moving to another club's waitlist is a delete and an
-- insert, so the student goes to the back of the new queue by construction, and no statement of
-- the api can rewrite an entry's place (created_at), club, student or round.
GRANT INSERT, DELETE ON waitlist_entries TO club_app;

-- Down Migration

REVOKE INSERT, DELETE ON waitlist_entries FROM club_app;
