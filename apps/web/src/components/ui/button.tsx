import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

// min-h-11 below sm: a 44 px touch target on a phone (U9) for every button, the admin's row
// buttons included; from sm up each keeps the height its padding gives, as before.
export const buttonVariants = cva(
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium sm:min-h-0 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary:
          'bg-primary text-primary-foreground shadow-sm shadow-primary/25 hover:bg-primary/90 hover:shadow-md hover:shadow-primary/25',
        outline: 'border border-border bg-card shadow-xs hover:border-input hover:bg-muted',
        ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
        // A row button that starts giving something up (the confirmation is `destructive`): the
        // shape of `outline`, so it lines up with the row's other buttons, in red.
        danger:
          'border border-destructive/40 bg-card text-destructive shadow-xs hover:border-destructive hover:bg-destructive/10',
        // The confirmation of a write that gives something up (a seat, a waitlist place, a round).
        destructive:
          'bg-destructive text-destructive-foreground shadow-sm shadow-destructive/25 hover:bg-destructive/90 hover:shadow-md hover:shadow-destructive/25',
      },
    },
    defaultVariants: { variant: 'primary' },
  },
);

type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants>;

// data-variant names the style in the DOM, so a test can tell a red confirm from a primary one
// without matching class names.
export const Button = ({ className, variant, type = 'button', ...props }: ButtonProps) => (
  <button
    type={type}
    data-variant={variant ?? 'primary'}
    className={cn(buttonVariants({ variant }), className)}
    {...props}
  />
);
