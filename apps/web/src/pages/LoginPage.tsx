import { ERROR_CODES, loginRequestSchema } from '@club-registration/shared';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { BrandMark } from '@/components/BrandMark';
import { FormError } from '@/components/FormError';
import { PasswordInput } from '@/components/PasswordInput';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, login } from '@/lib/api';
import { landingPathFor, useSession, useSetSession } from '@/lib/session';

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
  const setSession = useSetSession();
  const { data: currentUser } = useSession();
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [validationError, setValidationError] = useState<string>();

  const mutation = useMutation({
    mutationFn: login,
    onSuccess: async (user) => {
      setSession(user);
      await navigate(landingPathFor(user), { replace: true });
    },
  });

  if (currentUser) return <Navigate to={landingPathFor(currentUser)} replace />;

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
    <main className="relative isolate flex min-h-dvh flex-col justify-center overflow-hidden p-4">
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 -z-10 h-96 bg-[radial-gradient(60%_100%_at_50%_0%,color-mix(in_oklch,var(--primary)_14%,transparent),transparent)]"
      />
      <Card className="mx-auto w-full max-w-sm shadow-card-hover">
        <CardHeader className="items-center space-y-3 text-center">
          <BrandMark className="mx-auto size-12 rounded-2xl" />
          <div className="space-y-1">
            <CardTitle as="h1" className="text-2xl">
              เข้าสู่ระบบ
            </CardTitle>
            <p className="text-sm text-muted-foreground">ระบบลงทะเบียนชุมนุม</p>
          </div>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit} noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="login-id">รหัสนักเรียน / รหัสผู้ใช้</Label>
              <Input
                id="login-id"
                name="username"
                autoComplete="username"
                autoCapitalize="none"
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
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
            <FormError message={errorMessage} />
            <Button type="submit" className="h-11 w-full" disabled={mutation.isPending}>
              {mutation.isPending ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
};
