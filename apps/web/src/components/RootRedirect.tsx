import { Navigate } from 'react-router';
import { landingPathFor, useSession } from '@/lib/session';

export const RootRedirect = () => {
  const { data: user, isPending } = useSession();
  if (isPending) return <p className="p-6 text-center text-muted-foreground">กำลังโหลด…</p>;
  return <Navigate to={user ? landingPathFor(user) : '/login'} replace />;
};
