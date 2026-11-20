-- Up Migration

-- The admin event log (src/services/event-log.ts) reads a round's events newest first by id:
-- WHERE round_id = $1 [AND id < $before] ORDER BY id DESC LIMIT n. The initial index on
-- (round_id, created_at) cannot give that order, so for a round whose events are old the planner
-- walks the primary key backwards past every newer event of other rounds (EXPLAIN on 100,800
-- fictional events in 60 rounds, the oldest round: 99,120 rows removed by the filter, 4.2 ms;
-- with (round_id, id): a backward scan of the round's own entries, 0.3 ms; README Phase 2 PR 3b).
--
-- Replaced, not added beside it: no statement of the api orders or filters events by created_at
-- (every "latest event" lookup orders by id, since one transaction's events share created_at), so
-- the old index only cost every insert on the write path under the round lock. round_id stays the
-- leading column, so the index still serves the foreign key and every round_id lookup. The other
-- event indexes ((student_id, created_at), (club_id), (from_club_id)) serve the log's other
-- filters already: a student or a club has at most a few hundred events, read through the bitmap
-- and sorted in well under 2 ms.
--
-- Indexes need no grants (test/db-role.test.ts).
DROP INDEX registration_events_round_id_idx;
CREATE INDEX registration_events_round_id_idx ON registration_events (round_id, id);

-- Down Migration

DROP INDEX registration_events_round_id_idx;
CREATE INDEX registration_events_round_id_idx ON registration_events (round_id, created_at);
