import type { Role, SessionUser } from '@club-registration/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { fetchSession, logout } from '@/lib/api';

export const SESSION_QUERY_KEY = Object.freeze(['session'] as const);

export const useSession = () =>
  useQuery({ queryKey: SESSION_QUERY_KEY, queryFn: fetchSession, staleTime: 60_000 });

export const useSetSession = () => {
  const queryClient = useQueryClient();
  return (user: SessionUser | null) => {
    queryClient.setQueryData(SESSION_QUERY_KEY, user);
  };
};

// A student's home is the club list, the one thing they come for (on registration day, their
// place in the queue): with two pages, a menu page of its own only cost them a tap, so /student
// sends them on to it (U3). The admin's home is the menu page with every page they can open.
export const homePathFor = (role: Role): string =>
  role === 'student' ? '/student/clubs' : `/${role}`;

// Whether /<role> is a page of its own rather than a redirect to the role's home.
export const hasMenuPage = (role: Role): boolean => homePathFor(role) === `/${role}`;

export const landingPathFor = (user: SessionUser): string =>
  user.mustChangePassword ? '/change-password' : homePathFor(user.role);

export const useLogout = () => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: logout,
    onSuccess: async () => {
      // Drop every cached response so the next person on a shared computer sees nothing.
      queryClient.removeQueries();
      queryClient.setQueryData(SESSION_QUERY_KEY, null);
      await navigate('/login', { replace: true });
    },
  });
};
