import { cva } from 'class-variance-authority';

// Exported as classes rather than a component: callers keep their own element, role and ref
// (status, alert, alertdialog, focus targets).
export const alertVariants = cva('rounded-xl p-3 text-sm ring-1 ring-inset', {
  variants: {
    variant: {
      success: 'bg-success text-success-foreground ring-success-foreground/20',
      warning: 'bg-warning text-warning-foreground ring-warning-foreground/25',
      danger: 'bg-destructive/10 text-destructive ring-destructive/20',
    },
  },
});
