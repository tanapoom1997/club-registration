import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';

export type LockWaiter = { pid: number; waitEvent: string; query: string };

const POLL_INTERVAL_MS = 25;
const MAX_POLLS = 200;

const sameReading = (a: LockWaiter, b: LockWaiter): boolean =>
  a.waitEvent === b.waitEvent && a.query === b.query;

// Polls pg_stat_activity until a backend matching `matches` is blocked on a lock, and returns
// it. pg_stat_activity takes `query` from a snapshot of each backend's status but reads
// `wait_event` live from the process, so a single row can pair the statement a backend just
// finished with the lock its next statement already waits on. CI saw exactly that (`... FOR
// SHARE` beside wait_event advisory), and a probe under CPU throttling reproduces it in about 1
// of 3,000 readings. A backend blocked on a lock stays where it is, so a waiter is returned only
// once two polls in a row read the same wait and statement for its pid.
export const waitForLockWaiter = async (
  pool: pg.Pool,
  matches: (waiter: LockWaiter) => boolean,
): Promise<LockWaiter> => {
  let previous = new Map<number, LockWaiter>();
  for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
    const { rows } = await pool.query<{ pid: number; wait_event: string; query: string }>(
      `SELECT pid, wait_event, query FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND datname = current_database()`,
    );
    const current = rows.map(({ pid, wait_event: waitEvent, query }) => ({
      pid,
      waitEvent,
      query,
    }));
    const settled = current.find((waiter) => {
      const before = previous.get(waiter.pid);
      return matches(waiter) && before !== undefined && sameReading(before, waiter);
    });
    if (settled) return settled;
    previous = new Map(current.map((waiter) => [waiter.pid, waiter]));
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('No backend ever waited for the expected lock');
};
