import { Badge } from '@/components/ui/badge';
import type { MenuItem } from '@/navigation';

export const PlaceholderPage = ({ item }: { item: MenuItem }) => (
  <section className="space-y-2">
    <h1 className="text-xl font-semibold">{item.label}</h1>
    <p className="text-muted-foreground">{item.description}</p>
    <Badge>ยังไม่เปิดใช้งาน</Badge>
  </section>
);
