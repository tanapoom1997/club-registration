import { MAX_ACTIVE_LIMIT } from '@club-registration/shared';
import { CheckboxRow } from '@/components/CheckboxRow';
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
    // A size container: the open and close times sit side by side only where the form itself is
    // wide (the editor), not in the two narrow create cards next to each other.
    <div className="@container space-y-4">
      <div className="grid gap-4 @lg:grid-cols-2">
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
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-max-active`}>{QUEUE_SETTING_MESSAGES.maxActiveLabel}</Label>
        <Input
          id={`${idPrefix}-max-active`}
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_ACTIVE_LIMIT}
          className="block max-w-40"
          value={values.maxActive}
          // Disabled, not cleared: unticking "no queue" brings the typed number back.
          disabled={values.noQueue}
          onChange={(event) => update('maxActive')(event.target.value)}
          required={!values.noQueue}
        />
      </div>
      <CheckboxRow
        id={`${idPrefix}-no-queue`}
        label={QUEUE_SETTING_MESSAGES.noQueueLabel}
        description={QUEUE_SETTING_MESSAGES.noQueueHelp}
        checked={values.noQueue}
        onChange={(noQueue) => onChange({ ...values, noQueue })}
      />
    </div>
  );
};
