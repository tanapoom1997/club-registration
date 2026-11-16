import { MAX_ACTIVE_LIMIT } from '@club-registration/shared';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { WindowValues } from './round-ui';

type RoundWindowFieldsProps = {
  idPrefix: string;
  values: WindowValues;
  onChange: (values: WindowValues) => void;
};

export const RoundWindowFields = ({ idPrefix, values, onChange }: RoundWindowFieldsProps) => {
  const update = (field: keyof WindowValues) => (value: string) =>
    onChange({ ...values, [field]: value });

  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-opens-at`}>เวลาเปิด (เวลาไทย)</Label>
        <Input
          id={`${idPrefix}-opens-at`}
          type="datetime-local"
          value={values.opensAt}
          onChange={(event) => update('opensAt')(event.target.value)}
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-closes-at`}>เวลาปิด (เวลาไทย)</Label>
        <Input
          id={`${idPrefix}-closes-at`}
          type="datetime-local"
          value={values.closesAt}
          onChange={(event) => update('closesAt')(event.target.value)}
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-max-active`}>จำนวนคนเข้าเลือกพร้อมกันสูงสุด</Label>
        <Input
          id={`${idPrefix}-max-active`}
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_ACTIVE_LIMIT}
          value={values.maxActive}
          onChange={(event) => update('maxActive')(event.target.value)}
          required
        />
      </div>
    </>
  );
};
