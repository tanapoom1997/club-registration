import { MAX_ACTIVE_LIMIT } from '@club-registration/shared';
import { CheckboxRow } from '@/components/CheckboxRow';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { QUEUE_SETTING_MESSAGES, windowTimeHint } from './round-ui';
import type { WindowValues } from './round-ui';

type TimeFieldProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
};

// A date field with the chosen time repeated under it in Thai form (Buddhist year), so a year
// typed 543 off shows at once instead of after the round is saved.
const TimeField = ({ id, label, value, onChange }: TimeFieldProps) => {
  const hint = windowTimeHint(value);
  const hintId = `${id}-hint`;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="datetime-local"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={hintId}
        aria-invalid={hint.outOfRange || undefined}
        required
      />
      <p
        id={hintId}
        className={cn(
          'text-sm',
          hint.outOfRange ? 'font-medium text-destructive' : 'text-muted-foreground',
        )}
      >
        {hint.text}
      </p>
    </div>
  );
};

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
        <TimeField
          id={`${idPrefix}-opens-at`}
          label="เวลาเปิด (เวลาไทย)"
          value={values.opensAt}
          onChange={update('opensAt')}
        />
        <TimeField
          id={`${idPrefix}-closes-at`}
          label="เวลาปิด (เวลาไทย)"
          value={values.closesAt}
          onChange={update('closesAt')}
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
