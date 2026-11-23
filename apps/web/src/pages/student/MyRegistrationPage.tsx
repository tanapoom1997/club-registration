import type { StudentClubRef } from '@club-registration/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { alertVariants } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import { fetchStudentRound } from '@/lib/api';
import { useWakeLock } from '@/lib/wake-lock';
import { AdminChangeNotice } from './AdminChangeNotice';
import { HeldClubCard } from './HeldClubCard';
import { LeaveWaitlistPanel } from './LeaveWaitlistPanel';
import { NoRound, RoundHeader, StudentLoadState } from './RoundHeader';
import { PromotedNotice, WaitlistCard } from './WaitlistCard';
import { WritePanel } from '@/components/WritePanel';
import { useFocusRescue } from './focus-rescue';
import { QueueTurnNote } from './QueueTurnNote';
import { useQueueKeepalive } from './queue-ui';
import {
  STUDENT_ROUND_QUERY_KEY,
  retryRead,
  roundRefetchInterval,
  useLogoutOnExpiredSession,
  useStudentWrite,
  writeErrorMessage,
  writeSuccessNotice,
} from './student-ui';

const CLUBS_PATH = '/student/clubs';

const ClubsLink = ({ children }: { children: string }) => (
  <Link className="font-medium text-primary underline underline-offset-4" to={CLUBS_PATH}>
    {children}
  </Link>
);

// The confirmation that is open, with the club it names. Kept apart from the query data so the
// panel and its answer stay on screen when the refetch after a write shows no club any more.
type Target = { kind: 'cancel' | 'leave'; club: StudentClubRef };

export const MyRegistrationPage = () => {
  const [target, setTarget] = useState<Target>();
  const query = useQuery({
    queryKey: STUDENT_ROUND_QUERY_KEY,
    queryFn: fetchStudentRound,
    retry: retryRead,
    refetchInterval: (current) =>
      roundRefetchInterval(current.state.data?.round, current.state.data?.waitlist),
  });
  useLogoutOnExpiredSession(query.error);
  // Neither write names a club: a student holds at most one seat and one waitlist entry.
  const { mutation, start, retry, canRetry } = useStudentWrite();

  const openConfirmation = (next: Target) => {
    mutation.reset();
    setTarget(next);
  };

  const closeConfirmation = () => {
    mutation.reset();
    setTarget(undefined);
  };

  const { data } = query;
  const round = data?.round;
  const registration = data?.registration;
  const waitlist = data?.waitlist;
  // A student who came here from the clubs page (to cancel, say) keeps their place in the queue.
  const turn = useQueueKeepalive(round);
  // The keepalive only keeps the place while its heartbeats go out, which a sleeping phone stops.
  useWakeLock(turn.kind !== 'none');
  const panel = mutation.isSuccess ? undefined : target;
  const panelOpen = panel !== undefined;

  const headingRef = useRef<HTMLHeadingElement>(null);
  const promotedRef = useRef<HTMLParagraphElement>(null);
  const adminChangeRef = useRef<HTMLParagraphElement>(null);
  // A poll can remove the leave button while it has focus (the seat came, an admin removed the
  // entry, the round closed), and the cancel button (an admin removed the seat, the round closed).
  // The notice that explains why comes first: an admin's, else the promotion's.
  const { element: leaveRef, ref: leaveButtonRef } = useFocusRescue<HTMLButtonElement>([
    adminChangeRef,
    promotedRef,
    headingRef,
  ]);
  const { element: cancelRef, ref: cancelButtonRef } = useFocusRescue<HTMLButtonElement>([
    adminChangeRef,
    promotedRef,
    headingRef,
  ]);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const lastPanel = useRef<Target>(undefined);
  // Closing the panel removes the focused element, so focus goes back to the button it came
  // from, as on the clubs page. After the write went through, the notice says what happened (and
  // holds the link to choose a new club), so focus lands there instead. The heading is the last
  // resort (e.g. the round closed while the panel was open).
  const succeeded = mutation.isSuccess;
  useEffect(() => {
    const closed = lastPanel.current;
    if (closed && !panelOpen) {
      const button = closed.kind === 'cancel' ? cancelRef.current : leaveRef.current;
      const preferred = succeeded ? noticeRef.current : button;
      (preferred ?? button ?? noticeRef.current ?? headingRef.current)?.focus();
    }
    lastPanel.current = panel;
  }, [cancelRef, leaveRef, panel, panelOpen, succeeded]);

  const writeState = (kind: Target['kind']) => ({
    pending: mutation.isPending,
    error: mutation.isError ? writeErrorMessage(kind, mutation.error) : undefined,
    canRetry,
    onConfirm: () => start({ kind }),
    onRetry: retry,
    onDismiss: closeConfirmation,
  });

  // One column of cards: on a wide screen a full-width card spreads a few short lines far apart.
  return (
    <section className="max-w-2xl space-y-4">
      <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold focus:outline-none">
        ผลของฉัน
      </h1>

      {!data ? (
        <StudentLoadState
          error={query.error}
          isPending={query.isPending}
          onRetry={() => void query.refetch()}
          skeleton="result"
        />
      ) : !round ? (
        <NoRound />
      ) : (
        <>
          <RoundHeader round={round} />
          <QueueTurnNote turn={turn} />
          <div role="status">
            {mutation.isSuccess && (
              <p
                ref={noticeRef}
                tabIndex={-1}
                className={cn(alertVariants({ variant: 'success' }), 'focus:outline-none')}
              >
                {writeSuccessNotice(mutation.variables.kind, mutation.data)}{' '}
                {mutation.variables.kind === 'cancel' &&
                  !registration &&
                  round.status === 'open' && (
                    <>
                      เลือกชุมนุมใหม่ได้ที่หน้า <ClubsLink>ชุมนุมในชั้นของฉัน</ClubsLink>
                    </>
                  )}
              </p>
            )}
          </div>
          <AdminChangeNotice ref={adminChangeRef} adminChange={data.adminChange} round={round} />
          <PromotedNotice ref={promotedRef} registration={registration} />

          {registration ? (
            <HeldClubCard registration={registration}>
              {panel?.kind === 'cancel' ? null : round.status === 'open' ? (
                <Button
                  ref={cancelButtonRef}
                  variant="outline"
                  className="w-full sm:w-auto"
                  disabled={mutation.isPending}
                  onClick={() => openConfirmation({ kind: 'cancel', club: registration.club })}
                >
                  ยกเลิกชุมนุมนี้
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {round.status === 'closed'
                    ? 'รอบนี้ปิดแล้ว ผลนี้คือชุมนุมของคุณในรอบนี้'
                    : 'ยกเลิกได้เฉพาะช่วงที่รอบเปิดอยู่'}
                </p>
              )}
            </HeldClubCard>
          ) : (
            <Card className="space-y-3 p-4 sm:p-5">
              <p className="font-semibold">ยังไม่ได้ลงชุมนุม</p>
              {round.status === 'closed' ? (
                <p className="text-sm text-muted-foreground">รอบนี้ปิดแล้ว กรุณาติดต่อครูที่ดูแลการลงทะเบียน</p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    ดูรายการชุมนุม ครูที่ปรึกษา และที่ว่าง แล้วลงชุมนุมที่ต้องการได้ที่หน้าเลือกชุมนุม
                  </p>
                  {/* The one thing to do here, so it is the main button, not a link in a sentence;
                      left out while the queue note above already offers the same button. */}
                  {turn.kind === 'none' && (
                    <Link className={cn(buttonVariants(), 'w-full sm:w-auto')} to={CLUBS_PATH}>
                      ไปเลือกชุมนุม
                    </Link>
                  )}
                </>
              )}
            </Card>
          )}
          {panel?.kind === 'cancel' && (
            <WritePanel
              state={writeState('cancel')}
              label={`ยืนยันการยกเลิกชุมนุม ${panel.club.clubCode} ${panel.club.name}`}
              question={`ยกเลิกชุมนุม ${panel.club.clubCode} ${panel.club.name}?`}
              note="ที่นั่งจะว่างทันทีและอาจมีคนอื่นลงแทน ถ้าเปลี่ยนใจภายหลังอาจลงชุมนุมนี้กลับไม่ได้"
              confirmLabel="ยืนยัน ยกเลิกชุมนุม"
              destructive
              pendingLabel="กำลังยกเลิก…"
              dismissLabel="ไม่ยกเลิก"
            />
          )}

          {waitlist && (
            <WaitlistCard waitlist={waitlist} registration={registration ?? null} round={round}>
              {panel?.kind !== 'leave' && round.status === 'open' && (
                <Button
                  ref={leaveButtonRef}
                  variant="outline"
                  className="w-full sm:w-auto"
                  disabled={mutation.isPending}
                  onClick={() => openConfirmation({ kind: 'leave', club: waitlist.club })}
                >
                  ออกจากรายชื่อรอ
                </Button>
              )}
            </WaitlistCard>
          )}
          {panel?.kind === 'leave' && (
            <LeaveWaitlistPanel club={panel.club} state={writeState('leave')} />
          )}
        </>
      )}
    </section>
  );
};
