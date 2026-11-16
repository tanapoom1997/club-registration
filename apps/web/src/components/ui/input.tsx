import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Input = ({ className, ...props }: ComponentProps<'input'>) => (
  <input
    className={cn(
      'w-full rounded-md border border-input bg-card px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
      className,
    )}
    {...props}
  />
);
