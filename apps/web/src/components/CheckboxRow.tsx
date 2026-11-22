type CheckboxRowProps = {
  id: string;
  label: string;
  description?: string | undefined;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
};

// A checkbox as a whole row: 44 px or more tall and clickable anywhere, so it is easy to hit on a
// phone, and tinted while ticked. Named by its label line alone; the line under it is its
// description, not part of the name.
export const CheckboxRow = ({
  id,
  label,
  description,
  checked,
  disabled = false,
  onChange,
}: CheckboxRowProps) => {
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-border p-3 transition-colors hover:bg-muted has-checked:border-primary/40 has-checked:bg-primary-soft has-disabled:cursor-not-allowed has-disabled:opacity-60">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-5 shrink-0 accent-primary"
        checked={checked}
        disabled={disabled}
        aria-labelledby={labelId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="space-y-0.5">
        <span id={labelId} className="block text-sm font-medium">
          {label}
        </span>
        {description !== undefined && (
          <span id={descriptionId} className="block text-sm text-muted-foreground">
            {description}
          </span>
        )}
      </span>
    </label>
  );
};
