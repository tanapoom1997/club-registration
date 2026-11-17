import {
  DEFAULT_MAX_ACTIVE,
  GRADES,
  createRoundBatchRequestSchema,
  createRoundRequestSchema,
} from '@club-registration/shared';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { createRound, createRoundBatch } from '@/lib/api';
import { RoundWindowFields } from './RoundWindowFields';
import { gradeLabel } from '@/lib/round-display';
import { roundErrorMessage, useRoundMutation, windowFromValues } from './round-ui';
import type { WindowValues } from './round-ui';

const EMPTY_WINDOW: WindowValues = Object.freeze({
  opensAt: '',
  closesAt: '',
  maxActive: String(DEFAULT_MAX_ACTIVE),
});

const TermField = ({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) => (
  <div className="space-y-1.5">
    <Label htmlFor={id}>ภาคเรียน</Label>
    <Input
      id={id}
      placeholder="เช่น 2569/1"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      required
    />
  </div>
);

const SuccessMessage = ({ message }: { message: string | undefined }) =>
  message ? (
    <p className="text-sm text-success-foreground" role="status">
      {message}
    </p>
  ) : null;

export const CreateRoundForm = () => {
  const [term, setTerm] = useState('');
  const [grade, setGrade] = useState('1');
  const [timeWindow, setTimeWindow] = useState<WindowValues>(EMPTY_WINDOW);
  const [validationError, setValidationError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const mutation = useRoundMutation(createRound);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSuccess(undefined);
    const parsed = createRoundRequestSchema.safeParse({
      term,
      grade: Number(grade),
      ...windowFromValues(timeWindow),
    });
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? 'ข้อมูลไม่ถูกต้อง');
      return;
    }
    setValidationError(undefined);
    mutation.mutate(parsed.data, {
      onSuccess: (round) => {
        setSuccess(`สร้างรอบ ${round.term} ${gradeLabel(round.grade)} แล้ว`);
      },
    });
  };

  const errorMessage =
    validationError ?? (mutation.isError ? roundErrorMessage(mutation.error) : undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle id="create-round-title" className="text-base">
          สร้างรอบ
        </CardTitle>
        <p className="text-sm text-muted-foreground">สร้างรอบของชั้นเดียว</p>
      </CardHeader>
      <CardContent>
        <form
          aria-labelledby="create-round-title"
          className="space-y-4"
          onSubmit={handleSubmit}
          noValidate
        >
          <TermField id="create-term" value={term} onChange={setTerm} />
          <div className="space-y-1.5">
            <Label htmlFor="create-grade">ชั้น</Label>
            <Select
              id="create-grade"
              value={grade}
              onChange={(event) => setGrade(event.target.value)}
            >
              {GRADES.map((value) => (
                <option key={value} value={value}>
                  {gradeLabel(value)}
                </option>
              ))}
            </Select>
          </div>
          <RoundWindowFields idPrefix="create" values={timeWindow} onChange={setTimeWindow} />
          <FormError message={errorMessage} />
          <SuccessMessage message={success} />
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'กำลังสร้าง…' : 'สร้างรอบ'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};

export const CreateRoundBatchForm = () => {
  const [term, setTerm] = useState('');
  const [timeWindow, setTimeWindow] = useState<WindowValues>(EMPTY_WINDOW);
  const [validationError, setValidationError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const mutation = useRoundMutation(createRoundBatch);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSuccess(undefined);
    const parsed = createRoundBatchRequestSchema.safeParse({
      term,
      ...windowFromValues(timeWindow),
    });
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? 'ข้อมูลไม่ถูกต้อง');
      return;
    }
    setValidationError(undefined);
    mutation.mutate(parsed.data, {
      onSuccess: (rounds) => {
        setSuccess(`สร้างรอบ ${rounds.length} ชั้นของภาคเรียน ${parsed.data.term} แล้ว`);
      },
    });
  };

  const errorMessage =
    validationError ?? (mutation.isError ? roundErrorMessage(mutation.error) : undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle id="batch-round-title" className="text-base">
          สร้างครบทุกชั้น
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          สร้างรอบ ม.1–ม.6 ของภาคเรียนเดียวด้วยเวลาเดียวกัน (แก้เวลารายชั้นได้ภายหลัง)
          ถ้ามีชั้นใดอยู่แล้วจะไม่สร้างเลยสักชั้น
        </p>
      </CardHeader>
      <CardContent>
        <form
          aria-labelledby="batch-round-title"
          className="space-y-4"
          onSubmit={handleSubmit}
          noValidate
        >
          <TermField id="batch-term" value={term} onChange={setTerm} />
          <RoundWindowFields idPrefix="batch" values={timeWindow} onChange={setTimeWindow} />
          <FormError message={errorMessage} />
          <SuccessMessage message={success} />
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'กำลังสร้าง…' : 'สร้าง ม.1–ม.6'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};
