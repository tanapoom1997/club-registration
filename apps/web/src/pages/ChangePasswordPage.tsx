import {
  ERROR_CODES,
  PASSWORD_MIN_LENGTH,
  changePasswordRequestSchema,
} from '@club-registration/shared';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, changePassword } from '@/lib/api';
import { homePathFor, useLogout, useSession, useSetSession } from '@/lib/session';

const changePasswordErrorMessage = (error: unknown): string => {
  if (error instanceof ApiError && error.code === ERROR_CODES.invalidCurrentPassword) {
    return 'รหัสผ่านเดิมไม่ถูกต้อง';
  }
  if (error instanceof ApiError && error.code === ERROR_CODES.rateLimited) {
    return 'ลองหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่';
  }
  return 'เปลี่ยนรหัสผ่านไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';
};

type PasswordFieldProps = {
  id: string;
  label: string;
  value: string;
  autoComplete: 'current-password' | 'new-password';
  onChange: (value: string) => void;
};

const PasswordField = ({ id, label, value, autoComplete, onChange }: PasswordFieldProps) => (
  <div className="space-y-1.5">
    <Label htmlFor={id}>{label}</Label>
    <Input
      id={id}
      type="password"
      autoComplete={autoComplete}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      required
    />
  </div>
);

export const ChangePasswordPage = () => {
  const navigate = useNavigate();
  const setSession = useSetSession();
  const { data: user } = useSession();
  const logoutMutation = useLogout();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [validationError, setValidationError] = useState<string>();

  const mutation = useMutation({
    mutationFn: changePassword,
    onSuccess: async (updatedUser) => {
      setSession(updatedUser);
      await navigate(homePathFor(updatedUser.role), { replace: true });
    },
    onError: (error) => {
      // An expired or revoked session cannot change anything; RequireSession then sends to login.
      if (error instanceof ApiError && error.status === 401) setSession(null);
    },
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setValidationError('รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน');
      return;
    }
    const parsed = changePasswordRequestSchema.safeParse({ currentPassword, newPassword });
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? 'ข้อมูลไม่ถูกต้อง');
      return;
    }
    setValidationError(undefined);
    mutation.mutate(parsed.data);
  };

  const errorMessage =
    validationError ?? (mutation.isError ? changePasswordErrorMessage(mutation.error) : undefined);
  const isForced = user?.mustChangePassword ?? false;

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center p-4">
      <Card>
        <CardHeader>
          <CardTitle>เปลี่ยนรหัสผ่าน</CardTitle>
          <p className="text-sm text-muted-foreground">
            {isForced ? 'เข้าสู่ระบบครั้งแรก กรุณาตั้งรหัสผ่านใหม่ก่อนใช้งาน' : 'ตั้งรหัสผ่านใหม่สำหรับบัญชีของคุณ'}
          </p>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit} noValidate>
            <PasswordField
              id="current-password"
              label="รหัสผ่านเดิม"
              autoComplete="current-password"
              value={currentPassword}
              onChange={setCurrentPassword}
            />
            <PasswordField
              id="new-password"
              label={`รหัสผ่านใหม่ (อย่างน้อย ${PASSWORD_MIN_LENGTH} ตัว)`}
              autoComplete="new-password"
              value={newPassword}
              onChange={setNewPassword}
            />
            <PasswordField
              id="confirm-password"
              label="ยืนยันรหัสผ่านใหม่"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={setConfirmPassword}
            />
            <FormError message={errorMessage} />
            <Button type="submit" className="w-full" disabled={mutation.isPending}>
              {mutation.isPending ? 'กำลังบันทึก…' : 'บันทึกรหัสผ่านใหม่'}
            </Button>
            {isForced ? (
              // A forced change can be abandoned; leaving the session open on a lab computer cannot.
              <Button
                variant="ghost"
                className="w-full"
                onClick={() => logoutMutation.mutate()}
                disabled={logoutMutation.isPending}
              >
                ออกจากระบบ
              </Button>
            ) : (
              user && (
                <Link
                  to={homePathFor(user.role)}
                  className="block text-center text-sm text-muted-foreground underline"
                >
                  กลับหน้าแรก
                </Link>
              )
            )}
          </form>
        </CardContent>
      </Card>
    </main>
  );
};
