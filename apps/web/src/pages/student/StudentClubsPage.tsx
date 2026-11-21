import type { StudentClubRef, StudentClubsResponse } from '@club-registration/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { FormError } from '@/components/FormError';
import { alertVariants } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { fetchStudentClubs } from '@/lib/api';
import { formatThaiDateTime } from '@/lib/thai-time';
import { cn } from '@/lib/utils';
import { ClubCard } from './ClubCard';
import type { ClubWrite } from './ClubCard';
import { HeldClubCard } from './HeldClubCard';
import { NoRound, RoundHeader, StudentLoadState } from './RoundHeader';
import { PromotedNotice, WaitlistCard } from './WaitlistCard';
import { LeaveWaitlistPanel } from './LeaveWaitlistPanel';
import { useFocusRescue } from './focus-rescue';
import {
  CLUBS_POLL_INTERVAL_MS,
  STUDENT_CLUBS_QUERY_KEY,
  clubOffer,
  clubsRefetchInterval,
  isClubFull,
  isNoticeOutdated,
  retryRead,
  useLogoutOnExpiredSession,
  useStudentWrite,
  writeErrorMessage,
  writeSuccessNotice,
} from './student-ui';
import type { ClubWriteKind } from './student-ui';

const MY_REGISTRATION_PATH = '/student/my-registration';

// The confirmation that is open: one club's action, or leaving the waitlist (with the club named
// when it opened, so its answer stays on screen after a refetch shows no entry any more).
type Target = { kind: ClubWriteKind; clubId: number } | { kind: 'leave'; club: StudentClubRef };

const RoundHint = ({ data: { round, registration } }: { data: StudentClubsResponse }) => {
  if (!round) return null;
  if (round.status === 'upcoming') {
    return (
      <p className="text-sm text-muted-foreground">
        รอบนี้ยังไม่เปิด ลงได้ตั้งแต่ {formatThaiDateTime(round.opensAt)} น.
        เมื่อถึงเวลาหน้านี้จะเปิดให้ลงเอง ไม่ต้องโหลดใหม่
      </p>
    );
  }
  if (round.status === 'closed') {
    return <p className="text-sm text-muted-foreground">รอบนี้ปิดรับลงทะเบียนแล้ว</p>;
  }
  return (
    <p className="text-sm text-muted-foreground">
      {registration ? '' : 'กดลงชุมนุมที่ต้องการได้ 1 ชุมนุม '}
      ชุมนุมที่เต็มหรือมีคนรออยู่เข้ารายชื่อรอได้ 1 ชุมนุม จำนวนที่เหลืออัปเดตอัตโนมัติทุก{' '}
      {CLUBS_POLL_INTERVAL_MS / 1000} วินาที
    </p>
  );
};

export const StudentClubsPage = () => {
  const [target, setTarget] = useState<Target>();
  const query = useQuery({
    queryKey: STUDENT_CLUBS_QUERY_KEY,
    queryFn: fetchStudentClubs,
    retry: retryRead,
    refetchInterval: (current) => clubsRefetchInterval(current.state.data?.round),
  });
  useLogoutOnExpiredSession(query.error);
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
  const round = data?.round ?? null;
  const panelTarget = mutation.isSuccess ? undefined : target;
  const panelOpen = panelTarget !== undefined;
  const succeeded = mutation.isSuccess;

  const headingRef = useRef<HTMLHeadingElement>(null);
  const promotedRef = useRef<HTMLParagraphElement>(null);
  // A poll can remove the leave button or the join notice while it has focus.
  const { element: leaveRef, ref: leaveButtonRef } = useFocusRescue<HTMLButtonElement>([
    promotedRef,
    headingRef,
  ]);
  const { element: noticeRef, ref: noticeElementRef } = useFocusRescue<HTMLParagraphElement>([
    promotedRef,
    headingRef,
  ]);
  const lastPanel = useRef<Target>(undefined);
  // A club card returns focus to its own button. After a write went through, that button (or the
  // waitlist card's) is gone, so focus goes to the notice saying what happened (or, when a join's
  // seat came before its answer showed, to the promoted notice); after leaving the confirmation
  // of leave, back to its button, or the heading if the entry is gone.
  useEffect(() => {
    const closed = lastPanel.current;
    if (closed && !panelOpen) {
      if (succeeded) (noticeRef.current ?? promotedRef.current ?? headingRef.current)?.focus();
      else if (closed.kind === 'leave') (leaveRef.current ?? headingRef.current)?.focus();
    }
    lastPanel.current = panelTarget;
  }, [leaveRef, noticeRef, panelOpen, panelTarget, succeeded]);

  const clubWrite = (kind: ClubWriteKind, clubId: number): ClubWrite => ({
    kind,
    pending: mutation.isPending,
    error: mutation.isError ? writeErrorMessage(kind, mutation.error) : undefined,
    canRetry,
    onConfirm: () => start({ kind, clubId }),
    onRetry: retry,
    onDismiss: closeConfirmation,
    // README waitlist rule 1: a full club offers its waitlist with the refusal.
    followUp:
      kind !== 'join' && isClubFull(mutation.error) && round?.status === 'open'
        ? {
            label: 'เข้ารายชื่อรอชุมนุมนี้',
            onClick: () => openConfirmation({ kind: 'join', clubId }),
          }
        : undefined,
  });

  // The club's own card shows its answer, unless the refetch removed that club.
  const orphanError =
    mutation.isError &&
    panelTarget !== undefined &&
    panelTarget.kind !== 'leave' &&
    !data?.clubs.some(({ id }) => id === panelTarget.clubId)
      ? writeErrorMessage(panelTarget.kind, mutation.error)
      : undefined;

  return (
    <section className="space-y-4">
      <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold focus:outline-none">
        ชุมนุมในชั้นของฉัน
      </h1>

      {!data ? (
        <StudentLoadState
          error={query.error}
          isPending={query.isPending}
          onRetry={() => void query.refetch()}
        />
      ) : !round ? (
        <NoRound />
      ) : (
        <>
          <RoundHeader round={round} />
          {query.isRefetchError && (
            <p className="text-sm text-muted-foreground">
              เชื่อมต่อระบบไม่ได้ชั่วคราว ตัวเลขที่เห็นอาจไม่ใช่ล่าสุด
            </p>
          )}
          <div role="status">
            {mutation.isSuccess &&
              !isNoticeOutdated(mutation.variables.kind, mutation.data, data.waitlist) && (
                <p
                  ref={noticeElementRef}
                  tabIndex={-1}
                  className={cn(alertVariants({ variant: 'success' }), 'focus:outline-none')}
                >
                  {writeSuccessNotice(mutation.variables.kind, mutation.data)}
                </p>
              )}
          </div>
          <PromotedNotice ref={promotedRef} registration={data.registration} />
          <FormError message={orphanError} />
          {data.registration && (
            <HeldClubCard registration={data.registration}>
              <p className="text-sm">
                ลงได้ 1 ชุมนุมต่อรอบ
                {round.status === 'open' &&
                  ' ถ้าจะเปลี่ยน กด "ย้ายมาชุมนุมนี้" ที่ชุมนุมที่ยังมีที่ว่าง (ได้ที่ใหม่ก่อนจึงออกจากที่เดิม) หรือเข้ารายชื่อรอของชุมนุมที่เต็ม'}{' '}
                <Link
                  className="font-medium text-primary underline underline-offset-4"
                  to={MY_REGISTRATION_PATH}
                >
                  ดูผลของฉันและยกเลิก
                </Link>
              </p>
            </HeldClubCard>
          )}
          {data.waitlist && (
            <WaitlistCard waitlist={data.waitlist} registration={data.registration} round={round}>
              {panelTarget?.kind !== 'leave' && round.status === 'open' && (
                <Button
                  ref={leaveButtonRef}
                  variant="outline"
                  className="w-full sm:w-auto"
                  disabled={mutation.isPending}
                  onClick={() => {
                    if (data.waitlist)
                      openConfirmation({ kind: 'leave', club: data.waitlist.club });
                  }}
                >
                  ออกจากรายชื่อรอ
                </Button>
              )}
            </WaitlistCard>
          )}
          {panelTarget?.kind === 'leave' && (
            <LeaveWaitlistPanel
              club={panelTarget.club}
              state={{
                pending: mutation.isPending,
                error: mutation.isError ? writeErrorMessage('leave', mutation.error) : undefined,
                canRetry,
                onConfirm: () => start({ kind: 'leave' }),
                onRetry: retry,
                onDismiss: closeConfirmation,
              }}
            />
          )}
          <RoundHint data={data} />

          <h2 className="text-lg font-semibold">รายการชุมนุม ({data.clubs.length})</h2>
          {data.clubs.length === 0 ? (
            <p className="text-muted-foreground">รอบนี้ยังไม่มีชุมนุม</p>
          ) : (
            <ul aria-label="รายการชุมนุม" className="grid gap-3 md:grid-cols-2">
              {data.clubs.map((club) => (
                <li key={club.id}>
                  <ClubCard
                    club={club}
                    registration={data.registration}
                    waitlist={data.waitlist}
                    offer={clubOffer(club, {
                      round,
                      registration: data.registration,
                      waitlist: data.waitlist,
                    })}
                    enabled={round.status === 'open' && !mutation.isPending}
                    write={
                      panelTarget?.kind !== 'leave' && panelTarget?.clubId === club.id
                        ? clubWrite(panelTarget.kind, club.id)
                        : undefined
                    }
                    onStart={(kind) => openConfirmation({ kind, clubId: club.id })}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
};
