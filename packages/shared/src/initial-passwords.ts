import { z } from 'zod';
import { loginIdSchema } from './auth.js';
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

// An admin resetting one student's password, e.g. one who changed it and then forgot it. The
// student is named by login ID (the student code), like an admin's seat write. Strict, so a body
// naming a database id or anything else is refused with 400 instead of being ignored.
export const passwordResetRequestSchema = z.strictObject({
  loginId: loginIdSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;

// The new password exists only in this answer (sent with Cache-Control: no-store): the server
// keeps nothing but its hash, so it cannot be shown again.
export const passwordResetResponseSchema = z.object({
  student: z.object({
    loginId: z.string(),
    fullName: z.string(),
    grade: z.number().int(),
    classroom: z.string(),
    seatNo: z.number().int(),
  }),
  password: z.string().min(1),
});
export type PasswordResetResponse = z.infer<typeof passwordResetResponseSchema>;
