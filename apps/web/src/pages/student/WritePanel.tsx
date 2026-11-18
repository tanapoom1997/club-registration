import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { alertVariants } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

export type WriteState = {
  pending: boolean;
  error: string | undefined;
  // The last request may have gone through; only a resend with the same key is safe.
  canRetry: boolean;
  onConfirm: () => void;
  onRetry: () => void;
  onDismiss: () => void;
};

type WritePanelProps = {
  state: WriteState;
  label: string;
  question: string;
  note: string;
  confirmLabel: string;
  pendingLabel: string;
  dismissLabel: string;
};

// Inline next to what it acts on rather than a modal, so on a phone it opens where the student
// tapped. It takes focus when it opens so keyboard and screen reader users land on the question,
// and Escape closes it like the dismiss button (not while a request is in flight).
export const WritePanel = ({
  state: { pending, error, canRetry, onConfirm, onRetry, onDismiss },
  label,
  question,
  note,
  confirmLabel,
  pendingLabel,
  dismissLabel,
}: WritePanelProps) => {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || pending) return;
    event.preventDefault();
    onDismiss();
  };

  // A refused request is settled: the panel only explains why. A new attempt starts from the
  // button again, with a new idempotency key.
  const refused = error !== undefined && !canRetry;

  return (
    // Escape closing an alertdialog is the WAI-ARIA dialog pattern. The rule's per-element options
    // match tag names (a native <dialog>), not role="alertdialog" on a div, so it is waived here.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={panelRef}
      tabIndex={-1}
      role="alertdialog"
      aria-label={label}
      onKeyDown={handleKeyDown}
      className={cn(alertVariants({ variant: 'warning' }), 'space-y-3 focus-visible:outline-none')}
    >
      {!refused && (
        <>
          <p className="font-medium">{question}</p>
          <p className="text-sm">{note}</p>
        </>
      )}
      {pending && (
        <p className="text-sm" role="status">
          {pendingLabel}
        </p>
      )}
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        {refused ? null : canRetry ? (
          <Button onClick={onRetry} disabled={pending}>
            ลองอีกครั้ง
          </Button>
        ) : (
          <Button onClick={onConfirm} disabled={pending}>
            {confirmLabel}
          </Button>
        )}
        <Button variant="outline" onClick={onDismiss} disabled={pending}>
          {error === undefined ? dismissLabel : 'ปิด'}
        </Button>
      </div>
    </div>
  );
};
