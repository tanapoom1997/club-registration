import { ROLES } from '@club-registration/shared';
import { Navigate } from 'react-router';
import type { RouteObject } from 'react-router';
import { RequireSession } from '@/components/RequireSession';
import { RootRedirect } from '@/components/RootRedirect';
import { AppLayout } from '@/pages/AppLayout';
import { ChangePasswordPage } from '@/pages/ChangePasswordPage';
import { HealthPage } from '@/pages/HealthPage';
import { HomePage } from '@/pages/HomePage';
import { LoginPage } from '@/pages/LoginPage';
import { PlaceholderPage } from '@/pages/PlaceholderPage';
import { MENUS } from '@/navigation';

const roleRoutes: RouteObject[] = ROLES.map((role) => ({
  path: `/${role}`,
  element: <RequireSession role={role} />,
  children: [
    {
      element: <AppLayout role={role} />,
      children: [
        { index: true, element: <HomePage role={role} /> },
        ...MENUS[role].map((item) => ({
          path: item.path,
          element: <PlaceholderPage item={item} />,
        })),
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
