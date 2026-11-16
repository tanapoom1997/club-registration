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
