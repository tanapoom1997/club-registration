import { DEFAULT_MAX_ACTIVE, updateRoundRequestSchema } from '@club-registration/shared';
import type { Round, UpdateRoundRequest } from '@club-registration/shared';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { updateRound } from '@/lib/api';
import { useRevealPanel, useReturnFocus } from '@/lib/panel-focus';
import { isoToThaiInput } from '@/lib/thai-time';
import { ConfirmPanel } from '@/components/ConfirmPanel';
import { RoundWindowFields } from './RoundWindowFields';
import { gradeLabel } from '@/lib/round-display';
import { queueEditNotes, roundErrorMessage, useRoundMutation, windowFromValues } from './round-ui';
import type { WindowValues } from './round-ui';

const valuesOf = (round: Round): WindowValues => ({
  opensAt: isoToThaiInput(round.opensAt),
  closesAt: isoToThaiInput(round.closesAt),
  // A round without a queue offers the default, should the admin turn the queue on.
  maxActive: String(round.maxActive ?? DEFAULT_MAX_ACTIVE),
  noQueue: round.maxActive === null,
});

type EditRoundFormProps = {
  round: Round;
  // Changes on every click of the round's edit button (useRevealPanel).
  reveal: number;
  onDone: () => void;
};

// Term and grade are shown but not editable: they identify the round and the API refuses them.
export const EditRoundForm = ({ round, reveal, onDone }: EditRoundFormProps) => {
  const [values, setValues] = useState<WindowValues>(() => valuesOf(round));
  const [validationError, setValidationError] = useState<string>();
  // Holds the parsed change while the admin is asked to confirm editing an open round.
  const [pendingChange, setPendingChange] = useState<UpdateRoundRequest>();
  const mutation = useRoundMutation(
    async (request: UpdateRoundRequest) => await updateRound(round.id, request),
  );
  const headingRef = useRevealPanel<HTMLHeadingElement>(reveal);
  // The confirmation replaces the save button, so focus goes back to the one that renders again.
  // Open until the request settles: the button is disabled while it is in flight.
  const submitRef = useRef<HTMLButtonElement>(null);
  useReturnFocus(pendingChange !== undefined || mutation.isPending, [submitRef]);

  const save = (request: UpdateRoundRequest) => {
    mutation.mutate(request, {
      onSuccess: onDone,
      onSettled: () => setPendingChange(undefined),
    });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = updateRoundRequestSchema.safeParse(windowFromValues(values));
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? 'ข้อมูลไม่ถูกต้อง');
      return;
    }
    setValidationError(undefined);
    // Students may be mid-registration in an open round, so changing it takes a second click.
    if (round.status === 'open') {
      setPendingChange(parsed.data);
      return;
    }
    save(parsed.data);
  };

  const title = `แก้ไขรอบ ${round.term} ${gradeLabel(round.grade)}`;
  // From the live round (the list polls while it is open), so the admitted count is current.
  const notes = queueEditNotes(round, values);
  const errorMessage =
    validationError ?? (mutation.isError ? roundErrorMessage(mutation.error) : undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle
          ref={headingRef}
          id="edit-round-title"
          tabIndex={-1}
          className="scroll-mt-6 text-base focus:outline-none sm:scroll-mt-36"
        >
          {title}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          แก้ได้เฉพาะเวลาเปิด–ปิดและจำนวนคนเข้าพร้อมกัน ภาคเรียนและชั้นเปลี่ยนไม่ได้
        </p>
      </CardHeader>
      <CardContent>
        <form
          aria-labelledby="edit-round-title"
          className="space-y-4"
          onSubmit={handleSubmit}
          noValidate
        >
          <RoundWindowFields idPrefix="edit" values={values} onChange={setValues} />
          {/* Mounted always, so a note that appears while the admin types is read out. */}
          <div aria-live="polite" className="space-y-2">
            {notes.map((note) => (
              <p key={note} className="text-sm font-medium text-warning-foreground">
                {note}
              </p>
            ))}
          </div>
          <FormError message={errorMessage} />
          {pendingChange ? (
            <ConfirmPanel
              message="รอบนี้เปิดให้ลงทะเบียนอยู่ การแก้ไขจะมีผลกับนักเรียนทันที ยืนยันบันทึกหรือไม่"
              confirmLabel="ยืนยันบันทึก"
              cancelLabel="ยังไม่บันทึก"
              pending={mutation.isPending}
              onConfirm={() => save(pendingChange)}
              onCancel={() => setPendingChange(undefined)}
            />
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button ref={submitRef} type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? 'กำลังบันทึก…' : 'บันทึกการแก้ไข'}
              </Button>
              <Button variant="outline" onClick={onDone} disabled={mutation.isPending}>
                ปิด
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
};
