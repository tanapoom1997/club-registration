import type { ReactNode } from 'react';
import { BrandMark } from '@/components/BrandMark';

type AuthShellProps = {
  title: string;
  description: ReactNode;
  children: ReactNode;
};

// The frame of the pages outside the app's menu: login and change password. On a phone there is
// no card, because a bordered box costs a 360 px screen 40 px of field width, and the form starts
// near the top rather than in the middle, so the submit button stays above the on-screen keyboard
// and an error line pushes only what is below it. From sm up it is a centred card.
export const AuthShell = ({ title, description, children }: AuthShellProps) => (
  <main className="relative isolate flex min-h-dvh flex-col px-5 pt-12 pb-8 sm:justify-center sm:p-6">
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-80 bg-[radial-gradient(90%_100%_at_50%_0%,color-mix(in_oklch,var(--primary)_16%,transparent),transparent)] sm:h-96 sm:bg-[radial-gradient(60%_100%_at_50%_0%,color-mix(in_oklch,var(--primary)_14%,transparent),transparent)]"
    />
    <div className="mx-auto w-full max-w-sm sm:rounded-2xl sm:border sm:border-border sm:bg-card sm:p-8 sm:shadow-card-hover">
      <header className="mb-6 space-y-3 text-center">
        <BrandMark className="mx-auto size-12 rounded-2xl" />
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">{title}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </header>
      {children}
    </div>
  </main>
);

// For the inputs of these forms: 44 px tall like the buttons beside and below them, and when the
// browser scrolls a focused field into view it keeps room under it for the submit button.
export const AUTH_FIELD_CLASS = 'h-11 scroll-mb-28';
