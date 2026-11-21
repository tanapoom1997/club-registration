import { useEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
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

// A next step to offer once the request was refused, e.g. a full club's waitlist.
export type FollowUp = { label: string; onClick: () => void };

type WritePanelProps = {
  state: WriteState;
  label: string;
  question: string;
  // One or more short paragraphs: what happens, and what is given up.
  note: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  dismissLabel: string;
  followUp?: FollowUp | undefined;
};

// The confirmation of a seat write, on the student pages and in the admin's club lists. Inline
// next to what it acts on rather than a modal, so on a phone it opens where it was tapped. It
// takes focus when it opens so keyboard and screen reader users land on the question, and Escape
// closes it like the dismiss button (not while a request is in flight).
export const WritePanel = ({
  state: { pending, error, canRetry, onConfirm, onRetry, onDismiss },
  label,
  question,
  note,
  confirmLabel,
  pendingLabel,
  dismissLabel,
  followUp,
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
          <div className="space-y-1 text-sm">{note}</div>
        </>
      )}
      {pending && (
        <p className="text-sm" role="status">
          {pendingLabel}
        </p>
      )}
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        {refused ? (
          followUp && <Button onClick={followUp.onClick}>{followUp.label}</Button>
        ) : canRetry ? (
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
