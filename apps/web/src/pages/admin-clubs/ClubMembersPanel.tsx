import type { AdminClub, Round } from '@club-registration/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { FormError } from '@/components/FormError';
import { SeatBar } from '@/components/SeatMeter';
import { alertVariants } from '@/components/ui/alert';
import { EmptyState, LoadFailed } from '@/components/StatusBlock';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { fetchClubMembers, fetchClubWaitlist } from '@/lib/api';
import { useRevealPanel } from '@/lib/panel-focus';
import { refetchWhileOpen } from '@/lib/round-refetch';
import { cn } from '@/lib/utils';
import { WritePanel } from '@/components/WritePanel';
import { AddMemberForm } from './AddMemberForm';
import { MembersTable, WaitlistTable } from './MemberTables';
import type { RowActions } from './MemberTables';
import { CLUBS_POLL_INTERVAL_MS } from './club-ui';
import {
  memberWriteErrorMessage,
  memberWriteNotice,
  membersQueryKey,
  removeMemberNote,
  useMemberWrite,
  waitlistQueryKey,
} from './club-members-ui';

type RemoveKind = 'removeMember' | 'removeWaiter';
// The confirmation that is open, with the student named when it opened and the button that
// opened it (focus goes back there when it closes).
type Target = { kind: RemoveKind; loginId: string; fullName: string; opener: HTMLButtonElement };

type ClubMembersPanelProps = {
  // The latest copies from the polled clubs list.
  club: AdminClub;
  round: Round;
  // Changes on every click of the club's list button (useRevealPanel).
  reveal: number;
  onClose: () => void;
};

// Writes are offered in every round status: fixing the lists after a round closes is what these
// endpoints are mostly for (README Phase 2, PR 3a decision 2 and PR 3b decision 1).
export const ClubMembersPanel = ({ club, round, reveal, onClose }: ClubMembersPanelProps) => {
  const headingRef = useRevealPanel<HTMLHeadingElement>(reveal);
  // Same timing as the clubs table above it.
  const refetchInterval = () => refetchWhileOpen(round, CLUBS_POLL_INTERVAL_MS);
  const membersQuery = useQuery({
    queryKey: membersQueryKey(club.id),
    queryFn: async () => await fetchClubMembers(club.id),
    refetchInterval,
  });
  const waitlistQuery = useQuery({
    queryKey: waitlistQueryKey(club.id),
    queryFn: async () => await fetchClubWaitlist(club.id),
    refetchInterval,
  });
  const { mutation, send, canRetry } = useMemberWrite(club.id);
  const [target, setTarget] = useState<Target>();
  const noticeRef = useRef<HTMLParagraphElement>(null);

  const panelTarget = mutation.isSuccess ? undefined : target;
  const succeeded = mutation.isSuccess;

  // Closing a confirmation sends focus back to the button that opened it. After a removal went
  // through, that row is gone, so focus goes to the notice saying what happened.
  const lastTarget = useRef<Target>(undefined);
  useEffect(() => {
    const closed = lastTarget.current;
    if (closed && !panelTarget) {
      if (succeeded) noticeRef.current?.focus();
      else closed.opener.focus();
    }
    lastTarget.current = panelTarget;
  }, [panelTarget, succeeded]);

  const closeConfirmation = () => {
    mutation.reset();
    setTarget(undefined);
  };

  const openConfirmation = (next: Target) => {
    mutation.reset();
    setTarget(next);
  };

  const assign = (loginId: string) => {
    setTarget(undefined);
    send({ kind: 'assign', loginId });
  };

  const sentKind = mutation.variables?.kind;
  const errorOf = (kind: RemoveKind) =>
    mutation.isError && sentKind === kind
      ? memberWriteErrorMessage(kind, mutation.error)
      : undefined;

  const confirmationFor =
    (kind: RemoveKind) =>
    (loginId: string): ReactNode => {
      if (panelTarget?.kind !== kind || panelTarget.loginId !== loginId) return undefined;
      const person = `${panelTarget.loginId} ${panelTarget.fullName}`;
      const state = {
        pending: mutation.isPending,
        error: errorOf(kind),
        canRetry,
        onConfirm: () => send({ kind, loginId }),
        onRetry: () => send({ kind, loginId }),
        onDismiss: closeConfirmation,
      };
      return kind === 'removeMember' ? (
        <WritePanel
          state={state}
          label={`ยืนยันการนำ ${person} ออกจากชุมนุม ${club.clubCode}`}
          question={`นำ ${person} ออกจากชุมนุม ${club.clubCode} ${club.name}?`}
          note={removeMemberNote(round.status)}
          confirmLabel="ยืนยัน นำออกจากชุมนุม"
          destructive
          pendingLabel="กำลังนำออก…"
          dismissLabel="ไม่นำออก"
        />
      ) : (
        <WritePanel
          state={state}
          label={`ยืนยันการนำ ${person} ออกจากรายชื่อรอชุมนุม ${club.clubCode}`}
          question={`นำ ${person} ออกจากรายชื่อรอชุมนุม ${club.clubCode} ${club.name}?`}
          note="การนำออกจากรายชื่อรอไม่ทำให้ใครได้ที่ คนที่รอข้างหลังเลื่อนขึ้นหนึ่งลำดับ ถ้านักเรียนเข้ารายชื่อรอใหม่ภายหลังจะต่อท้ายคิว"
          confirmLabel="ยืนยัน นำออกจากรายชื่อรอ"
          destructive
          pendingLabel="กำลังนำออกจากรายชื่อรอ…"
          dismissLabel="ไม่นำออก"
        />
      );
    };

  const actionsFor = (kind: RemoveKind): RowActions => ({
    disabled: mutation.isPending,
    confirmationFor: confirmationFor(kind),
    onRemove: ({ loginId, fullName }, opener) =>
      openConfirmation({ kind, loginId, fullName, opener }),
  });

  const members = membersQuery.data?.members;
  const entries = waitlistQuery.data?.entries;
  // A refusal whose refetch removed the row (e.g. not_registered after someone else removed the
  // student) would lose its message with the row, so it is shown above the lists instead.
  const rowGone =
    panelTarget !== undefined &&
    !(panelTarget.kind === 'removeMember' ? members : entries)?.some(
      ({ loginId }) => loginId === panelTarget.loginId,
    );
  const orphanError = panelTarget && rowGone ? errorOf(panelTarget.kind) : undefined;
  const seats = membersQuery.data?.club;

  return (
    <Card role="region" aria-labelledby="club-members-title">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <h2
            ref={headingRef}
            id="club-members-title"
            tabIndex={-1}
            className="scroll-mt-6 text-base font-bold focus:outline-none sm:scroll-mt-36"
          >
            รายชื่อชุมนุม {club.clubCode} {club.name}
          </h2>
          {seats && (
            <div className="max-w-56 space-y-1.5">
              <p className="text-sm">
                รับ {seats.capacity} · ลงแล้ว {seats.registered} · เหลือ {seats.remaining}
              </p>
              <SeatBar capacity={seats.capacity} remaining={seats.remaining} />
            </div>
          )}
          {round.status === 'closed' && (
            <p className="text-sm text-muted-foreground">
              รอบนี้ปิดแล้ว ยังแก้รายชื่อได้ แต่จะไม่มีใครได้ที่จากรายชื่อรออีก
            </p>
          )}
        </div>
        <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
          ปิด
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        <div role="status">
          {mutation.isSuccess && (
            <p
              ref={noticeRef}
              tabIndex={-1}
              className={cn(alertVariants({ variant: 'success' }), 'focus:outline-none')}
            >
              {memberWriteNotice(mutation.data)}
            </p>
          )}
        </div>
        <FormError message={orphanError} />

        <AddMemberForm
          clubCode={club.clubCode}
          pending={mutation.isPending}
          error={
            mutation.isError && sentKind === 'assign'
              ? memberWriteErrorMessage('assign', mutation.error)
              : undefined
          }
          onSubmit={assign}
        />

        <section aria-labelledby="club-members-heading" className="space-y-3">
          <h3 id="club-members-heading" className="font-semibold">
            สมาชิก{members && ` (${members.length} คน)`}
          </h3>
          {membersQuery.isPending ? (
            <p className="text-muted-foreground">กำลังโหลดรายชื่อสมาชิก…</p>
          ) : membersQuery.isError ? (
            <LoadFailed
              message="โหลดรายชื่อสมาชิกไม่สำเร็จ"
              onRetry={() => void membersQuery.refetch()}
            />
          ) : membersQuery.data.members.length === 0 ? (
            <EmptyState>ยังไม่มีสมาชิก</EmptyState>
          ) : (
            <MembersTable
              clubCode={club.clubCode}
              members={membersQuery.data.members}
              actions={actionsFor('removeMember')}
            />
          )}
        </section>

        <section aria-labelledby="club-waitlist-heading" className="space-y-3">
          <h3 id="club-waitlist-heading" className="font-semibold">
            รายชื่อรอ{entries && ` (${entries.length} คน)`}
          </h3>
          {waitlistQuery.isPending ? (
            <p className="text-muted-foreground">กำลังโหลดรายชื่อรอ…</p>
          ) : waitlistQuery.isError ? (
            <LoadFailed message="โหลดรายชื่อรอไม่สำเร็จ" onRetry={() => void waitlistQuery.refetch()} />
          ) : waitlistQuery.data.entries.length === 0 ? (
            <EmptyState>ไม่มีคนรอ</EmptyState>
          ) : (
            <WaitlistTable
              clubCode={club.clubCode}
              entries={waitlistQuery.data.entries}
              actions={actionsFor('removeWaiter')}
            />
          )}
        </section>
      </CardContent>
    </Card>
  );
};
