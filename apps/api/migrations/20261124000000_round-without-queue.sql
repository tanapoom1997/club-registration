-- Up Migration

-- max_active NULL = the round has no queue (README Phase 3 decision 6, Q4): students of the round
-- choose clubs without a turn, and the queue's join and heartbeat answer queue_off. The CHECK
-- (max_active > 0) stays as it is (NULL passes a CHECK), and so does the default 150 for a new
-- round, so a round has a queue unless an admin turns it off.
--
-- No grant changes: club_app already inserts and updates rounds (max_active included), and
-- reading the column is what every statement of the queue and the gate already does
-- (test/db-role.test.ts).
ALTER TABLE rounds ALTER COLUMN max_active DROP NOT NULL;

-- Down Migration

-- A round without a queue gets the default back, the value it would have had before Q4.
UPDATE rounds SET max_active = 150 WHERE max_active IS NULL;
ALTER TABLE rounds ALTER COLUMN max_active SET NOT NULL;
