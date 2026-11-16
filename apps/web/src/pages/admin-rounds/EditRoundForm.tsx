import { updateRoundRequestSchema } from '@club-registration/shared';
import type { Round, UpdateRoundRequest } from '@club-registration/shared';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { updateRound } from '@/lib/api';
import { isoToThaiInput } from '@/lib/thai-time';
import { ConfirmPanel } from './ConfirmPanel';
import { RoundWindowFields } from './RoundWindowFields';
import { gradeLabel, roundErrorMessage, useRoundMutation, windowFromValues } from './round-ui';
import type { WindowValues } from './round-ui';

const valuesOf = (round: Round): WindowValues => ({
  opensAt: isoToThaiInput(round.opensAt),
  closesAt: isoToThaiInput(round.closesAt),
  maxActive: String(round.maxActive),
});

type EditRoundFormProps = { round: Round; onDone: () => void };

// Term and grade are shown but not editable: they identify the round and the API refuses them.
export const EditRoundForm = ({ round, onDone }: EditRoundFormProps) => {
  const [values, setValues] = useState<WindowValues>(() => valuesOf(round));
  const [validationError, setValidationError] = useState<string>();
  // Holds the parsed change while the admin is asked to confirm editing an open round.
  const [pendingChange, setPendingChange] = useState<UpdateRoundRequest>();
  const mutation = useRoundMutation(
    async (request: UpdateRoundRequest) => await updateRound(round.id, request),
  );

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
  const errorMessage =
    validationError ?? (mutation.isError ? roundErrorMessage(mutation.error) : undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle id="edit-round-title" className="text-base">
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
          <FormError message={errorMessage} />
          {pendingChange ? (
            <ConfirmPanel
              message="รอบนี้เปิดให้ลงทะเบียนอยู่ การเปลี่ยนเวลาจะมีผลกับนักเรียนทันที ยืนยันบันทึกหรือไม่"
              confirmLabel="ยืนยันบันทึก"
              cancelLabel="ยังไม่บันทึก"
              pending={mutation.isPending}
              onConfirm={() => save(pendingChange)}
              onCancel={() => setPendingChange(undefined)}
            />
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={mutation.isPending}>
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
