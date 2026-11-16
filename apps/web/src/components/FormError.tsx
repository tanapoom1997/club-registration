export const FormError = ({ message }: { message: string | undefined }) =>
  message ? (
    <p className="text-sm text-destructive" role="alert">
      {message}
    </p>
  ) : null;
