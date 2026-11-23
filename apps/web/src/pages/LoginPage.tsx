import { ERROR_CODES, loginRequestSchema } from '@club-registration/shared';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { AUTH_FIELD_CLASS, AuthShell } from '@/components/AuthShell';
import { FormError } from '@/components/FormError';
import { PasswordInput } from '@/components/PasswordInput';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { advanceOnEnter } from '@/lib/advance-on-enter';
import { ApiError, login } from '@/lib/api';
import { returnPathFor, useSession, useSetSession } from '@/lib/session';

const loginErrorMessage = (error: unknown): string => {
  if (error instanceof ApiError && error.code === ERROR_CODES.invalidCredentials) {
    return 'รหัสผู้ใช้หรือรหัสผ่านไม่ถูกต้อง';
  }
  if (error instanceof ApiError && error.code === ERROR_CODES.rateLimited) {
    return 'ลองเข้าสู่ระบบหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่';
  }
  return 'เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';
};

export const LoginPage = () => {
  const navigate = useNavigate();
  // Router state is untyped; returnPathFor checks its shape before using it.
  const state: unknown = useLocation().state;
  const setSession = useSetSession();
  const { data: currentUser } = useSession();
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [validationError, setValidationError] = useState<string>();

  const mutation = useMutation({
    mutationFn: login,
    onSuccess: async (user) => {
      setSession(user);
      await navigate(returnPathFor(user, state), { replace: true });
    },
  });

  if (currentUser) return <Navigate to={returnPathFor(currentUser, state)} replace />;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = loginRequestSchema.safeParse({ loginId, password });
    if (!parsed.success) {
      setValidationError('กรุณากรอกรหัสผู้ใช้และรหัสผ่านให้ถูกต้อง');
      return;
    }
    setValidationError(undefined);
    mutation.mutate(parsed.data);
  };

  const errorMessage =
    validationError ?? (mutation.isError ? loginErrorMessage(mutation.error) : undefined);

  return (
    <AuthShell title="เข้าสู่ระบบ" description="ระบบลงทะเบียนชุมนุม">
      <form className="space-y-4" onSubmit={handleSubmit} noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="login-id">รหัสนักเรียน / รหัสผู้ใช้</Label>
          <Input
            id="login-id"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            className={AUTH_FIELD_CLASS}
            onKeyDown={advanceOnEnter}
            value={loginId}
            onChange={(event) => setLoginId(event.target.value)}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">รหัสผ่าน</Label>
          <PasswordInput
            id="password"
            field="รหัสผ่าน"
            name="password"
            autoComplete="current-password"
            enterKeyHint="go"
            className={AUTH_FIELD_CLASS}
            onKeyDown={advanceOnEnter}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>
        <FormError message={errorMessage} boxed />
        <Button type="submit" className="h-11 w-full" disabled={mutation.isPending}>
          {mutation.isPending ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
        </Button>
      </form>
    </AuthShell>
  );
};
