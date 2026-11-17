import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-sm font-medium ring-1 ring-inset',
  {
    variants: {
      variant: {
        success: 'bg-success text-success-foreground ring-success-foreground/20',
        warning: 'bg-warning text-warning-foreground ring-warning-foreground/20',
        neutral: 'bg-muted text-muted-foreground ring-border',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>;

export const Badge = ({ className, variant, ...props }: BadgeProps) => (
  <span className={cn(badgeVariants({ variant }), className)} {...props} />
);
