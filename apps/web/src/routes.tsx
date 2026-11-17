import { ROLES } from '@club-registration/shared';
import type { Role } from '@club-registration/shared';
import { lazy } from 'react';
import type { ComponentType, ReactElement } from 'react';
import { Navigate } from 'react-router';
import type { RouteObject } from 'react-router';
import { PageLoadError, PageOutlet } from '@/components/PageOutlet';
import { RequireSession } from '@/components/RequireSession';
import { RootRedirect } from '@/components/RootRedirect';
import { AppLayout } from '@/pages/AppLayout';
import { ChangePasswordPage } from '@/pages/ChangePasswordPage';
import { HealthPage } from '@/pages/HealthPage';
import { HomePage } from '@/pages/HomePage';
import { LoginPage } from '@/pages/LoginPage';
import { PlaceholderPage } from '@/pages/PlaceholderPage';
import { MENUS } from '@/navigation';

// Each menu page is its own chunk, fetched only when it renders. React.lazy rather than the
// router's route `lazy`: the router loads a route's module before rendering anything, so the
// role check in RequireSession (a component) would run only after the download, and a student
// who opens an admin URL would fetch the admin page before being sent home. With React.lazy the
// import starts when the page renders, i.e. after RequireSession let it through. React.lazy wants
// a default export; the pages keep their named export and this maps it.
const lazyPage = (load: () => Promise<ComponentType>): ReactElement => {
  const Page = lazy(async () => ({ default: await load() }));
  return <Page />;
};

// Menu entries whose feature has shipped; an entry added before its page renders a placeholder.
const PAGES: Readonly<Record<Role, Readonly<Record<string, ReactElement>>>> = Object.freeze({
  student: {
    clubs: lazyPage(
      async () => (await import('@/pages/student/StudentClubsPage')).StudentClubsPage,
    ),
    'my-registration': lazyPage(
      async () => (await import('@/pages/student/MyRegistrationPage')).MyRegistrationPage,
    ),
  },
  admin: {
    rounds: lazyPage(
      async () => (await import('@/pages/admin-rounds/AdminRoundsPage')).AdminRoundsPage,
    ),
    import: lazyPage(
      async () => (await import('@/pages/admin-import/AdminImportPage')).AdminImportPage,
    ),
    clubs: lazyPage(
      async () => (await import('@/pages/admin-clubs/AdminClubsPage')).AdminClubsPage,
    ),
    export: lazyPage(
      async () => (await import('@/pages/admin-export/AdminExportPage')).AdminExportPage,
    ),
    'initial-passwords': lazyPage(
      async () =>
        (await import('@/pages/admin-initial-passwords/AdminInitialPasswordsPage'))
          .AdminInitialPasswordsPage,
    ),
  },
});

const roleRoutes: RouteObject[] = ROLES.map((role) => ({
  path: `/${role}`,
  element: <RequireSession role={role} />,
  children: [
    {
      element: <AppLayout role={role} />,
      children: [
        {
          // Inside the layout, so the header and menu stay usable while a page loads or fails.
          element: <PageOutlet />,
          errorElement: <PageLoadError />,
          children: [
            { index: true, element: <HomePage role={role} /> },
            ...MENUS[role].map((item) => ({
              path: item.path,
              element: PAGES[role][item.path] ?? <PlaceholderPage item={item} />,
            })),
          ],
        },
      ],
    },
  ],
}));

// Exported as plain data so tests can mount the real route tree in a memory router.
export const routes: RouteObject[] = [
  { path: '/', element: <RootRedirect /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/status', element: <HealthPage /> },
  {
    element: <RequireSession allowPendingPasswordChange />,
    children: [{ path: '/change-password', element: <ChangePasswordPage /> }],
  },
  ...roleRoutes,
  { path: '*', element: <Navigate to="/" replace /> },
];
