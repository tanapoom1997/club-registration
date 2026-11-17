import type { Role } from '@club-registration/shared';
import { Link } from 'react-router';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { useSession } from '@/lib/session';
import { MENUS } from '@/navigation';

export const HomePage = ({ role }: { role: Role }) => {
  const { data: user } = useSession();

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">สวัสดี {user?.fullName}</h1>
        <p className="text-muted-foreground">เลือกเมนูที่ต้องการ</p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {MENUS[role].map((item) => (
          <li key={item.path}>
            <Link
              to={item.path}
              className="group block h-full rounded-2xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              <Card className="relative h-full transition-all group-hover:-translate-y-0.5 group-hover:border-primary/40 group-hover:shadow-card-hover">
                <CardHeader className="pr-12">
                  <CardTitle className="text-base group-hover:text-primary">{item.label}</CardTitle>
                  <p className="text-sm text-muted-foreground">{item.description}</p>
                </CardHeader>
                <span
                  aria-hidden="true"
                  className="absolute top-6 right-5 text-muted-foreground transition-all group-hover:translate-x-0.5 group-hover:text-primary"
                >
                  →
                </span>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
};
