import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Card = ({ className, ...props }: ComponentProps<'div'>) => (
  <div
    className={cn(
      'rounded-2xl border border-border bg-card text-card-foreground shadow-card',
      className,
    )}
    {...props}
  />
);

export const CardHeader = ({ className, ...props }: ComponentProps<'div'>) => (
  <div className={cn('space-y-1 p-6 pb-4', className)} {...props} />
);

export const CardTitle = ({ className, children, ...props }: ComponentProps<'h1'>) => (
  <h1 className={cn('text-xl font-bold', className)} {...props}>
    {children}
  </h1>
);

export const CardContent = ({ className, ...props }: ComponentProps<'div'>) => (
  <div className={cn('p-6 pt-0', className)} {...props} />
);
