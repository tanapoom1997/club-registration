import { ERROR_CODES } from '@club-registration/shared';
import type { ClassroomPasswordStatus } from '@club-registration/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { CheckboxRow } from '@/components/CheckboxRow';
import { ConfirmPanel } from '@/components/ConfirmPanel';
import { FormError } from '@/components/FormError';
import { EmptyState, LoadFailed } from '@/components/StatusBlock';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { alertVariants } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { ApiError, fetchPasswordStatus, issueInitialPasswords } from '@/lib/api';
import { saveFile } from '@/lib/download';
import { useReturnFocus } from '@/lib/panel-focus';
import { useSetSession } from '@/lib/session';
import { gradeLabel } from '@/lib/round-display';
import { PasswordStatusTable, formatCount } from './PasswordStatusTable';
import { PASSWORD_STATUS_QUERY_KEY as STATUS_QUERY_KEY } from './query-keys';
import { StudentPasswordReset } from './StudentPasswordReset';

const ALL_CLASSROOMS = '';

const ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  [ERROR_CODES.nothingToIssue]:
    'ไม่มีนักเรียนที่ออกรหัสผ่านได้ในขอบเขตนี้แล้ว (อาจเปลี่ยนรหัสเองหรือมีคนออกรหัสให้ไปก่อน) ยังไม่ได้เปลี่ยนแปลงอะไร',
  [ERROR_CODES.idempotencyKeyReused]: 'คำขอนี้ถูกดำเนินการไปแล้ว กรุณากดออกรหัสผ่านใหม่อีกครั้ง',
  [ERROR_CODES.rateLimited]: 'ออกรหัสผ่านถี่เกินไป กรุณารอสักครู่แล้วลองใหม่',
  [ERROR_CODES.forbidden]: 'บัญชีนี้ไม่มีสิทธิ์ออกรหัสผ่าน',
  [ERROR_CODES.validationError]: 'ข้อมูลที่เลือกไม่ถูกต้อง กรุณาเลือกชั้นและห้องใหม่',
});

const issueErrorMessage = (error: unknown): string =>
  (error instanceof ApiError ? ERROR_MESSAGES[error.code] : undefined) ??
  'ออกรหัสผ่านไม่สำเร็จ กรุณาโหลดหน้านี้ใหม่เพื่อดูสถานะล่าสุดก่อนลองอีกครั้ง';

type Scope = { grade: number; classroom: string; onlyUnissued: boolean };

const sumScope = (classrooms: readonly ClassroomPasswordStatus[], { grade, classroom }: Scope) =>
  classrooms
    .filter(
      (row) => row.grade === grade && (classroom === ALL_CLASSROOMS || row.classroom === classroom),
    )
    .reduce(
      (total, row) => ({
        neverIssued: total.neverIssued + row.neverIssued,
        issuedPending: total.issuedPending + row.issuedPending,
      }),
      { neverIssued: 0, issuedPending: 0 },
    );

const scopeLabel = ({ grade, classroom }: Scope) =>
  classroom === ALL_CLASSROOMS ? `${gradeLabel(grade)} ทุกห้อง` : `${gradeLabel(grade)}/${classroom}`;

export const AdminInitialPasswordsPage = () => {
  const [grade, setGrade] = useState<number>();
  const [classroom, setClassroom] = useState(ALL_CLASSROOMS);
  const [onlyUnissued, setOnlyUnissued] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const setSession = useSetSession();
  const queryClient = useQueryClient();

  const statusQuery = useQuery({ queryKey: STATUS_QUERY_KEY, queryFn: fetchPasswordStatus });
  const mutation = useMutation({
    mutationFn: issueInitialPasswords,
    onSuccess: ({ file, filename }) => {
      saveFile(file, filename);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) setSession(null);
    },
    // Success or not, the counts on screen may be stale now (another admin may have issued).
    onSettled: async () => {
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
    },
  });

  // The confirmation replaces the issue button, so focus goes back to the one that renders again.
  // After an issue, the notice saying what happened comes first: the refetched counts may have
  // disabled the button. Open until the request (and the refetch it waits for) has settled, so the
  // result decides where focus goes.
  const issueButtonRef = useRef<HTMLButtonElement>(null);
  const successRef = useRef<HTMLParagraphElement>(null);
  useReturnFocus(
    confirming || mutation.isPending,
    mutation.isSuccess ? [successRef, issueButtonRef] : [issueButtonRef],
  );

  const classrooms = statusQuery.data ?? [];
  const grades = [...new Set(classrooms.map((row) => row.grade))];
  // Until the admin picks one: the first grade with students who never got a password, which is
  // what the page is for. Kept in state once used (see pinScope), so a refetch after an issue,
  // which zeroes that grade, does not move the form to another grade under the result.
  const selectedGrade = grade ?? classrooms.find((row) => row.neverIssued > 0)?.grade ?? grades[0];
  const gradeClassrooms = classrooms.filter((row) => row.grade === selectedGrade);
  const scope: Scope | undefined =
    selectedGrade === undefined ? undefined : { grade: selectedGrade, classroom, onlyUnissued };
  const counts = scope ? sumScope(classrooms, scope) : { neverIssued: 0, issuedPending: 0 };
  const expected = counts.neverIssued + (onlyUnissued ? 0 : counts.issuedPending);
  const invalidates = onlyUnissued ? 0 : counts.issuedPending;

  const pinScope = () => {
    if (grade === undefined) setGrade(selectedGrade);
  };

  // Any change to the choice cancels a pending confirmation and hides the last result.
  const changeScope = (apply: () => void) => {
    pinScope();
    apply();
    setConfirming(false);
    mutation.reset();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    pinScope();
    mutation.reset();
    setConfirming(true);
  };

  const handleConfirm = () => {
    if (!scope) return;
    mutation.mutate({
      grade: scope.grade,
      ...(scope.classroom === ALL_CLASSROOMS ? {} : { classroom: scope.classroom }),
      onlyUnissued: scope.onlyUnissued,
      // One key per click: a replay of this exact request is refused by the server instead of
      // invalidating the file it already sent; a new click is a deliberate new issuance.
      idempotencyKey: crypto.randomUUID(),
    });
  };

  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">รหัสผ่านเริ่มต้น</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          ระบบสุ่มรหัสผ่านให้นักเรียนรายคนและเก็บไว้เฉพาะแบบเข้ารหัส (hash) รหัสผ่านจริงมีอยู่ในไฟล์ Excel
          ที่ดาวน์โหลดตอนกดออกรหัสเท่านั้น ดาวน์โหลดซ้ำไม่ได้ ถ้าไฟล์หายต้องออกรหัสใหม่
          นักเรียนต้องเปลี่ยนรหัสผ่านเมื่อเข้าสู่ระบบครั้งแรก และนักเรียนที่เปลี่ยนรหัสเองแล้วจะไม่ถูกออกรหัสทับ
        </p>
        <p className={cn(alertVariants({ variant: 'warning' }), 'font-medium')}>
          คำเตือน: การออกรหัสผ่านซ้ำให้นักเรียนที่เคยได้รหัสแล้ว ทำให้รหัสผ่านเดิมที่พิมพ์แจกไปใช้ไม่ได้ทันที
          และนักเรียนที่เข้าสู่ระบบด้วยรหัสเดิมอยู่จะถูกออกจากระบบ
        </p>
      </div>

      {statusQuery.isPending ? (
        <p className="text-muted-foreground">กำลังโหลด…</p>
      ) : statusQuery.isError ? (
        <LoadFailed message="โหลดสถานะรหัสผ่านไม่สำเร็จ" onRetry={() => void statusQuery.refetch()} />
      ) : classrooms.length === 0 || !scope ? (
        <EmptyState>
          ยังไม่มีนักเรียนในระบบ ให้{' '}
          <Link
            className="font-medium text-primary underline underline-offset-4"
            to="/admin/import"
          >
            นำเข้า Excel
          </Link>{' '}
          ก่อน
        </EmptyState>
      ) : (
        <>
          <Card className="max-w-md p-4 sm:p-6">
            <form
              aria-label="ออกรหัสผ่านเริ่มต้น"
              className="space-y-4"
              onSubmit={handleSubmit}
              noValidate
            >
              <div className="space-y-1.5">
                <Label htmlFor="issue-grade">ชั้น</Label>
                <Select
                  id="issue-grade"
                  value={scope.grade}
                  disabled={mutation.isPending}
                  onChange={(event) =>
                    changeScope(() => {
                      setGrade(Number(event.target.value));
                      setClassroom(ALL_CLASSROOMS);
                    })
                  }
                >
                  {grades.map((value) => (
                    <option key={value} value={value}>
                      {gradeLabel(value)}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="issue-classroom">ห้อง</Label>
                <Select
                  id="issue-classroom"
                  value={classroom}
                  disabled={mutation.isPending}
                  onChange={(event) => changeScope(() => setClassroom(event.target.value))}
                >
                  <option value={ALL_CLASSROOMS}>ทุกห้องในชั้นนี้</option>
                  {gradeClassrooms.map((row) => (
                    <option key={row.classroom} value={row.classroom}>
                      {row.classroom}
                    </option>
                  ))}
                </Select>
              </div>
              <CheckboxRow
                id="issue-only-unissued"
                label="เฉพาะนักเรียนที่ยังไม่เคยได้รหัสผ่าน"
                description="ไม่แตะรหัสที่ออกไปแล้ว"
                checked={onlyUnissued}
                disabled={mutation.isPending}
                onChange={(checked) => changeScope(() => setOnlyUnissued(checked))}
              />
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {scopeLabel(scope)}: จะออกรหัสผ่านให้ {formatCount(expected)} คน
                {invalidates > 0 && ` (ในนี้ ${formatCount(invalidates)} คนจะได้รหัสใหม่แทนรหัสเดิม)`}
              </p>
              {!confirming && (
                <Button
                  ref={issueButtonRef}
                  type="submit"
                  className="w-full sm:w-auto"
                  disabled={expected === 0 || mutation.isPending}
                >
                  ออกรหัสผ่านและดาวน์โหลด
                </Button>
              )}
            </form>
          </Card>

          {confirming && (
            <ConfirmPanel
              label="ยืนยันการออกรหัสผ่าน"
              message={`ออกรหัสผ่านให้ ${scopeLabel(scope)} ประมาณ ${formatCount(expected)} คน?`}
              confirmLabel="ยืนยัน ออกรหัสผ่าน"
              pending={mutation.isPending}
              pendingLabel="กำลังสร้างรหัสผ่าน…"
              pendingNote="กำลังสร้างรหัสผ่าน… อาจใช้เวลาหลายวินาที กรุณาอย่าปิดหน้านี้"
              onConfirm={handleConfirm}
              onCancel={() => setConfirming(false)}
              className="max-w-xl"
            >
              {invalidates > 0 && (
                <p className="text-sm font-medium">
                  รหัสผ่านเดิมของนักเรียน {formatCount(invalidates)} คนที่พิมพ์แจกไปแล้วจะใช้ไม่ได้ทันที
                  ต้องแจกรหัสจากไฟล์ใหม่นี้แทน
                </p>
              )}
              <p className="text-sm">
                ไฟล์ที่ได้คือสำเนาเดียวของรหัสผ่าน เก็บรักษาให้ดีและอย่าส่งต่อทางช่องทางสาธารณะ
              </p>
            </ConfirmPanel>
          )}

          <FormError message={mutation.isError ? issueErrorMessage(mutation.error) : undefined} />
          {mutation.isSuccess && (
            <p
              ref={successRef}
              tabIndex={-1}
              className={cn(alertVariants({ variant: 'success' }), 'focus:outline-none')}
              role="status"
            >
              ออกรหัสผ่านให้ {formatCount(mutation.data.issuedCount)} คนแล้ว ดาวน์โหลดไฟล์{' '}
              {mutation.data.filename} แล้ว ไฟล์นี้ดาวน์โหลดซ้ำไม่ได้ ถ้าไม่พบไฟล์ในเครื่องต้องออกรหัสใหม่
              (รหัสในไฟล์เดิมจะใช้ไม่ได้)
            </p>
          )}
        </>
      )}

      {/* Outside the branches above, so a status refetch that fails or empties the list never
          unmounts it and loses a password still on screen. */}
      <StudentPasswordReset />

      {statusQuery.isSuccess && classrooms.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">สถานะรายห้อง</h2>
          <PasswordStatusTable classrooms={classrooms} />
        </div>
      )}
    </section>
  );
};
