import type { Role } from '@club-registration/shared';
import { Navigate, Outlet } from 'react-router';
import { Button } from '@/components/ui/button';
import { homePathFor, useSession } from '@/lib/session';

type RequireSessionProps = {
  role?: Role;
  allowPendingPasswordChange?: boolean;
};

// UX only: it keeps users on pages they can use. The API enforces every rule on its own.
export const RequireSession = ({
  role,
  allowPendingPasswordChange = false,
}: RequireSessionProps) => {
  const { data: user, isPending, isError, refetch } = useSession();

  if (isPending) {
    return <p className="p-6 text-center text-muted-foreground">กำลังโหลด…</p>;
  }
  if (isError) {
    return (
      <div className="flex flex-col items-center gap-3 p-6" role="alert">
        <p>เชื่อมต่อระบบไม่ได้</p>
        <Button variant="outline" onClick={() => void refetch()}>
          ลองใหม่
        </Button>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (user.mustChangePassword && !allowPendingPasswordChange) {
    return <Navigate to="/change-password" replace />;
  }
  if (role && user.role !== role) return <Navigate to={homePathFor(user.role)} replace />;
  return <Outlet />;
};
