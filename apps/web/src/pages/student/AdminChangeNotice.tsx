import type { StudentAdminChange, StudentRound } from '@club-registration/shared';
import type { Ref } from 'react';
import { alertVariants } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import { adminChangeNotice, isAdminRemoval } from './student-ui';

// What an admin last did to the student's seat or waitlist place (README Phase 4, P3), like
// PromotedNotice: from data (adminChange), so it survives a reload and goes once the student acts
// themselves; always mounted, so a screen reader announces it politely when a poll brings it or
// it changes, and a poll that brings the same answer changes no text and says nothing again.
// Focusable only so that focus can land here when the change removed the focused element (the
// leave or cancel button, the link in the held club's card: useFocusRescue).
export const AdminChangeNotice = ({
  adminChange,
  round,
  ref,
}: {
  adminChange: StudentAdminChange | null | undefined;
  round: StudentRound;
  ref?: Ref<HTMLParagraphElement>;
}) => (
  <div role="status">
    {adminChange && (
      <p
        ref={ref}
        tabIndex={-1}
        className={cn(
          alertVariants({ variant: isAdminRemoval(adminChange) ? 'warning' : 'success' }),
          'focus:outline-none',
        )}
      >
        {adminChangeNotice(adminChange, round.status)}
      </p>
    )}
  </div>
);
