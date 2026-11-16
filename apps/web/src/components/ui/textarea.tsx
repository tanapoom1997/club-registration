import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Textarea = ({ className, ...props }: ComponentProps<'textarea'>) => (
  <textarea
    className={cn(
      'min-h-24 w-full rounded-md border border-input bg-card px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
      className,
    )}
    {...props}
  />
);
