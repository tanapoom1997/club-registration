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
      {/* The whole row is the label, 44 px tall, so the box is easy to hit on a phone. */}
      <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-border p-3 transition-colors hover:bg-muted has-checked:border-primary/40 has-checked:bg-primary-soft">
        <input
          type="checkbox"
          className="mt-0.5 size-5 shrink-0 accent-primary"
          checked={values.noQueue}
          // Named by its label line only: the help under it is the description, not the name.
          aria-labelledby={`${idPrefix}-no-queue-label`}
          aria-describedby={`${idPrefix}-no-queue-help`}
          onChange={(event) => onChange({ ...values, noQueue: event.target.checked })}
        />
        <span className="space-y-0.5">
          <span id={`${idPrefix}-no-queue-label`} className="block text-sm font-medium">
            {QUEUE_SETTING_MESSAGES.noQueueLabel}
          </span>
          <span id={`${idPrefix}-no-queue-help`} className="block text-sm text-muted-foreground">
            {QUEUE_SETTING_MESSAGES.noQueueHelp}
          </span>
        </span>
      </label>
    </div>
  );
};
