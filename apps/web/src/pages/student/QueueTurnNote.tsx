import { Link } from 'react-router';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { QUEUE_MESSAGES } from './queue-ui';
import { AdmittedHeadline, KeepOpenWarning, queueCardClass } from './QueueText';
import type { QueueTurn } from './queue-ui';

const CLUBS_PATH = '/student/clubs';

const Headline = ({ turn }: { turn: QueueTurn }) => {
  switch (turn.kind) {
    case 'none':
      return null;
    case 'waiting':
      return QUEUE_MESSAGES.waiting;
    case 'admitted':
      return <AdmittedHeadline admittedUntil={turn.admittedUntil} />;
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
      className={cn(
        live && 'space-y-3 rounded-2xl border border-border bg-card p-4 shadow-card sm:p-5',
        queueCardClass(turn.kind === 'admitted'),
      )}
      aria-label={live ? 'คิวเลือกชุมนุม' : undefined}
      role={live ? 'region' : undefined}
    >
      <p role="status" className={cn(live && 'text-lg font-semibold')}>
        <Headline turn={turn} />
      </p>
      {turn.kind === 'waiting' && (
        <>
          <p className="text-sm">
            ลำดับที่ <span className="text-4xl font-bold text-primary">{turn.position}</span>
          </p>
          <p className="text-sm text-muted-foreground">{QUEUE_MESSAGES.keepaliveWaitingHelp}</p>
        </>
      )}
      {live && <KeepOpenWarning />}
      {live && (
        <Link
          // Admitted: choosing a club is what the turn is for, so it is the page's main button
          // (the no-club card then leaves its own out).
          className={cn(
            buttonVariants({ variant: turn.kind === 'admitted' ? 'primary' : 'outline' }),
            'w-full sm:w-auto',
          )}
          to={CLUBS_PATH}
        >
          {turn.kind === 'admitted' ? QUEUE_MESSAGES.toClubs : QUEUE_MESSAGES.backToClubs}
        </Link>
      )}
    </div>
  );
};
