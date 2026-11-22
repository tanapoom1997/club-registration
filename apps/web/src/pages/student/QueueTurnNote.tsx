import { Link } from 'react-router';
import { cn } from '@/lib/utils';
import { QUEUE_MESSAGES, admittedHeadline } from './queue-ui';
import type { QueueTurn } from './queue-ui';

const CLUBS_PATH = '/student/clubs';

const headline = (turn: QueueTurn): string => {
  switch (turn.kind) {
    case 'none':
      return '';
    case 'waiting':
      return QUEUE_MESSAGES.waiting;
    case 'admitted':
      return admittedHeadline(turn.admittedUntil);
  }
};

// The student's live queue ticket on the result page (Q2), kept alive by useQueueKeepalive. Shows
// nothing without one. The status line is always mounted and holds the state alone, never the
// place, as on the clubs page's queue card: a screen reader hears "waiting" → "your turn", not a
// number on every heartbeat.
export const QueueTurnNote = ({ turn }: { turn: QueueTurn }) => {
  const live = turn.kind !== 'none';
  return (
    <div
      className={cn(live && 'space-y-2 rounded-lg border border-border bg-card p-4')}
      aria-label={live ? 'คิวเลือกชุมนุม' : undefined}
      role={live ? 'region' : undefined}
    >
      <p role="status" className={cn(live && 'font-semibold')}>
        {headline(turn)}
      </p>
      {turn.kind === 'waiting' && (
        <>
          <p className="text-sm">
            ลำดับที่ <span className="text-2xl font-bold text-primary">{turn.position}</span>
          </p>
          <p className="text-sm text-muted-foreground">{QUEUE_MESSAGES.keepaliveWaitingHelp}</p>
        </>
      )}
      {live && (
        <Link
          className="text-sm font-medium text-primary underline underline-offset-4"
          to={CLUBS_PATH}
        >
          {turn.kind === 'admitted' ? QUEUE_MESSAGES.toClubs : QUEUE_MESSAGES.backToClubs}
        </Link>
      )}
    </div>
  );
};
