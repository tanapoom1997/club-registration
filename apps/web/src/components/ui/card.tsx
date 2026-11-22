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

type CardTitleProps = ComponentProps<'h2'> & { as?: 'h1' | 'h2' | 'h3' };

// An h2 by default: a card sits under the page's own h1. A page that is just one card (login,
// change password) makes it the page's h1.
export const CardTitle = ({
  as: Heading = 'h2',
  className,
  children,
  ...props
}: CardTitleProps) => (
  <Heading className={cn('text-xl font-bold', className)} {...props}>
    {children}
  </Heading>
);

export const CardContent = ({ className, ...props }: ComponentProps<'div'>) => (
  <div className={cn('p-6 pt-0', className)} {...props} />
);
