import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center rounded-md px-2 py-0.5 text-sm font-medium', {
  variants: {
    variant: {
      success: 'bg-success text-success-foreground',
      warning: 'bg-warning text-warning-foreground',
      neutral: 'border border-border text-muted-foreground',
    },
  },
  defaultVariants: { variant: 'neutral' },
});

type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>;

export const Badge = ({ className, variant, ...props }: BadgeProps) => (
  <span className={cn(badgeVariants({ variant }), className)} {...props} />
);
