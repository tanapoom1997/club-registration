import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchHealth } from '@/lib/api';

const POLL_INTERVAL_MS = 5_000;

type RowProps = {
  label: string;
  healthy: boolean | undefined;
  healthyText: string;
  unhealthyText: string;
};

const StatusRow = ({ label, healthy, healthyText, unhealthyText }: RowProps) => {
  const variant = healthy === undefined ? 'neutral' : healthy ? 'success' : 'warning';
  const text = healthy === undefined ? 'กำลังตรวจสอบ' : healthy ? healthyText : unhealthyText;
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <dt>{label}</dt>
      <dd>
        <Badge variant={variant}>{text}</Badge>
      </dd>
    </div>
  );
};

export const HealthPage = () => {
  const { data, isError, isPending, dataUpdatedAt } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    refetchInterval: POLL_INTERVAL_MS,
    retry: false,
  });

  const apiHealthy = isPending ? undefined : !isError;
  const databaseHealthy = isError ? false : data ? data.database === 'up' : undefined;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center p-4">
      <Card>
        <CardHeader>
          <CardTitle>สถานะระบบ</CardTitle>
          <p className="text-sm text-muted-foreground">ระบบลงทะเบียนชุมนุม</p>
        </CardHeader>
        <CardContent>
          <dl className="divide-y divide-border">
            <StatusRow
              label="API"
              healthy={apiHealthy}
              healthyText="ทำงานปกติ"
              unhealthyText="เชื่อมต่อไม่ได้"
            />
            <StatusRow
              label="ฐานข้อมูล"
              healthy={databaseHealthy}
              healthyText="ทำงานปกติ"
              unhealthyText={isError ? 'ไม่ทราบสถานะ' : 'เชื่อมต่อไม่ได้'}
            />
          </dl>
          <p className="pt-3 text-sm text-muted-foreground" aria-live="polite">
            {dataUpdatedAt > 0
              ? `ตรวจล่าสุด ${new Date(dataUpdatedAt).toLocaleTimeString('th-TH')}`
              : 'ยังไม่มีผลการตรวจ'}
          </p>
        </CardContent>
      </Card>
    </main>
  );
};
