import type { Role } from '@club-registration/shared';
import { Link } from 'react-router';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { useSession } from '@/lib/session';
import { MENUS } from '@/navigation';

export const HomePage = ({ role }: { role: Role }) => {
  const { data: user } = useSession();

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">สวัสดี {user?.fullName}</h1>
      <ul className="grid gap-3 sm:grid-cols-2">
        {MENUS[role].map((item) => (
          <li key={item.path}>
            <Link to={item.path} className="block h-full">
              <Card className="h-full hover:bg-muted">
                <CardHeader>
                  <CardTitle className="text-base">{item.label}</CardTitle>
                  <p className="text-sm text-muted-foreground">{item.description}</p>
                </CardHeader>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
};
