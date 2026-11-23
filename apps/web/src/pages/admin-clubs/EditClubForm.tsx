import { updateClubRequestSchema } from '@club-registration/shared';
import type { AdminClub, UpdateClubRequest } from '@club-registration/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, updateClub } from '@/lib/api';
import { useRevealPanel } from '@/lib/panel-focus';
import { useSetSession } from '@/lib/session';
import { ROUNDS_QUERY_KEY } from '@/pages/admin-rounds/round-ui';
import { CLUBS_QUERY_KEY, clubErrorMessage } from './club-ui';

type ClubValues = { name: string; description: string; capacity: string };

const valuesOf = ({ name, description, capacity }: AdminClub): ClubValues => ({
  name,
  description,
  capacity: String(capacity),
});

// Only what the admin actually touched is sent, so saving a new name cannot put back a capacity
// that another admin changed while this form was open.
const changesFrom = (initial: ClubValues, values: ClubValues) => ({
  ...(values.name === initial.name ? {} : { name: values.name }),
  ...(values.description === initial.description ? {} : { description: values.description }),
  ...(values.capacity === initial.capacity
    ? {}
    : { capacity: values.capacity.trim() === '' ? Number.NaN : Number(values.capacity) }),
});

type EditClubFormProps = {
  // The latest copy from the polled list, so the registered count shown here stays current.
  club: AdminClub;
  // Changes on every click of the club's edit button (useRevealPanel).
  reveal: number;
  onSaved: (club: AdminClub) => void;
  onClose: () => void;
};

export const EditClubForm = ({ club, reveal, onSaved, onClose }: EditClubFormProps) => {
  const headingRef = useRevealPanel<HTMLHeadingElement>(reveal);
  const [initial] = useState<ClubValues>(() => valuesOf(club));
  const [values, setValues] = useState<ClubValues>(initial);
  const [validationError, setValidationError] = useState<string>();
  const queryClient = useQueryClient();
  const setSession = useSetSession();

  const mutation = useMutation({
    mutationFn: async (request: UpdateClubRequest) => await updateClub(club.id, request),
    onSuccess: onSaved,
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) setSession(null);
    },
    // Refreshed either way: a refusal usually means registered moved since the list was loaded.
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: CLUBS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ROUNDS_QUERY_KEY }),
      ]);
    },
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = updateClubRequestSchema.safeParse(changesFrom(initial, values));
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? 'ข้อมูลไม่ถูกต้อง');
      return;
    }
    setValidationError(undefined);
    mutation.mutate(parsed.data);
  };

  const setField = (field: keyof ClubValues) => (value: string) =>
    setValues((current) => ({ ...current, [field]: value }));

  const title = `แก้ไขชุมนุม ${club.clubCode}`;
  const errorMessage =
    validationError ?? (mutation.isError ? clubErrorMessage(mutation.error) : undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle
          ref={headingRef}
          id="edit-club-title"
          tabIndex={-1}
          className="scroll-mt-6 text-base focus:outline-none sm:scroll-mt-36"
        >
          {title}
        </CardTitle>
        <p className="max-w-prose text-sm text-muted-foreground">
          รหัสชุมนุมเปลี่ยนไม่ได้ ลดจำนวนรับได้ไม่ต่ำกว่าจำนวนที่ลงแล้ว (ตอนนี้ลงแล้ว {club.registered} คน)
        </p>
      </CardHeader>
      <CardContent>
        <form
          aria-labelledby="edit-club-title"
          className="max-w-2xl space-y-4"
          onSubmit={handleSubmit}
          noValidate
        >
          <div className="space-y-1.5">
            <Label htmlFor="edit-club-name">ชื่อชุมนุม</Label>
            <Input
              id="edit-club-name"
              value={values.name}
              onChange={(event) => setField('name')(event.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-club-description">รายละเอียด</Label>
            <Textarea
              id="edit-club-description"
              value={values.description}
              onChange={(event) => setField('description')(event.target.value)}
            />
          </div>
          <div className="max-w-40 space-y-1.5">
            <Label htmlFor="edit-club-capacity">จำนวนรับ</Label>
            <Input
              id="edit-club-capacity"
              type="number"
              inputMode="numeric"
              min={club.registered}
              step={1}
              value={values.capacity}
              onChange={(event) => setField('capacity')(event.target.value)}
              required
            />
          </div>
          <FormError message={errorMessage} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'กำลังบันทึก…' : 'บันทึกการแก้ไข'}
            </Button>
            <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
              ปิด
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
};
