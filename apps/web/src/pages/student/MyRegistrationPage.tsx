import type { StudentRegistration } from '@club-registration/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { cancelRegistration, fetchStudentRound } from '@/lib/api';
import { HeldClubCard } from './HeldClubCard';
import { NoRound, RoundHeader, StudentLoadState } from './RoundHeader';
import { WritePanel } from './WritePanel';
import {
  STUDENT_ROUND_QUERY_KEY,
  cancelErrorMessage,
  retryRead,
  roundRefetchInterval,
  useLogoutOnExpiredSession,
  useStudentWrite,
} from './student-ui';

const CLUBS_PATH = '/student/clubs';

const ClubsLink = ({ children }: { children: string }) => (
  <Link className="text-primary underline" to={CLUBS_PATH}>
    {children}
  </Link>
);

export const MyRegistrationPage = () => {
  // Kept apart from the query data so the panel and its answer stay on screen when the refetch
  // after a cancel shows no club any more.
  const [confirming, setConfirming] = useState<StudentRegistration['club']>();
  const query = useQuery({
    queryKey: STUDENT_ROUND_QUERY_KEY,
    queryFn: fetchStudentRound,
    retry: retryRead,
    refetchInterval: (current) => roundRefetchInterval(current.state.data?.round),
  });
  useLogoutOnExpiredSession(query.error);
  // Cancel names no club: a student holds at most one seat in their round.
  const { mutation, start, retry, canRetry } = useStudentWrite<object>(cancelRegistration);

  const openConfirmation = (club: StudentRegistration['club']) => {
    mutation.reset();
    setConfirming(club);
  };

  const closeConfirmation = () => {
    mutation.reset();
    setConfirming(undefined);
  };

  const { data } = query;
  const round = data?.round;
  const registration = data?.registration;
  const panelClub = mutation.isSuccess ? undefined : confirming;

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">ผลของฉัน</h1>

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
          <div role="status">
            {mutation.isSuccess && (
              <p className="rounded-md bg-success p-3 text-sm text-success-foreground">
                ยกเลิกชุมนุมแล้ว{' '}
                {round.status === 'open' && (
                  <>
                    เลือกชุมนุมใหม่ได้ที่หน้า <ClubsLink>ชุมนุมในชั้นของฉัน</ClubsLink>
                  </>
                )}
              </p>
            )}
          </div>

          {registration ? (
            <HeldClubCard registration={registration}>
              {panelClub ? null : round.status === 'open' ? (
                <Button
                  variant="outline"
                  className="w-full sm:w-auto"
                  onClick={() => openConfirmation(registration.club)}
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
            <div className="space-y-2 rounded-lg border border-border bg-card p-4">
              <p className="font-medium">ยังไม่ได้ลงชุมนุม</p>
              {round.status === 'closed' ? (
                <p className="text-sm text-muted-foreground">
                  รอบนี้ปิดแล้ว กรุณาติดต่อครูที่ดูแลการลงทะเบียน
                </p>
              ) : (
                <p className="text-sm">
                  ดูรายการและลงชุมนุมได้ที่หน้า <ClubsLink>ชุมนุมในชั้นของฉัน</ClubsLink>
                </p>
              )}
            </div>
          )}
          {panelClub && (
            <WritePanel
              state={{
                pending: mutation.isPending,
                error: mutation.isError ? cancelErrorMessage(mutation.error) : undefined,
                canRetry,
                onConfirm: () => start({}),
                onRetry: retry,
                onDismiss: closeConfirmation,
              }}
              label={`ยืนยันการยกเลิกชุมนุม ${panelClub.clubCode} ${panelClub.name}`}
              question={`ยกเลิกชุมนุม ${panelClub.clubCode} ${panelClub.name}?`}
              note="ที่นั่งจะว่างทันทีและอาจมีคนอื่นลงแทน ถ้าเปลี่ยนใจภายหลังอาจลงชุมนุมนี้กลับไม่ได้"
              confirmLabel="ยืนยัน ยกเลิกชุมนุม"
              pendingLabel="กำลังยกเลิก…"
              dismissLabel="ไม่ยกเลิก"
            />
          )}
        </>
      )}
    </section>
  );
};
