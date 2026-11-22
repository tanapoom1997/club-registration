import { Button } from '@/components/ui/button';
import { alertVariants } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

type ConfirmPanelProps = {
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  // The action removes something (a round): its confirm button is red.
  destructive?: boolean;
};

// Inline rather than window.confirm so the question stays readable, styled and testable.
export const ConfirmPanel = ({
  message,
  confirmLabel,
  cancelLabel = 'ยกเลิก',
  pending,
  onConfirm,
  onCancel,
  destructive = false,
}: ConfirmPanelProps) => (
  <div
    role="alertdialog"
    aria-label={message}
    className={cn(alertVariants({ variant: 'warning' }), 'space-y-3 p-4')}
  >
    <p className="text-sm font-medium">{message}</p>
    <div className="flex flex-wrap gap-2">
      <Button
        variant={destructive ? 'destructive' : 'primary'}
        onClick={onConfirm}
        disabled={pending}
      >
        {pending ? 'กำลังบันทึก…' : confirmLabel}
      </Button>
      <Button variant="outline" onClick={onCancel} disabled={pending}>
        {cancelLabel}
      </Button>
    </div>
  </div>
);
