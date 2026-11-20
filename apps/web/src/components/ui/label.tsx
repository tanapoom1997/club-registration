import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Label = ({ className, ...props }: ComponentProps<'label'>) => (
  // htmlFor and the text arrive through props, which the rule cannot see here; every <Label>
  // usage is checked instead (labelComponents in eslint.config.js).
  // eslint-disable-next-line jsx-a11y/label-has-associated-control
  <label className={cn('text-sm font-medium', className)} {...props} />
);
