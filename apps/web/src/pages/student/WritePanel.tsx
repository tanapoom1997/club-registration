import { useEffect, useRef } from 'react';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';

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
// tapped. It takes focus when it opens so keyboard and screen reader users land on the question.
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

  // A refused request is settled: the panel only explains why. A new attempt starts from the
  // button again, with a new idempotency key.
  const refused = error !== undefined && !canRetry;

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="alertdialog"
      aria-label={label}
      className="space-y-3 rounded-md border border-border bg-warning p-3 text-warning-foreground focus-visible:outline-none"
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
