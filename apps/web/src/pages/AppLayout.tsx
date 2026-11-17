import type { Role } from '@club-registration/shared';
import { Link, NavLink, Outlet } from 'react-router';
import { BrandMark } from '@/components/BrandMark';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { homePathFor, useLogout, useSession } from '@/lib/session';
import { MENUS, ROLE_LABELS } from '@/navigation';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'rounded-full px-3.5 py-1.5 text-sm transition-colors',
    isActive
      ? 'bg-primary-soft font-medium text-primary'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
  );

export const AppLayout = ({ role }: { role: Role }) => {
  const { data: user } = useSession();
  const logoutMutation = useLogout();

  return (
    <div className="min-h-dvh">
      <header className="z-10 border-b border-border bg-card/80 backdrop-blur-md sm:sticky sm:top-0">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 p-4">
          <Link to={homePathFor(role)} className="flex items-center gap-2.5 font-bold">
            <BrandMark />
            ระบบลงทะเบียนชุมนุม
          </Link>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-muted-foreground">
              <span className="font-medium text-foreground">{user?.fullName}</span> ·{' '}
              {ROLE_LABELS[role]}
            </span>
            <Link
              to="/change-password"
              className="whitespace-nowrap text-primary underline-offset-4 hover:underline"
            >
              เปลี่ยนรหัสผ่าน
            </Link>
            <Button
              variant="outline"
              className="whitespace-nowrap"
              onClick={() => logoutMutation.mutate()}
              disabled={logoutMutation.isPending}
            >
              ออกจากระบบ
            </Button>
          </div>
        </div>
        <nav aria-label="เมนูหลัก" className="mx-auto flex max-w-4xl flex-wrap gap-1 px-4 pb-3">
          <NavLink to={homePathFor(role)} end className={navLinkClass}>
            หน้าแรก
          </NavLink>
          {MENUS[role].map((item) => (
            <NavLink key={item.path} to={item.path} className={navLinkClass}>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-6 sm:py-8">
        <FormError
          message={logoutMutation.isError ? 'ออกจากระบบไม่สำเร็จ กรุณาลองใหม่' : undefined}
        />
        <Outlet />
      </main>
    </div>
  );
};
