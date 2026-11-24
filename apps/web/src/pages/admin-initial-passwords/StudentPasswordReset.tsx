import { ERROR_CODES, loginIdSchema } from '@club-registration/shared';
import type { PasswordResetResponse } from '@club-registration/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { FormError } from '@/components/FormError';
import { WritePanel } from '@/components/WritePanel';
import { Button } from '@/components/ui/button';
import { alertVariants } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, isOutcomeUnknown, resetStudentPassword } from '@/lib/api';
import { useReturnFocus } from '@/lib/panel-focus';
import { gradeLabel } from '@/lib/round-display';
import { useSetSession } from '@/lib/session';
import { cn } from '@/lib/utils';
import { PASSWORD_STATUS_QUERY_KEY } from './query-keys';

const UNAUTHORIZED = 401;

const ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  [ERROR_CODES.notFound]: 'ไม่พบนักเรียนรหัสนี้',
  // Only a retry after a lost answer reuses a key: the reset went through, but its password is gone.
  [ERROR_CODES.idempotencyKeyReused]:
    'คำขอก่อนหน้ารีเซ็ตรหัสผ่านไปแล้ว แต่ระบบแสดงรหัสนั้นซ้ำไม่ได้ และรหัสผ่านเดิมของนักเรียนใช้ไม่ได้แล้ว กรุณากดรีเซ็ตอีกครั้งเพื่อรับรหัสใหม่',
  [ERROR_CODES.rateLimited]: 'รีเซ็ตรหัสผ่านถี่เกินไป กรุณารอสักครู่แล้วลองใหม่',
  [ERROR_CODES.forbidden]: 'บัญชีนี้ไม่มีสิทธิ์รีเซ็ตรหัสผ่าน',
  [ERROR_CODES.validationError]: 'รหัสนักเรียนไม่ถูกต้อง',
});

const UNKNOWN_OUTCOME_MESSAGE =
  'ไม่ได้รับคำตอบจากระบบ จึงไม่ทราบว่ารีเซ็ตแล้วหรือยัง กด "ลองอีกครั้ง" เพื่อส่งคำขอเดิม (ระบบจะไม่รีเซ็ตซ้ำ)';

const resetErrorMessage = (error: unknown): string =>
  isOutcomeUnknown(error)
    ? UNKNOWN_OUTCOME_MESSAGE
    : ((error instanceof ApiError ? ERROR_MESSAGES[error.code] : undefined) ??
      'รีเซ็ตรหัสผ่านไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');

type SentReset = { loginId: string; idempotencyKey: string };

// One student's password, for a student who forgot it (README, docs/security.md). The new password
// is in the mutation's data only: never in the URL, storage or other state, and gcTime 0 drops the
// finished mutation from the cache as soon as "เสร็จแล้ว" resets it or the page goes away, rather
// than keeping it there for the default five minutes.
export const StudentPasswordReset = () => {
  const [loginId, setLoginId] = useState('');
  const [validationError, setValidationError] = useState<string>();
  // The login ID being confirmed, as the API takes it (trimmed, lower-cased).
  const [confirming, setConfirming] = useState<string>();
  const setSession = useSetSession();
  const queryClient = useQueryClient();

  // A new key per confirm; only "ลองอีกครั้ง" after an unknown outcome resends the same one, so a
  // reset whose answer was lost is answered 409 instead of done twice. Any answer settles it.
  const sent = useRef<SentReset>(undefined);

  const mutation = useMutation({
    mutationFn: resetStudentPassword,
    gcTime: 0,
    onError: (error) => {
      if (error instanceof ApiError && error.status === UNAUTHORIZED) setSession(null);
    },
    // The student moves to "issued, not yet changed" in the table below. Not awaited: the
    // mutation only turns successful once its own callbacks are done, and the password must not
    // wait for the table.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: PASSWORD_STATUS_QUERY_KEY });
    },
  });

  const inputRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLHeadingElement>(null);
  // Closing the confirmation: to the result when there is one, else back to the button. Closing
  // the result ("เสร็จแล้ว" goes with it): back to the field, ready for the next student.
  useReturnFocus(
    confirming !== undefined,
    mutation.isSuccess ? [resultRef] : [submitRef, inputRef],
  );
  useReturnFocus(mutation.isSuccess, [inputRef]);

  const send = (request: SentReset) => {
    sent.current = request;
    // Per call rather than in the options: these run in the same update that makes the mutation
    // successful, so the confirmation closes on the render that shows the result, and focus goes
    // to it (useReturnFocus) instead of to a submit button about to make way for it.
    mutation.mutate(request, {
      onSuccess: () => {
        setConfirming(undefined);
        setLoginId('');
      },
    });
  };

  const dismiss = () => {
    setConfirming(undefined);
    mutation.reset();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = loginIdSchema.safeParse(loginId);
    if (!parsed.success) {
      setValidationError('กรุณากรอกรหัสนักเรียนให้ถูกต้อง (a-z 0-9 . _ - ไม่เกิน 64 ตัว)');
      return;
    }
    setValidationError(undefined);
    mutation.reset();
    setConfirming(parsed.data);
  };

  const result: PasswordResetResponse | undefined = mutation.data;

  return (
    <Card className="max-w-md space-y-4 p-4 sm:p-6">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">รีเซ็ตรหัสผ่านรายคน</h2>
        <p className="text-sm text-muted-foreground">
          สำหรับนักเรียนที่ลืมรหัสผ่าน รวมถึงคนที่เปลี่ยนรหัสเองไปแล้ว ระบบสุ่มรหัสใหม่ให้หนึ่งคน
          รหัสผ่านเดิมใช้ไม่ได้ทันทีและนักเรียนจะถูกออกจากระบบทุกเครื่อง นักเรียนต้องตั้งรหัสผ่านใหม่เมื่อเข้าสู่ระบบครั้งถัดไป
        </p>
      </div>

      {result ? (
        <section
          aria-labelledby="reset-result-title"
          className={cn(alertVariants({ variant: 'success' }), 'space-y-3')}
        >
          <h3
            id="reset-result-title"
            ref={resultRef}
            tabIndex={-1}
            className="font-semibold focus:outline-none"
          >
            รีเซ็ตรหัสผ่านแล้ว
          </h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">รหัสนักเรียน</dt>
            <dd>{result.student.loginId}</dd>
            <dt className="text-muted-foreground">ชื่อ</dt>
            <dd>{result.student.fullName}</dd>
            <dt className="text-muted-foreground">ชั้น</dt>
            {/* The classroom is free text from the import (often "4/1"), shown as the status table
                below shows it, beside the grade rather than joined to it. */}
            <dd>
              {gradeLabel(result.student.grade)} ห้อง {result.student.classroom} เลขที่{' '}
              {result.student.seatNo}
            </dd>
          </dl>
          <div className="space-y-1">
            <p className="text-sm">รหัสผ่านใหม่</p>
            <p className="font-mono text-3xl font-bold tracking-widest break-all select-all">
              {result.password}
            </p>
          </div>
          <p className="text-sm font-medium">
            รหัสผ่านนี้แสดงครั้งเดียว ดูซ้ำไม่ได้อีก จดไว้หรือแจ้งนักเรียนตอนนี้ ถ้าหายต้องรีเซ็ตใหม่
          </p>
          <Button onClick={() => mutation.reset()}>เสร็จแล้ว</Button>
        </section>
      ) : (
        <form aria-label="รีเซ็ตรหัสผ่านรายคน" className="space-y-2" onSubmit={handleSubmit} noValidate>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-full max-w-60 space-y-1.5">
              <Label htmlFor="reset-login-id">รหัสนักเรียน</Label>
              <Input
                id="reset-login-id"
                ref={inputRef}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={loginId}
                disabled={mutation.isPending}
                onChange={(event) => {
                  setLoginId(event.target.value);
                  // Another student: the question on screen is no longer the one being asked.
                  if (confirming !== undefined) dismiss();
                }}
                required
              />
            </div>
            {confirming === undefined && (
              <Button ref={submitRef} type="submit" variant="outline" disabled={mutation.isPending}>
                รีเซ็ตรหัสผ่าน
              </Button>
            )}
          </div>
          <FormError message={validationError} />
        </form>
      )}

      {confirming !== undefined && (
        <WritePanel
          state={{
            pending: mutation.isPending,
            error: mutation.isError ? resetErrorMessage(mutation.error) : undefined,
            canRetry: mutation.isError && isOutcomeUnknown(mutation.error),
            onConfirm: () => send({ loginId: confirming, idempotencyKey: crypto.randomUUID() }),
            onRetry: () => {
              if (sent.current) send(sent.current);
            },
            onDismiss: dismiss,
          }}
          label="ยืนยันการรีเซ็ตรหัสผ่าน"
          question={`รีเซ็ตรหัสผ่านของนักเรียนรหัส ${confirming}?`}
          note={
            <>
              <p>รหัสผ่านเดิมจะใช้ไม่ได้ทันที และนักเรียนจะถูกออกจากระบบทุกเครื่อง</p>
              <p>รหัสผ่านใหม่จะแสดงบนหน้านี้ครั้งเดียวหลังยืนยัน</p>
            </>
          }
          confirmLabel="ยืนยัน รีเซ็ตรหัสผ่าน"
          pendingLabel="กำลังรีเซ็ตรหัสผ่าน…"
          dismissLabel="ยกเลิก"
          destructive
        />
      )}
    </Card>
  );
};
