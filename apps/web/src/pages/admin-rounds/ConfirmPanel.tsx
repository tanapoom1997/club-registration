import { Button } from '@/components/ui/button';

type ConfirmPanelProps = {
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

// Inline rather than window.confirm so the question stays readable, styled and testable.
export const ConfirmPanel = ({
  message,
  confirmLabel,
  cancelLabel = 'ยกเลิก',
  pending,
  onConfirm,
  onCancel,
}: ConfirmPanelProps) => (
  <div
    role="alertdialog"
    aria-label={message}
    className="space-y-3 rounded-md border border-border bg-warning p-4 text-warning-foreground"
  >
    <p className="text-sm font-medium">{message}</p>
    <div className="flex flex-wrap gap-2">
      <Button onClick={onConfirm} disabled={pending}>
        {pending ? 'กำลังบันทึก…' : confirmLabel}
      </Button>
      <Button variant="outline" onClick={onCancel} disabled={pending}>
        {cancelLabel}
      </Button>
    </div>
  </div>
);
