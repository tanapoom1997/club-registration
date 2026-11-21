import type { FormEvent, RefObject } from 'react';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type StudentCodeFilterProps = {
  value: string;
  error: string | undefined;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClear: () => void;
};

// A form of its own so Enter applies the code, but it never submits to a URL: the input has no
// name and the submit is always prevented, so a student's code cannot reach the page's address
// (and with it the browser history) even if the handler fails.
export const StudentCodeFilter = ({
  value,
  error,
  inputRef,
  onChange,
  onSubmit,
  onClear,
}: StudentCodeFilterProps) => {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <form
      aria-label="กรองด้วยรหัสนักเรียน"
      className="space-y-1.5"
      onSubmit={handleSubmit}
      noValidate
    >
      <Label htmlFor="events-login-id">รหัสนักเรียน</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="events-login-id"
          ref={inputRef}
          className="max-w-60"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby="events-login-id-help"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <Button type="submit" variant="outline">
          กรอง
        </Button>
        <Button type="button" variant="ghost" onClick={onClear}>
          ล้างรหัส
        </Button>
      </div>
      <p id="events-login-id-help" className="text-sm text-muted-foreground">
        พิมพ์ตัวใหญ่หรือตัวเล็กก็ได้ หรือกดรหัสนักเรียนในตารางเพื่อดูเฉพาะคนนั้น
      </p>
      <FormError message={error} />
    </form>
  );
};
