import type { StudentRegistration } from '@club-registration/shared';
import { useRef } from 'react';
import type { ReactNode, Ref, RefObject } from 'react';
import { Link } from 'react-router';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useFocusRescue } from './focus-rescue';
import { QUEUE_MESSAGES, queueHeadline, showsClubs } from './queue-ui';
import type { Queue } from './queue-ui';

const MY_REGISTRATION_PATH = '/student/my-registration';

const Note = ({ children }: { children: ReactNode }) => (
  <p className="text-sm text-muted-foreground">{children}</p>
);

type QueueBodyProps = {
  queue: Queue;
  // The student's club in the round, for what the card says once the turn ended.
  registration: StudentRegistration | null;
  actionRef: Ref<HTMLButtonElement>;
};

const QueueBody = ({ queue, registration, actionRef }: QueueBodyProps) => {
  const { view, connectionLost, rejoin, release } = queue;
  const lost = connectionLost && (
    <p className="text-sm text-destructive">{QUEUE_MESSAGES.connectionLost}</p>
  );
  switch (view.kind) {
    case 'off':
      return null;
    case 'joining':
      return <Note>{QUEUE_MESSAGES.keepOpen}</Note>;
    case 'failed':
      return (
        <Button ref={actionRef} variant="outline" className="w-full sm:w-auto" onClick={rejoin}>
          ลองเข้าคิวอีกครั้ง
        </Button>
      );
    case 'waiting':
      // Not a live region: the number moves on most heartbeats (every 4 s) and would talk over
      // whatever the student is reading. It is plain text to read at any time, and the region
      // above announces the change that matters, being let in.
      return (
        <>
          <p className="text-sm">
            ลำดับที่ <span className="text-4xl font-bold text-primary">{view.position}</span>
          </p>
          <p className="text-sm">{QUEUE_MESSAGES.waitingHelp}</p>
          <p className="text-sm font-medium text-warning-foreground">{QUEUE_MESSAGES.keepOpen}</p>
          {lost}
        </>
      );
    case 'admitted':
      return (
        <>
          <Note>{QUEUE_MESSAGES.admittedHelp}</Note>
          <p className="text-sm font-medium text-warning-foreground">{QUEUE_MESSAGES.keepOpen}</p>
          {lost}
          <Button
            ref={actionRef}
            variant="outline"
            className="w-full sm:w-auto"
            disabled={release.pending}
            onClick={release.start}
          >
            เสร็จแล้ว ปล่อยคิว
          </Button>
          <FormError message={release.error} />
        </>
      );
    case 'expired':
    case 'done':
      return (
        <>
          {view.kind === 'expired' && <p className="text-sm">{QUEUE_MESSAGES.expiredHelp}</p>}
          {/* A student who ran out of time before confirming must not read that a club is kept. */}
          {registration ? (
            <p className="text-sm">{QUEUE_MESSAGES.heldKept(registration.club)}</p>
          ) : (
            <p className="text-sm font-medium text-warning-foreground">{QUEUE_MESSAGES.noneHeld}</p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button ref={actionRef} className="w-full sm:w-auto" onClick={rejoin}>
              เข้าคิวใหม่
            </Button>
            <Link
              className="text-sm font-medium text-primary underline underline-offset-4"
              to={MY_REGISTRATION_PATH}
            >
              ดูผลของฉัน
            </Link>
          </div>
        </>
      );
  }
};

type QueueGateProps = {
  queue: Queue;
  registration: StudentRegistration | null;
  // Where focus goes when the queue card itself is gone (the round closed under it).
  headingRef: RefObject<HTMLElement | null>;
  // What only an admitted student (or anyone, in a round without a queue) sees: the club list.
  children: ReactNode;
};

// The queue card above the club list while the round is open. The list keeps one place in the
// tree whether the queue is off or admitted, so a round closing under an admitted student does
// not remount it (and drop the focus inside it).
export const QueueGate = ({ queue, registration, headingRef, children }: QueueGateProps) => {
  const { view } = queue;
  const statusRef = useRef<HTMLParagraphElement>(null);
  // The buttons in the card go when pressed (rejoin, release) and the list goes when a poll ends
  // the turn. Focus then goes to the status line, or to the page heading when the card went too;
  // never anywhere when the removed element did not have it.
  const fallbacks = [statusRef, headingRef];
  const { ref: actionRef } = useFocusRescue<HTMLButtonElement>(fallbacks);
  const { ref: listRef } = useFocusRescue<HTMLDivElement>(fallbacks);

  return (
    <>
      {view.kind !== 'off' && (
        <Card className="space-y-3 p-5" aria-label="คิวเลือกชุมนุม" role="region">
          {/* Always mounted while the card is, so a screen reader hears each transition. */}
          <p
            ref={statusRef}
            role="status"
            tabIndex={-1}
            className="text-lg font-semibold focus:outline-none"
          >
            {queueHeadline(view)}
          </p>
          <QueueBody queue={queue} registration={registration} actionRef={actionRef} />
        </Card>
      )}
      {showsClubs(view) && (
        <div ref={listRef} className="space-y-4">
          {children}
        </div>
      )}
    </>
  );
};
