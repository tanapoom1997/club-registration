import { loginIdSchema } from '@club-registration/shared';
import type { Round } from '@club-registration/shared';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StudentFinder } from './StudentFinder';

type AddMemberFormProps = {
  round: Round;
  clubId: number;
  clubCode: string;
  pending: boolean;
  // The refusal of the last assign, or that its outcome is unknown.
  error: string | undefined;
  // Called with the login ID as the API takes it (trimmed, lower-cased).
  onSubmit: (loginId: string) => void;
};

// The admin finds the student by name or classroom, or types the code; either way the assign goes
// through this one form, so the flow after it (idempotency key, notice, refusals) is the same.
export const AddMemberForm = ({
  round,
  clubId,
  clubCode,
  pending,
  error,
  onSubmit,
}: AddMemberFormProps) => {
  const [loginId, setLoginId] = useState('');
  const [validationError, setValidationError] = useState<string>();
  const submitRef = useRef<HTMLButtonElement>(null);

  // Fills the code and leaves the sending to the admin: they see whom they picked before a seat
  // moves, and the next key press (Enter or Space) adds them.
  const pick = (picked: string) => {
    setLoginId(picked);
    setValidationError(undefined);
    submitRef.current?.focus();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = loginIdSchema.safeParse(loginId);
    if (!parsed.success) {
      setValidationError('กรุณากรอกรหัสนักเรียนให้ถูกต้อง (a-z 0-9 . _ - ไม่เกิน 64 ตัว)');
      return;
    }
    setValidationError(undefined);
    onSubmit(parsed.data);
  };

  return (
    <div className="space-y-4">
      <StudentFinder round={round} clubId={clubId} disabled={pending} onPick={pick} />
      <form
        aria-label={`เพิ่มนักเรียนเข้าชุมนุม ${clubCode}`}
        className="space-y-2"
        onSubmit={handleSubmit}
        noValidate
      >
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-full max-w-60 space-y-1.5">
            <Label htmlFor="add-member-login-id">รหัสนักเรียน</Label>
            <Input
              id="add-member-login-id"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-describedby="add-member-help"
              value={loginId}
              onChange={(event) => setLoginId(event.target.value)}
              required
            />
          </div>
          <Button ref={submitRef} type="submit" disabled={pending}>
            {pending ? 'กำลังบันทึก…' : 'เพิ่มเข้าชุมนุม'}
          </Button>
        </div>
        <p id="add-member-help" className="max-w-prose text-sm text-muted-foreground">
          เพิ่มได้เฉพาะนักเรียนชั้นเดียวกับรอบ ถ้านักเรียนถือชุมนุมอื่นในรอบนี้อยู่ ระบบจะย้ายมาชุมนุมนี้
          (ได้ที่ใหม่ก่อนจึงออกจากที่เดิม) และถ้ารอชุมนุมนี้อยู่ ชื่อจะออกจากรายชื่อรอ ชุมนุมที่เต็มต้องเพิ่มจำนวนรับก่อนด้วยปุ่ม
          "แก้ไข"
        </p>
        <FormError message={validationError ?? error} />
      </form>
    </div>
  );
};
