import { alertVariants } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

type FormErrorProps = {
  message: string | undefined;
  // A boxed alert, for a form that is the whole page (login, change password), where a bare red
  // line is easy to miss between the fields and the button.
  boxed?: boolean;
};

export const FormError = ({ message, boxed = false }: FormErrorProps) =>
  message ? (
    <p
      className={cn(
        'text-sm text-destructive',
        boxed && [alertVariants({ variant: 'danger' }), 'font-medium'],
      )}
      role="alert"
    >
      {message}
    </p>
  ) : null;
