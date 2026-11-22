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

export const homePathFor = (role: Role): string => `/${role}`;

// Where a login lands. A student lands on the club list, the one thing they come for (on
// registration day, their place in the queue); /student stays as the menu page.
export const landingPathFor = (user: SessionUser): string => {
  if (user.mustChangePassword) return '/change-password';
  return user.role === 'student' ? '/student/clubs' : homePathFor(user.role);
};

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
