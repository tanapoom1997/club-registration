import { MAX_ACTIVE_LIMIT } from '@club-registration/shared';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { QUEUE_SETTING_MESSAGES } from './round-ui';
import type { WindowValues } from './round-ui';

type RoundWindowFieldsProps = {
  idPrefix: string;
  values: WindowValues;
  onChange: (values: WindowValues) => void;
};

export const RoundWindowFields = ({ idPrefix, values, onChange }: RoundWindowFieldsProps) => {
  const update = (field: 'opensAt' | 'closesAt' | 'maxActive') => (value: string) =>
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
        <Label htmlFor={`${idPrefix}-max-active`}>{QUEUE_SETTING_MESSAGES.maxActiveLabel}</Label>
        <Input
          id={`${idPrefix}-max-active`}
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_ACTIVE_LIMIT}
          value={values.maxActive}
          // Disabled, not cleared: unticking "no queue" brings the typed number back.
          disabled={values.noQueue}
          onChange={(event) => update('maxActive')(event.target.value)}
          required={!values.noQueue}
        />
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={values.noQueue}
            aria-describedby={`${idPrefix}-no-queue-help`}
            onChange={(event) => onChange({ ...values, noQueue: event.target.checked })}
          />
          <span>{QUEUE_SETTING_MESSAGES.noQueueLabel}</span>
        </label>
        <p id={`${idPrefix}-no-queue-help`} className="text-sm text-muted-foreground">
          {QUEUE_SETTING_MESSAGES.noQueueHelp}
        </p>
      </div>
    </>
  );
};
