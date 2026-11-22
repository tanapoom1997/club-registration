import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { alertVariants } from '@/components/ui/alert';
import { useConfirmationFocus } from '@/lib/panel-focus';
import { cn } from '@/lib/utils';

type ConfirmPanelProps = {
  message: string;
  // The dialog's name, when the question itself is too long to be one.
  label?: string;
  // Further short paragraphs under the question: what else happens.
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  pending: boolean;
  pendingLabel?: string;
  // Said while the request is in flight, when it may take a while.
  pendingNote?: string;
  onConfirm: () => void;
  onCancel: () => void;
  // The action removes something (a round): its confirm button is red.
  destructive?: boolean;
  className?: string;
};

// An admin's confirmation of a write that is not a seat write (those use WritePanel): deleting a
// round, saving an open round, issuing passwords. Inline rather than window.confirm so the
// question stays readable, styled and testable. It takes focus and closes on Escape like
// WritePanel; giving focus back to what opened it is up to the page (useReturnFocus), which knows
// what that is.
export const ConfirmPanel = ({
  message,
  label = message,
  children,
  confirmLabel,
  cancelLabel = 'ยกเลิก',
  pending,
  pendingLabel = 'กำลังบันทึก…',
  pendingNote,
  onConfirm,
  onCancel,
  destructive = false,
  className,
}: ConfirmPanelProps) => {
  const { ref, onKeyDown } = useConfirmationFocus<HTMLDivElement>(onCancel, pending);
  return (
    // Escape closing an alertdialog is the WAI-ARIA dialog pattern. The rule's per-element options
    // match tag names (a native <dialog>), not role="alertdialog" on a div, so it is waived here.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={ref}
      tabIndex={-1}
      role="alertdialog"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        alertVariants({ variant: 'warning' }),
        'space-y-3 p-4 focus-visible:outline-none',
        className,
      )}
    >
      <p className="text-sm font-medium">{message}</p>
      {children}
      {pending && pendingNote !== undefined && (
        <p className="text-sm" role="status">
          {pendingNote}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant={destructive ? 'destructive' : 'primary'}
          onClick={onConfirm}
          disabled={pending}
        >
          {pending ? pendingLabel : confirmLabel}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={pending}>
          {cancelLabel}
        </Button>
      </div>
    </div>
  );
};
