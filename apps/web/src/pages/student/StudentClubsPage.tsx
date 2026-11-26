import type { StudentClubRef, StudentRoundResponse } from '@club-registration/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { FormError } from '@/components/FormError';
import { alertVariants } from '@/components/ui/alert';
import { EmptyState } from '@/components/StatusBlock';
import { Button } from '@/components/ui/button';
import { fetchStudentClubs, fetchStudentRound } from '@/lib/api';
import { formatThaiDateTime } from '@/lib/thai-time';
import { cn } from '@/lib/utils';
import { useWakeLock } from '@/lib/wake-lock';
import { ClubCard } from './ClubCard';
import type { ClubWrite } from './ClubCard';
import { AdminChangeNotice } from './AdminChangeNotice';
import { HeldClubCard } from './HeldClubCard';
import { NoRound, RoundHeader, StudentLoadState } from './RoundHeader';
import { PromotedNotice, WaitlistCard } from './WaitlistCard';
import { LeaveWaitlistPanel } from './LeaveWaitlistPanel';
import { QueueGate } from './QueueGate';
import { ClubFilterBar } from './ClubFilterBar';
import {
  CLUB_FILTER_MESSAGES,
  NO_FILTER,
  filterClubs,
  filterSummary,
  isFiltering,
} from './club-filter';
import type { ClubFilter } from './club-filter';
import { useFocusRescue } from './focus-rescue';
import {
  isInTurn,
  isQueueRequired,
  queueTurn,
  showsClubs,
  useBackToQueue,
  useQueue,
} from './queue-ui';
import {
  CLUBS_POLL_INTERVAL_MS,
  STUDENT_CLUBS_QUERY_KEY,
  STUDENT_ROUND_QUERY_KEY,
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

// The confirmation that is open: one club's action (with the queue turn it was opened in, see
// isInTurn), or leaving the waitlist (with the club named when it opened, so its answer stays on
// screen after a refetch shows no entry any more). Leaving takes no seat, so it needs no turn.
type Target =
  | { kind: ClubWriteKind; clubId: number; turn: string | undefined }
  | { kind: 'leave'; club: StudentClubRef };

const RoundHint = ({ data: { round, registration } }: { data: StudentRoundResponse }) => {
  if (!round) return null;
  if (round.status === 'upcoming') {
    return (
      <p className="text-sm text-muted-foreground">
        รอบนี้ยังไม่เปิด ลงได้ตั้งแต่ {formatThaiDateTime(round.opensAt)} น. เมื่อถึงเวลาหน้านี้จะเปิดให้ลงเอง
        ไม่ต้องโหลดใหม่
      </p>
    );
  }
  if (round.status === 'closed') {
    return (
      <p className="text-sm text-muted-foreground">
        รอบนี้ปิดรับลงทะเบียนแล้ว จำนวนด้านล่างคือจำนวนที่ลงไว้ตอนปิดรอบ
      </p>
    );
  }
  // A student who holds a club reads how to change, waitlist included, on the held card right
  // above, so here they get only what the card does not say.
  return (
    <p className="max-w-prose text-sm text-muted-foreground">
      {!registration && 'กดลงชุมนุมที่ต้องการได้ 1 ชุมนุม ชุมนุมที่เต็มหรือมีคนรออยู่เข้ารายชื่อรอได้ 1 ชุมนุม '}
      จำนวนที่เหลืออัปเดตอัตโนมัติทุก {CLUBS_POLL_INTERVAL_MS / 1000} วินาที
    </p>
  );
};

export const StudentClubsPage = () => {
  const [target, setTarget] = useState<Target>();
  // The page starts from the round read, not the club list (Q2): while the round is open the list
  // answers 403 queue_required until the student's turn, so only this read can tell the page to
  // queue. It polls as the list used to, which keeps a waiting student's own club, waitlist place
  // and promotion notice current without the list.
  const roundQuery = useQuery({
    queryKey: STUDENT_ROUND_QUERY_KEY,
    queryFn: fetchStudentRound,
    retry: retryRead,
    refetchInterval: (current) => clubsRefetchInterval(current.state.data?.round),
  });
  useLogoutOnExpiredSession(roundQuery.error);
  const round = roundQuery.data?.round ?? null;
  const queue = useQueue(round);
  const turn = queueTurn(queue.view);
  // A live ticket stops being one after about a minute without a heartbeat, which a phone whose
  // screen went off no longer sends (U1).
  useWakeLock(queue.view.kind === 'waiting' || queue.view.kind === 'admitted');
  // The list only where the API gives it: a round that is not open, or has no queue (Q4), where
  // the queue is off, or the student's turn. Never while joining, waiting, or once the turn ended,
  // which would only earn 403s.
  const listAllowed = round !== null && showsClubs(queue.view);
  const clubsQuery = useQuery({
    queryKey: STUDENT_CLUBS_QUERY_KEY,
    queryFn: fetchStudentClubs,
    enabled: listAllowed,
    retry: retryRead,
    // The round read above notices the status changes; the counts only move while it is open.
    refetchInterval: () => (round?.status === 'open' ? CLUBS_POLL_INTERVAL_MS : false),
  });
  useLogoutOnExpiredSession(clubsQuery.error);
  useBackToQueue(clubsQuery.error, round?.id);
  const clubsData = listAllowed ? clubsQuery.data : undefined;
  // The student's own club and waitlist place from whichever answer is newer: both carry them, and
  // a write's answer is put into both.
  const data =
    clubsData && clubsQuery.dataUpdatedAt >= roundQuery.dataUpdatedAt ? clubsData : roundQuery.data;
  const clubs = clubsData?.clubs;
  const { mutation, start, retry, canRetry } = useStudentWrite();

  const openConfirmation = (next: Target) => {
    mutation.reset();
    setTarget(next);
  };

  const closeConfirmation = () => {
    mutation.reset();
    setTarget(undefined);
  };

  const outOfTurn =
    target !== undefined && target.kind !== 'leave' && !isInTurn(queue.view, target.turn);
  const panelTarget = mutation.isSuccess || outOfTurn ? undefined : target;
  const panelOpen = panelTarget !== undefined;
  const succeeded = mutation.isSuccess;

  const [filter, setFilter] = useState<ClubFilter>(NO_FILTER);
  // A closed round has no seat filter (ClubFilterBar), so a "ยังรับ" chosen while it was open
  // stops applying instead of hiding every club behind a control that is gone.
  const roundClosed = round?.status === 'closed';
  const applied = (chosen: ClubFilter): ClubFilter =>
    roundClosed ? { ...chosen, seats: 'all' } : chosen;
  const [announcement, setAnnouncement] = useState('');
  const keepId =
    panelTarget !== undefined && panelTarget.kind !== 'leave' ? panelTarget.clubId : undefined;
  const shownClubs = clubs && filterClubs(clubs, applied(filter), keepId);
  const filtering = isFiltering(applied(filter));
  // Announced from here, when the student changes the filter, and never from a poll's counts.
  const changeFilter = (next: ClubFilter) => {
    setFilter(next);
    if (clubs) {
      const shown = filterClubs(clubs, applied(next), keepId).length;
      setAnnouncement(filterSummary(applied(next), shown, clubs.length));
    }
  };
  const searchRef = useRef<HTMLInputElement>(null);
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  // The clear button goes with the empty list it sits in: the search field takes focus instead.
  const clearFilter = () => {
    changeFilter(NO_FILTER);
    searchRef.current?.focus();
  };

  const headingRef = useRef<HTMLHeadingElement>(null);
  const promotedRef = useRef<HTMLParagraphElement>(null);
  const adminChangeRef = useRef<HTMLParagraphElement>(null);
  // A poll can remove the leave button or the join notice while it has focus, and (an admin
  // removed the seat) the link in the held club's card. The notice that explains why comes first:
  // an admin's, else the promotion's.
  const rescueTo = [adminChangeRef, promotedRef, headingRef];
  const { element: leaveRef, ref: leaveButtonRef } = useFocusRescue<HTMLButtonElement>(rescueTo);
  const { element: noticeRef, ref: noticeElementRef } =
    useFocusRescue<HTMLParagraphElement>(rescueTo);
  // On the line around the link: Link merges refs into one callback, which drops a callback ref's
  // cleanup, and the cleanup is what tells the rescue that the link had focus.
  const { ref: heldNoteRef } = useFocusRescue<HTMLParagraphElement>(rescueTo);
  // On every item of the club list: a poll can take the focused club out of the filtered list
  // (filled under "ยังรับ"), or out of the round. Focus goes to the line saying how many show.
  const { ref: clubItemRef } = useFocusRescue<HTMLLIElement>([
    summaryRef,
    listHeadingRef,
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
            onClick: () => openConfirmation({ kind: 'join', clubId, turn }),
          }
        : undefined,
  });

  // The club's own card shows its answer, unless the refetch removed that club.
  const orphanError =
    mutation.isError &&
    panelTarget !== undefined &&
    panelTarget.kind !== 'leave' &&
    clubs !== undefined &&
    !clubs.some(({ id }) => id === panelTarget.clubId)
      ? writeErrorMessage(panelTarget.kind, mutation.error)
      : undefined;
  // A queue_required is not a lost connection: the queue card says what happened.
  const connectionLost =
    roundQuery.isRefetchError ||
    (listAllowed && clubsQuery.isRefetchError && !isQueueRequired(clubsQuery.error));

  return (
    <section className="space-y-4">
      <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold focus:outline-none">
        ชุมนุมในชั้นของฉัน
      </h1>

      {!data ? (
        <StudentLoadState
          error={roundQuery.error}
          isPending={roundQuery.isPending}
          onRetry={() => void roundQuery.refetch()}
          skeleton="clubs-page"
        />
      ) : !round ? (
        <NoRound />
      ) : (
        <>
          <RoundHeader round={round} />
          {connectionLost && (
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
          {/* Outside the queue gate: a student waiting for their turn reads the round only. */}
          <AdminChangeNotice ref={adminChangeRef} adminChange={data.adminChange} round={round} />
          <PromotedNotice ref={promotedRef} registration={data.registration} />
          <FormError message={orphanError} />
          {data.registration && (
            <HeldClubCard registration={data.registration}>
              <p ref={heldNoteRef} className="text-sm">
                {/* How to change says there is one club per round already, so the rule on its own
                    is only for when the change buttons are not on screen: before the round opens,
                    or while the student queues. Kept short: it sits above the list on a phone, and
                    the change confirmation says that the old seat is only given up once the new
                    one is taken. Neither matters once the round has closed. */}
                {round.status === 'open' && showsClubs(queue.view)
                  ? 'ถ้าจะเปลี่ยน กด "ย้ายมาชุมนุมนี้" หรือ "เข้ารายชื่อรอ" ที่ชุมนุมที่ต้องการ'
                  : round.status !== 'closed' && 'ลงได้ 1 ชุมนุมต่อรอบ'}{' '}
                <Link
                  className="font-medium text-primary underline underline-offset-4"
                  to={MY_REGISTRATION_PATH}
                >
                  {/* Cancelling is only possible while the round is open. */}
                  {round.status === 'open' ? 'ดูผลของฉันและยกเลิก' : 'ดูผลของฉัน'}
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
          <QueueGate queue={queue} registration={data.registration} headingRef={headingRef}>
            <RoundHint data={data} />

            {!clubs ? (
              <StudentLoadState
                error={clubsQuery.error}
                // A queue_required is followed by the queue card's own state, not an error here.
                isPending={clubsQuery.isPending || isQueueRequired(clubsQuery.error)}
                onRetry={() => void clubsQuery.refetch()}
                skeleton="clubs"
              />
            ) : (
              <h2
                ref={listHeadingRef}
                tabIndex={-1}
                className="text-lg font-semibold focus:outline-none"
              >
                รายการชุมนุม ({clubs.length})
              </h2>
            )}
            {clubs?.length === 0 && <EmptyState>รอบนี้ยังไม่มีชุมนุม</EmptyState>}
            {clubs !== undefined && clubs.length > 0 && (
              <ClubFilterBar
                filter={filter}
                onChange={changeFilter}
                announcement={announcement}
                searchRef={searchRef}
                seatFilter={!roundClosed}
                admittedUntil={
                  queue.view.kind === 'admitted' ? queue.view.admittedUntil : undefined
                }
              />
            )}
            {/* Not a live region: a poll changes these numbers (the filter's own changes are
                announced above). Kept in its own slot so the list below never moves in the tree. */}
            {shownClubs !== undefined && clubs !== undefined && clubs.length > 0 && filtering && (
              <div className="flex flex-wrap items-center gap-3">
                <p
                  ref={summaryRef}
                  tabIndex={-1}
                  className={cn(
                    'text-sm focus:outline-none',
                    shownClubs.length === 0 ? 'font-medium' : 'text-muted-foreground',
                  )}
                >
                  {filterSummary(applied(filter), shownClubs.length, clubs.length)}
                </p>
                {shownClubs.length === 0 && (
                  <Button variant="outline" onClick={clearFilter}>
                    {CLUB_FILTER_MESSAGES.clear}
                  </Button>
                )}
              </div>
            )}
            {shownClubs !== undefined && clubs !== undefined && clubs.length > 0 && (
              <ul aria-label="รายการชุมนุม" className="grid gap-3 md:grid-cols-2">
                {shownClubs.map((club) => (
                  <li key={club.id} ref={clubItemRef}>
                    <ClubCard
                      club={club}
                      registration={data.registration}
                      waitlist={data.waitlist}
                      offer={clubOffer(club, {
                        round,
                        registration: data.registration,
                        waitlist: data.waitlist,
                      })}
                      closed={round.status === 'closed'}
                      enabled={round.status === 'open' && !mutation.isPending}
                      opensAt={round.status === 'upcoming' ? round.opensAt : undefined}
                      write={
                        panelTarget?.kind !== 'leave' && panelTarget?.clubId === club.id
                          ? clubWrite(panelTarget.kind, club.id)
                          : undefined
                      }
                      onStart={(kind) => openConfirmation({ kind, clubId: club.id, turn })}
                    />
                  </li>
                ))}
              </ul>
            )}
          </QueueGate>
        </>
      )}
    </section>
  );
};
