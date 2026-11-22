import { alertVariants } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import { QUEUE_MESSAGES, admittedParts } from './queue-ui';

// The warning a student must not miss while they hold a place in the queue: losing it means the
// back of the queue on the busiest day. The same on the clubs page and the result page.
export const KeepOpenWarning = () => (
  <p className={cn(alertVariants({ variant: 'warning' }), 'font-medium')}>
    {QUEUE_MESSAGES.keepOpen}
  </p>
);

// The admitted line with the deadline set large on its own line, "HH:MM น." never split. Its
// words, and so what a screen reader announces, are exactly admittedHeadline's.
export const AdmittedHeadline = ({ admittedUntil }: { admittedUntil: string }) => {
  const { lead, until, time } = admittedParts(admittedUntil);
  return (
    <>
      {lead}{' '}
      <span className="block text-base font-normal">
        {until} <span className="text-3xl font-bold whitespace-nowrap text-primary">{time}</span>
      </span>
    </>
  );
};

// The card around the queue state: the main colour once it is the student's turn.
export const queueCardClass = (admitted: boolean) =>
  cn(admitted && 'border-primary/40 bg-primary-soft ring-2 ring-primary/15');
