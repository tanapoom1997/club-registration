import { z } from 'zod';
import { idempotencyKeySchema } from './idempotency.js';
import { STUDENT_COLUMNS, classroomSchema } from './import.js';
import { gradeSchema } from './rounds.js';

// The issue endpoint answers with the file itself, so the count travels in a header.
export const ISSUED_COUNT_HEADER = 'x-issued-count';

// Column order of the downloaded file: the import's student columns, then the password.
export const INITIAL_PASSWORD_COLUMNS = Object.freeze({
  ...STUDENT_COLUMNS,
  password: 'รหัสผ่าน',
} as const);

// One grade at most per request: hashing is slow, and a smaller file is easier to hand out.
// Strict so a misspelt field (e.g. "classRoom") fails instead of silently widening the scope.
export const issueInitialPasswordsRequestSchema = z.strictObject({
  grade: gradeSchema,
  // Omitted = every classroom of the grade.
  classroom: classroomSchema.optional(),
  // true = skip students who already have an issued, still unchanged password.
  onlyUnissued: z.boolean(),
  idempotencyKey: idempotencyKeySchema,
});
export type IssueInitialPasswordsRequest = z.infer<typeof issueInitialPasswordsRequestSchema>;

const countSchema = z.number().int().nonnegative();

export const classroomPasswordStatusSchema = z.object({
  grade: z.number().int(),
  classroom: z.string(),
  // must_change_password and never issued: cannot log in yet.
  neverIssued: countSchema,
  // An initial password was issued and the student has not replaced it yet.
  issuedPending: countSchema,
  // The student set their own password; issuing never touches these.
  changed: countSchema,
  lastIssuedAt: z.iso.datetime().nullable(),
});
export type ClassroomPasswordStatus = z.infer<typeof classroomPasswordStatusSchema>;

export const passwordStatusResponseSchema = z.object({
  classrooms: z.array(classroomPasswordStatusSchema),
});
export type PasswordStatusResponse = z.infer<typeof passwordStatusResponseSchema>;
