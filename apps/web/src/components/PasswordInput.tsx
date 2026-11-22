import { useState } from 'react';
import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { PASSWORD_MESSAGES } from './password-messages';

type PasswordInputProps = Omit<ComponentProps<'input'>, 'type' | 'id'> & {
  id: string;
  // What the field holds, for the toggle's accessible name ("แสดงรหัสผ่านเดิม").
  field: string;
};

// A password input with a show/hide toggle (U16): an initial password is 10 random characters,
// and on a phone a typo cannot be seen. Hidden by default, so it is never on screen unless the
// user asks. The toggle is a plain button (type="button", so it never submits the form), 44 px at
// every width, beside the input rather than over it so typed text never runs under it. Its name
// says what it will do; the input keeps its autocomplete, so password managers still fill it.
//
// Phone keyboards must not capitalise or autocorrect a shown password, and spellcheck must not
// read it: in Chrome that may send the text of a plain text field to a spelling service.
export const PasswordInput = ({ id, field, className, ...props }: PasswordInputProps) => {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex gap-2">
      <Input
        {...props}
        id={id}
        type={shown ? 'text' : 'password'}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className={cn('min-w-0 flex-1', className)}
      />
      <Button
        variant="outline"
        className="w-16 shrink-0 px-3 sm:min-h-11"
        aria-controls={id}
        aria-label={shown ? PASSWORD_MESSAGES.hideField(field) : PASSWORD_MESSAGES.showField(field)}
        onClick={() => setShown((current) => !current)}
      >
        {shown ? PASSWORD_MESSAGES.hide : PASSWORD_MESSAGES.show}
      </Button>
    </div>
  );
};
