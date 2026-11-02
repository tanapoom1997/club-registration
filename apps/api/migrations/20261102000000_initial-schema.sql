-- Up Migration

CREATE TABLE users (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  login_id text NOT NULL UNIQUE,
  full_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('student', 'admin')),
  password_hash text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE student_profiles (
  user_id integer PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  grade smallint NOT NULL CHECK (grade BETWEEN 1 AND 6),
  classroom text NOT NULL,
  seat_no smallint NOT NULL CHECK (seat_no > 0)
);

CREATE INDEX student_profiles_grade_idx ON student_profiles (grade);

CREATE TABLE rounds (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  term text NOT NULL,
  grade smallint NOT NULL CHECK (grade BETWEEN 1 AND 6),
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  max_active integer NOT NULL DEFAULT 150 CHECK (max_active > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (term, grade),
  CHECK (closes_at > opens_at)
);

CREATE TABLE clubs (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  round_id integer NOT NULL REFERENCES rounds (id),
  club_code text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  capacity integer NOT NULL CHECK (capacity >= 0),
  registered integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, club_code),
  -- Target of composite FKs so a registration can never point at another round's club.
  UNIQUE (id, round_id),
  CHECK (registered >= 0 AND registered <= capacity)
);

CREATE TABLE club_advisors (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  club_id integer NOT NULL REFERENCES clubs (id) ON DELETE CASCADE,
  full_name text NOT NULL,
  phone text,
  email text,
  line_id text
);

CREATE INDEX club_advisors_club_id_idx ON club_advisors (club_id);

CREATE TABLE registrations (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  round_id integer NOT NULL REFERENCES rounds (id),
  student_id integer NOT NULL REFERENCES student_profiles (user_id),
  club_id integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, student_id),
  FOREIGN KEY (club_id, round_id) REFERENCES clubs (id, round_id)
);

CREATE INDEX registrations_student_id_idx ON registrations (student_id);
CREATE INDEX registrations_club_id_idx ON registrations (club_id, round_id);

CREATE TABLE registration_events (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  round_id integer NOT NULL REFERENCES rounds (id),
  student_id integer NOT NULL REFERENCES student_profiles (user_id),
  club_id integer REFERENCES clubs (id),
  from_club_id integer REFERENCES clubs (id),
  event_type text NOT NULL CHECK (
    event_type IN (
      'register',
      'cancel',
      'change',
      'admin_assign',
      'admin_remove',
      'waitlist_join',
      'waitlist_leave',
      'waitlist_promote'
    )
  ),
  actor_id integer NOT NULL REFERENCES users (id),
  -- NULL for cascaded promotions, which have no client request of their own.
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, idempotency_key)
);

CREATE INDEX registration_events_round_id_idx ON registration_events (round_id, created_at);
CREATE INDEX registration_events_student_id_idx ON registration_events (student_id, created_at);
CREATE INDEX registration_events_club_id_idx ON registration_events (club_id);
CREATE INDEX registration_events_from_club_id_idx ON registration_events (from_club_id);

CREATE FUNCTION reject_registration_event_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'registration_events is append-only';
END;
$$;

CREATE TRIGGER registration_events_append_only
BEFORE UPDATE OR DELETE ON registration_events
FOR EACH ROW EXECUTE FUNCTION reject_registration_event_change();

CREATE TABLE waitlist_entries (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  round_id integer NOT NULL REFERENCES rounds (id),
  student_id integer NOT NULL REFERENCES student_profiles (user_id),
  club_id integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, student_id),
  FOREIGN KEY (club_id, round_id) REFERENCES clubs (id, round_id)
);

CREATE INDEX waitlist_entries_student_id_idx ON waitlist_entries (student_id);
CREATE INDEX waitlist_entries_club_order_idx ON waitlist_entries (club_id, round_id, created_at, id);

CREATE TABLE queue_tickets (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  round_id integer NOT NULL REFERENCES rounds (id),
  student_id integer NOT NULL REFERENCES student_profiles (user_id),
  status text NOT NULL DEFAULT 'waiting' CHECK (
    status IN ('waiting', 'admitted', 'expired', 'done')
  ),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Partial so a student whose ticket expired can queue again, but never hold two live tickets.
CREATE UNIQUE INDEX queue_tickets_live_ticket_idx ON queue_tickets (round_id, student_id)
WHERE status IN ('waiting', 'admitted');
CREATE INDEX queue_tickets_student_id_idx ON queue_tickets (student_id);
CREATE INDEX queue_tickets_admission_idx ON queue_tickets (round_id, status, created_at, id);

-- Down Migration

DROP TABLE queue_tickets;
DROP TABLE waitlist_entries;
DROP TABLE registration_events;
DROP FUNCTION reject_registration_event_change();
DROP TABLE registrations;
DROP TABLE club_advisors;
DROP TABLE clubs;
DROP TABLE rounds;
DROP TABLE student_profiles;
DROP TABLE users;
