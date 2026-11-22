import { useQuery } from '@tanstack/react-query';
import { AuthShell } from '@/components/AuthShell';
import { Badge } from '@/components/ui/badge';
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
    <div className="flex min-h-14 items-center justify-between gap-4 py-3">
      <dt className="font-medium">{label}</dt>
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

  // The same frame as the login page: on a phone the rows use the full width, from sm up a card.
  return (
    <AuthShell title="สถานะระบบ" description="ระบบลงทะเบียนชุมนุม">
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
      <p className="pt-3 text-center text-sm text-muted-foreground" aria-live="polite">
        {dataUpdatedAt > 0
          ? `ตรวจล่าสุด ${new Date(dataUpdatedAt).toLocaleTimeString('th-TH')}`
          : 'ยังไม่มีผลการตรวจ'}
      </p>
    </AuthShell>
  );
};
