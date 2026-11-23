import type { Role } from '@club-registration/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { BrandMark } from '@/components/BrandMark';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { ScrollFades } from '@/components/ui/scroll-fades';
import { useDocumentTitle } from '@/lib/page-title';
import { cn } from '@/lib/utils';
import { useScrollEdges } from '@/lib/scroll-edges';
import { hasMenuPage, homePathFor, useLogout, useSession } from '@/lib/session';
import { MENUS, ROLE_LABELS } from '@/navigation';

// 44 px tall on a phone (U9), the pill it was from sm up.
const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'inline-flex min-h-11 shrink-0 items-center rounded-full px-3.5 py-1.5 text-sm whitespace-nowrap transition-colors sm:min-h-0',
    isActive
      ? 'bg-primary-soft font-medium text-primary'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
  );

// On a phone the header is two rows (U4): the mark, the user's name and an "account" button that
// shows change password and logout, then the menu in one row that scrolls sideways when it does
// not fit (the admin's). From sm up it is the header it always was: the system's name, then the
// name, change password and logout side by side, and the menu below. One set of elements for
// both, only restyled, so every control has one accessible name whatever the width.
export const AppLayout = ({ role }: { role: Role }) => {
  // Admin pages carry wide tables; student pages read better in a narrower column.
  const width = role === 'admin' ? 'max-w-6xl' : 'max-w-4xl';
  const { data: user } = useSession();
  const logoutMutation = useLogout();
  const [accountOpen, setAccountOpen] = useState(false);
  const accountId = useId();
  const navRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  const navEdges = useScrollEdges(navRef);
  // The menu labels name the pages; the index route is the admin's menu page.
  const home = `/${role}`;
  const pageName =
    pathname === home || pathname === `${home}/`
      ? 'หน้าแรก'
      : MENUS[role].find(({ path }) => pathname === `${home}/${path}`)?.label;
  useDocumentTitle(pageName);
  // The admin's menu is wider than a phone: bring the current page's item into the row's view.
  // Only the row scrolls (never the page), and nothing moves when the item already shows.
  useEffect(() => {
    const nav = navRef.current;
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !current) return;
    const left = current.offsetLeft;
    const right = left + current.offsetWidth;
    if (left < nav.scrollLeft || right > nav.scrollLeft + nav.clientWidth) {
      nav.scrollLeft = right - nav.clientWidth;
    }
  }, [pathname]);

  return (
    <div className="min-h-dvh">
      <header className="z-10 border-b border-border bg-card/80 backdrop-blur-md sm:sticky sm:top-0">
        <div
          className={cn(
            // items-start: the mark stays on the first row when the account panel opens under it.
            'mx-auto flex flex-wrap items-start gap-x-3 gap-y-1 px-4 pt-1.5 sm:items-center sm:justify-between sm:gap-3 sm:p-4',
            width,
          )}
        >
          <Link
            to={homePathFor(role)}
            className="flex min-h-11 min-w-11 shrink-0 items-center gap-2.5 font-bold sm:min-h-0 sm:min-w-0"
          >
            <BrandMark />
            {/* The page's own h1 says where the student is; the mark alone saves a row. */}
            <span className="sr-only sm:not-sr-only">ระบบลงทะเบียนชุมนุม</span>
          </Link>
          <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2 text-sm sm:flex-none sm:gap-3">
            {/* basis-0 on a phone: it shares the row with the account button and truncates.
                Name over role, so neither needs a separator; the hidden comma is for screen
                readers, which would otherwise run the two together. */}
            <span className="flex min-w-0 flex-1 basis-0 flex-col items-end leading-tight sm:flex-none sm:basis-auto">
              <span className="w-full truncate text-right font-medium text-foreground">
                {user?.fullName}
              </span>
              <span className="sr-only">, </span>
              <span className="text-xs text-muted-foreground">{ROLE_LABELS[role]}</span>
            </span>
            <Button
              variant="outline"
              className="shrink-0 px-3 sm:hidden"
              aria-expanded={accountOpen}
              aria-controls={accountId}
              onClick={() => setAccountOpen((open) => !open)}
            >
              บัญชี
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={cn('size-4 transition-transform', accountOpen && 'rotate-180')}
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </Button>
            {/* Hidden on a phone until the account button opens it; always shown from sm up. */}
            <div
              id={accountId}
              className={cn(
                'basis-full flex-wrap items-center justify-end gap-2 pb-1 sm:flex sm:basis-auto sm:gap-3 sm:pb-0',
                accountOpen ? 'flex' : 'hidden',
              )}
            >
              <Link
                to="/change-password"
                className="inline-flex min-h-11 items-center px-2 whitespace-nowrap text-primary underline-offset-4 hover:underline sm:min-h-0 sm:px-0"
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
        </div>
        {/* The fades show a phone user that the admin's menu row scrolls, and which way; the
            scrollbar is hidden because they say the same thing without the extra height. */}
        <div className={cn('relative mx-auto', width)}>
          <nav
            ref={navRef}
            aria-label="เมนูหลัก"
            className={cn(
              // py-1: the row scrolls, which clips; this keeps a focus ring whole.
              'flex gap-1 overflow-x-auto px-4 py-1 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible sm:pt-0 sm:pb-3',
            )}
          >
            {hasMenuPage(role) && (
              <NavLink to={homePathFor(role)} end className={navLinkClass}>
                หน้าแรก
              </NavLink>
            )}
            {MENUS[role].map((item) => (
              <NavLink key={item.path} to={item.path} className={navLinkClass}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <ScrollFades {...navEdges} />
        </div>
      </header>
      <main className={cn('mx-auto px-4 py-6 sm:py-8', width)}>
        <FormError message={logoutMutation.isError ? 'ออกจากระบบไม่สำเร็จ กรุณาลองใหม่' : undefined} />
        <Outlet />
      </main>
    </div>
  );
};
