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
        boxed &&
          'rounded-xl bg-destructive/10 p-3 font-medium ring-1 ring-destructive/20 ring-inset',
      )}
      role="alert"
    >
      {message}
    </p>
  ) : null;
