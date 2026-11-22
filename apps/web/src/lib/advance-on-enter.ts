import type { KeyboardEvent } from 'react';

// An iPhone keyboard has no "next" key: its Enter submits the form from the first field, which
// then fails validation for the fields not filled yet. Enter moves on to the next empty field
// instead, and submits once nothing after the current field is empty (Android's "next" key moves
// focus by itself and never gets here).
export const advanceOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
  const field = event.currentTarget;
  if (event.key !== 'Enter' || event.nativeEvent.isComposing || !field.form) return;
  const inputs = [...field.form.querySelectorAll('input')].filter((input) => !input.disabled);
  const next = inputs.slice(inputs.indexOf(field) + 1).find((input) => input.value === '');
  if (!next) return;
  event.preventDefault();
  next.focus();
};
