-- Up Migration

-- The queue in front of a round (src/services/queue.ts, README Phase 3 Q1). The table came with
-- the initial schema; this adds what the queue needs to decide by and what club_app may do with
-- it. The table has been empty everywhere until now (club_app had no grant on it), so the new
-- constraint cannot fail on old rows.

-- When the ticket was admitted, by the DB clock: the admission TTL counts from it, so a student
-- cannot hold their turn forever by polling. Only an admitted ticket needs it, and a waiting one
-- has never been admitted; an ended ticket keeps whatever it had (set = it was admitted once).
ALTER TABLE queue_tickets
  ADD COLUMN admitted_at timestamptz,
  ADD CONSTRAINT queue_tickets_admitted_at_check CHECK (
    CASE status
      WHEN 'waiting' THEN admitted_at IS NULL
      WHEN 'admitted' THEN admitted_at IS NOT NULL
      ELSE true
    END
  );

-- A ticket only moves forward: waiting → admitted → ended (expired or done), or waiting → ended.
-- An ended ticket never comes back, so a student who rejoins always gets a new ticket at the back
-- (its created_at is the queue order), and the admission time never moves once set, so no
-- statement can stretch the TTL. Enforced here, not only by the api's statements (CLAUDE.md rule
-- 1); the column grants below already keep created_at, round_id and student_id unchangeable.
CREATE FUNCTION check_queue_ticket_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (
    OLD.status = NEW.status
    OR (OLD.status = 'waiting' AND NEW.status IN ('admitted', 'expired', 'done'))
    OR (OLD.status = 'admitted' AND NEW.status IN ('expired', 'done'))
  ) THEN
    RAISE EXCEPTION 'a queue ticket cannot go from % to %', OLD.status, NEW.status;
  END IF;
  IF OLD.status <> 'waiting' AND NEW.admitted_at IS DISTINCT FROM OLD.admitted_at THEN
    RAISE EXCEPTION 'a queue ticket keeps its admission time once admitted';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER queue_tickets_forward_only
BEFORE UPDATE ON queue_tickets
FOR EACH ROW EXECUTE FUNCTION check_queue_ticket_update();

-- What the queue's statements use, and nothing more. Joining inserts a ticket; a heartbeat moves
-- last_seen_at; admission, expiry and done move status (and admitted_at once). UPDATE is granted
-- on those three columns only: created_at is the queue order and round_id/student_id say whose
-- turn it is, so no statement of the api can move a ticket up the queue or hand it to another
-- student or round. No DELETE: an ended ticket stays as expired or done (the record of how a
-- student's turn ended, read back as the ticket's state), and the live-ticket unique index is
-- partial, so it never stands in the way of a new ticket.
--
-- Indexes: none new. Every statement filters on (round_id, status) and the queue order is
-- (created_at, id), which queue_tickets_admission_idx (round_id, status, created_at, id) from the
-- initial schema serves as is (EXPLAIN in src/services/queue.ts).
GRANT SELECT, INSERT ON queue_tickets TO club_app;
GRANT UPDATE (status, last_seen_at, admitted_at) ON queue_tickets TO club_app;

-- Down Migration

REVOKE UPDATE (status, last_seen_at, admitted_at) ON queue_tickets FROM club_app;
REVOKE SELECT, INSERT ON queue_tickets FROM club_app;
DROP TRIGGER queue_tickets_forward_only ON queue_tickets;
DROP FUNCTION check_queue_ticket_update();
ALTER TABLE queue_tickets
  DROP CONSTRAINT queue_tickets_admitted_at_check,
  DROP COLUMN admitted_at;
