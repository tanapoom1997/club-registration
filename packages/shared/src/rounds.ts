import { z } from 'zod';

export const GRADES = Object.freeze([1, 2, 3, 4, 5, 6] as const);
export const ROUND_STATUSES = Object.freeze(['upcoming', 'open', 'closed'] as const);
// Mirrors the column default in the initial migration; the README starts the queue at ~150.
export const DEFAULT_MAX_ACTIVE = 150;
export const MAX_ACTIVE_LIMIT = 10_000;
export const TERM_MAX_LENGTH = 32;
// Upper bound of a Postgres integer: a larger id would be a DB error instead of a 404.
const PG_INT_MAX = 2_147_483_647;

export const roundStatusSchema = z.enum(ROUND_STATUSES);
export type RoundStatus = z.infer<typeof roundStatusSchema>;

export const termSchema = z
  .string()
  .trim()
  .min(1, 'กรุณากรอกภาคเรียน')
  .max(TERM_MAX_LENGTH, `ภาคเรียนยาวได้ไม่เกิน ${TERM_MAX_LENGTH} ตัว`)
  .regex(/^[^\p{Cc}]+$/u, 'ภาคเรียนมีอักขระที่ใช้ไม่ได้');

export const gradeSchema = z
  .number({ error: 'กรุณาเลือกชั้น' })
  .int('กรุณาเลือกชั้น')
  .min(1, 'ชั้นต้องอยู่ระหว่าง ม.1–ม.6')
  .max(6, 'ชั้นต้องอยู่ระหว่าง ม.1–ม.6');

// The years a round may open or close in, by Thai time. The date field of a browser takes the
// Christian year while the rest of the site shows the Buddhist one, so an admin who types 2569
// out of habit means 2026: 543 years off, which these bounds catch before it becomes a round.
export const ROUND_YEAR_MIN = 2000;
export const ROUND_YEAR_MAX = 2099;
export const ROUND_YEAR_MESSAGE = `ปีต้องเป็น ค.ศ. ${ROUND_YEAR_MIN}–${ROUND_YEAR_MAX} (เช่น 2026 ไม่ใช่ พ.ศ. 2569)`;
const ROUND_TIME_MIN_MS = Date.parse(`${ROUND_YEAR_MIN}-01-01T00:00:00+07:00`);
const ROUND_TIME_END_MS = Date.parse(`${ROUND_YEAR_MAX + 1}-01-01T00:00:00+07:00`);

// A timezone is required so a time typed in Thailand can never be read as UTC or vice versa.
const instantSchema = z.iso.datetime({ offset: true, error: 'รูปแบบวันเวลาไม่ถูกต้อง' }).refine(
  (value) => {
    const ms = Date.parse(value);
    return ms >= ROUND_TIME_MIN_MS && ms < ROUND_TIME_END_MS;
  },
  // abort: a year 543 off also makes "closes after opens" fail or pass by accident; only the
  // year message is true, so the window check is skipped.
  { error: ROUND_YEAR_MESSAGE, abort: true },
);

export const maxActiveSchema = z
  .number({ error: 'จำนวนคนเข้าพร้อมกันต้องเป็นตัวเลข' })
  .int('จำนวนคนเข้าพร้อมกันต้องเป็นจำนวนเต็ม')
  .min(1, 'จำนวนคนเข้าพร้อมกันต้องมากกว่า 0')
  .max(MAX_ACTIVE_LIMIT, `จำนวนคนเข้าพร้อมกันต้องไม่เกิน ${MAX_ACTIVE_LIMIT}`);

// null = the round has no queue (README Phase 3 decision 6): its students choose clubs without a
// turn. Always sent on a create, so a round never loses its queue by a field left out.
const roundMaxActiveSchema = maxActiveSchema.nullable();

const CLOSES_AFTER_OPENS = { message: 'เวลาปิดต้องอยู่หลังเวลาเปิด', path: ['closesAt'] };

type Window = { opensAt?: string | undefined; closesAt?: string | undefined };

const closesAfterOpens = ({ opensAt, closesAt }: Window): boolean =>
  opensAt === undefined || closesAt === undefined || Date.parse(closesAt) > Date.parse(opensAt);

// A row id taken from the URL path.
export const dbIdSchema = z.coerce.number().int().positive().max(PG_INT_MAX);

// A row id in a JSON body: JSON has numbers, so text such as "5" is refused, not coerced.
export const dbIdBodySchema = z.number().int().positive().max(PG_INT_MAX);

export const roundIdParamsSchema = z.object({ id: dbIdSchema });
export type RoundIdParams = z.infer<typeof roundIdParamsSchema>;

export const listRoundsQuerySchema = z.object({ term: termSchema.optional() });
export type ListRoundsQuery = z.infer<typeof listRoundsQuerySchema>;

// Strict: term and grade identify a round and must never arrive as silently ignored extras.
export const createRoundRequestSchema = z
  .strictObject({
    term: termSchema,
    grade: gradeSchema,
    opensAt: instantSchema,
    closesAt: instantSchema,
    maxActive: roundMaxActiveSchema,
  })
  .refine(closesAfterOpens, CLOSES_AFTER_OPENS);
export type CreateRoundRequest = z.infer<typeof createRoundRequestSchema>;

// Every grade gets the same window; staggering grades is done by editing rounds afterwards.
export const createRoundBatchRequestSchema = z
  .strictObject({
    term: termSchema,
    opensAt: instantSchema,
    closesAt: instantSchema,
    maxActive: roundMaxActiveSchema,
  })
  .refine(closesAfterOpens, CLOSES_AFTER_OPENS);
export type CreateRoundBatchRequest = z.infer<typeof createRoundBatchRequestSchema>;

// Strict so a request trying to move a round to another term or grade fails instead of
// half-succeeding. A window given only partly is checked against the stored half by the DB.
// maxActive left out keeps the stored value; null turns the queue off (and counts as a change).
export const updateRoundRequestSchema = z
  .strictObject({
    opensAt: instantSchema.optional(),
    closesAt: instantSchema.optional(),
    maxActive: roundMaxActiveSchema.optional(),
  })
  .refine(
    ({ opensAt, closesAt, maxActive }) =>
      opensAt !== undefined || closesAt !== undefined || maxActive !== undefined,
    { message: 'ไม่มีข้อมูลที่จะแก้ไข' },
  )
  .refine(closesAfterOpens, CLOSES_AFTER_OPENS);
export type UpdateRoundRequest = z.infer<typeof updateRoundRequestSchema>;

export const roundSchema = z.object({
  id: z.number().int().positive(),
  term: z.string(),
  grade: z.number().int(),
  // Always UTC on the wire; the web app converts to Thai time for display.
  opensAt: z.iso.datetime(),
  closesAt: z.iso.datetime(),
  // null = no queue.
  maxActive: z.number().int().nullable(),
  // Derived from server time when the response is built, never stored.
  status: roundStatusSchema,
  clubCount: z.number().int().nonnegative(),
  totalCapacity: z.number().int().nonnegative(),
  totalRegistered: z.number().int().nonnegative(),
  // The round's live queue tickets now (DB clock, the queue's own definition of live): waiting,
  // and let in to choose. Tickets left from before the queue was turned off still count until they
  // expire.
  queueWaiting: z.number().int().nonnegative(),
  queueAdmitted: z.number().int().nonnegative(),
});
export type Round = z.infer<typeof roundSchema>;

export const roundResponseSchema = z.object({ round: roundSchema });
export type RoundResponse = z.infer<typeof roundResponseSchema>;

export const roundListResponseSchema = z.object({ rounds: z.array(roundSchema) });
export type RoundListResponse = z.infer<typeof roundListResponseSchema>;
