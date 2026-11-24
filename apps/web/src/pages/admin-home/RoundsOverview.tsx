import type { Round } from '@club-registration/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { SeatBar } from '@/components/SeatMeter';
import { EmptyState, LoadFailed } from '@/components/StatusBlock';
import { Badge } from '@/components/ui/badge';
import { fetchRounds } from '@/lib/api';
import { useNow } from '@/lib/now';
import { STATUS_DISPLAY, gradeLabel, roundCountdown } from '@/lib/round-display';
import { cn } from '@/lib/utils';
import { ROUNDS_QUERY_KEY } from '@/pages/admin-rounds/round-ui';
import { liveRounds, overviewRefetchInterval, queueSummary } from './rounds-overview';

// The same query as the round pickers of the other admin pages, so they share one cached list.
const ALL_TERMS = '';
const HEADING_ID = 'rounds-overview-heading';
const COUNTDOWN_TICK_MS = 30_000;

// Seats taken are not students done: who in the grade still has no club is what the admin
// chases on registration day (waiting students count as without one). A grade with no students
// yet usually means the import has not been done.
const StudentsWithoutClub = ({ round }: { round: Round }) => {
  const { studentCount, studentsWithoutClub } = round;
  if (studentCount === 0) {
    return (
      <p className="text-sm text-warning-foreground">
        ยังไม่มีนักเรียน {gradeLabel(round.grade)} ในระบบ
      </p>
    );
  }
  if (studentsWithoutClub === 0) {
    return <p className="text-sm">นักเรียนได้ชุมนุมครบทุกคนแล้ว ({studentCount} คน)</p>;
  }
  return (
    <p className="text-sm">
      ยังไม่มีชุมนุม <span className="text-lg font-bold">{studentsWithoutClub}</span> จาก {studentCount}{' '}
      คน
    </p>
  );
};

const RoundCard = ({ round, now }: { round: Round; now: number }) => {
  const status = STATUS_DISPLAY[round.status];
  const countdown = roundCountdown(round, now);
  const remaining = round.totalCapacity - round.totalRegistered;
  return (
    <li className="space-y-3 rounded-2xl border border-border bg-card p-4 shadow-card">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-bold">
          {gradeLabel(round.grade)}{' '}
          <span className="font-normal text-muted-foreground">· {round.term}</span>
        </h3>
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>
      {countdown && (
        <p
          className={cn(
            'text-sm',
            countdown.withinHour ? 'font-medium text-warning-foreground' : 'text-muted-foreground',
          )}
        >
          {countdown.text}
        </p>
      )}
      {/* No clubs yet means no seats: an empty round is not a full one. */}
      {round.totalCapacity > 0 ? (
        <div className="space-y-1.5">
          <p className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
            <span>
              ลงแล้ว <span className="text-lg font-bold">{round.totalRegistered}</span> /{' '}
              {round.totalCapacity} คน
            </span>
            <span className="text-xs text-muted-foreground">
              {remaining > 0 ? `เหลือ ${remaining} ที่` : 'เต็มทุกชุมนุม'}
            </span>
          </p>
          <SeatBar capacity={round.totalCapacity} remaining={remaining} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">ยังไม่มีชุมนุมในรอบนี้</p>
      )}
      <StudentsWithoutClub round={round} />
      <p className="text-sm text-muted-foreground">{queueSummary(round)}</p>
    </li>
  );
};

// What the admin most often opens the system to check on registration day, on their home: each
// open or upcoming round's seats, queue and time left. Read only; the rounds page changes them.
export const RoundsOverview = () => {
  const now = useNow(COUNTDOWN_TICK_MS);
  const roundsQuery = useQuery({
    queryKey: [...ROUNDS_QUERY_KEY, ALL_TERMS],
    queryFn: async () => await fetchRounds(),
    refetchInterval: (query) => overviewRefetchInterval(query.state.data),
  });
  const rounds = liveRounds(roundsQuery.data ?? []);

  return (
    <section aria-labelledby={HEADING_ID} className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={HEADING_ID} className="text-lg font-bold">
          รอบที่เปิดอยู่และกำลังจะเปิด
        </h2>
        <Link
          to="rounds"
          className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline sm:min-h-0"
        >
          จัดการรอบลงทะเบียน
        </Link>
      </div>
      {roundsQuery.isPending ? (
        <p className="text-sm text-muted-foreground">กำลังโหลด…</p>
      ) : roundsQuery.isError ? (
        <LoadFailed message="โหลดภาพรวมรอบไม่สำเร็จ" onRetry={() => void roundsQuery.refetch()} />
      ) : rounds.length === 0 ? (
        <EmptyState>ไม่มีรอบที่เปิดอยู่หรือกำลังจะเปิด</EmptyState>
      ) : (
        <ul aria-labelledby={HEADING_ID} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rounds.map((round) => (
            <RoundCard key={round.id} round={round} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
};
