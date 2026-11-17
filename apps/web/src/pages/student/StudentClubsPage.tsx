import type { StudentClubsResponse, StudentRegistrationResponse } from '@club-registration/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { FormError } from '@/components/FormError';
import { fetchStudentClubs, registerForClub } from '@/lib/api';
import { formatThaiDateTime } from '@/lib/thai-time';
import { ClubCard } from './ClubCard';
import { HeldClubCard } from './HeldClubCard';
import { NoRound, RoundHeader, StudentLoadState } from './RoundHeader';
import {
  CLUBS_POLL_INTERVAL_MS,
  STUDENT_CLUBS_QUERY_KEY,
  clubsRefetchInterval,
  registerErrorMessage,
  retryRead,
  useLogoutOnExpiredSession,
  useStudentWrite,
} from './student-ui';

const MY_REGISTRATION_PATH = '/student/my-registration';

const registeredNotice = ({ registration }: StudentRegistrationResponse): string =>
  registration
    ? `ลงชุมนุม ${registration.club.clubCode} ${registration.club.name} เรียบร้อยแล้ว`
    : // A replayed key answers with the state now, which a cancel elsewhere may have emptied.
      'ยังไม่ได้ลงชุมนุมนี้ กรุณาดูรายการล่าสุดแล้วลองใหม่';

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
      จำนวนที่เหลืออัปเดตอัตโนมัติทุก {CLUBS_POLL_INTERVAL_MS / 1000} วินาที
    </p>
  );
};

export const StudentClubsPage = () => {
  // The club whose confirmation is open.
  const [targetId, setTargetId] = useState<number>();
  const query = useQuery({
    queryKey: STUDENT_CLUBS_QUERY_KEY,
    queryFn: fetchStudentClubs,
    retry: retryRead,
    refetchInterval: (current) => clubsRefetchInterval(current.state.data?.round),
  });
  useLogoutOnExpiredSession(query.error);
  const { mutation, start, retry, canRetry } = useStudentWrite<{ clubId: number }>(registerForClub);

  const openConfirmation = (clubId: number) => {
    mutation.reset();
    setTargetId(clubId);
  };

  const closeConfirmation = () => {
    mutation.reset();
    setTargetId(undefined);
  };

  const { data } = query;

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold">ชุมนุมในชั้นของฉัน</h1>

      {!data ? (
        <StudentLoadState
          error={query.error}
          isPending={query.isPending}
          onRetry={() => void query.refetch()}
        />
      ) : !data.round ? (
        <NoRound />
      ) : (
        <>
          <RoundHeader round={data.round} />
          {query.isRefetchError && (
            <p className="text-sm text-muted-foreground">
              เชื่อมต่อระบบไม่ได้ชั่วคราว ตัวเลขที่เห็นอาจไม่ใช่ล่าสุด
            </p>
          )}
          <div role="status">
            {mutation.isSuccess && (
              <p className="rounded-md bg-success p-3 text-sm text-success-foreground">
                {registeredNotice(mutation.data)}
              </p>
            )}
          </div>
          {/* The club's own card shows its answer, unless the refetch removed that club. */}
          <FormError
            message={
              mutation.isError && !data.clubs.some(({ id }) => id === targetId)
                ? registerErrorMessage(mutation.error)
                : undefined
            }
          />
          {data.registration && (
            <HeldClubCard registration={data.registration}>
              <p className="text-sm">
                ลงได้ 1 ชุมนุมต่อรอบ ถ้าจะเปลี่ยนต้องยกเลิกชุมนุมนี้ก่อน{' '}
                <Link className="text-primary underline" to={MY_REGISTRATION_PATH}>
                  ดูผลของฉันและยกเลิก
                </Link>
              </p>
            </HeldClubCard>
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
                    held={data.registration?.club.id === club.id}
                    holdsClub={data.registration !== null}
                    canRegister={data.round?.status === 'open' && !mutation.isPending}
                    write={
                      targetId === club.id && !mutation.isSuccess
                        ? {
                            pending: mutation.isPending,
                            error: mutation.isError
                              ? registerErrorMessage(mutation.error)
                              : undefined,
                            canRetry,
                            onConfirm: () => start({ clubId: club.id }),
                            onRetry: retry,
                            onDismiss: closeConfirmation,
                          }
                        : undefined
                    }
                    onRegister={() => openConfirmation(club.id)}
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
