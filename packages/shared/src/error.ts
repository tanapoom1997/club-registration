import { z } from 'zod';

// Shared so the web app can branch on a code without matching on message text.
export const ERROR_CODES = Object.freeze({
  badRequest: 'bad_request',
  validationError: 'validation_error',
  notFound: 'not_found',
  internalError: 'internal_error',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  invalidCredentials: 'invalid_credentials',
  invalidCurrentPassword: 'invalid_current_password',
  passwordChangeRequired: 'password_change_required',
  rateLimited: 'rate_limited',
  roundExists: 'round_exists',
  roundNotEmpty: 'round_not_empty',
  fileTooLarge: 'file_too_large',
  unsupportedFile: 'unsupported_file',
  invalidWorkbook: 'invalid_workbook',
  importFileMismatch: 'import_file_mismatch',
  importInvalid: 'import_invalid',
  importConflict: 'import_conflict',
  idempotencyKeyReused: 'idempotency_key_reused',
  nothingToIssue: 'nothing_to_issue',
  capacityBelowRegistered: 'capacity_below_registered',
  nothingToExport: 'nothing_to_export',
  studentProfileMissing: 'student_profile_missing',
  clubFull: 'club_full',
  alreadyRegistered: 'already_registered',
  roundNotOpen: 'round_not_open',
  notRegistered: 'not_registered',
  alreadyInClub: 'already_in_club',
  waitlistNotNeeded: 'waitlist_not_needed',
  // A waitlist join for a club with capacity 0, which takes no one (README waitlist rule 9).
  clubNotAccepting: 'club_not_accepting',
  notWaitlisted: 'not_waitlisted',
  studentNotInRoundGrade: 'student_not_in_round_grade',
  notInQueue: 'not_in_queue',
  // A seat-taking request (or the club list) in an open round without a live admitted ticket:
  // the web app goes back to the queue instead of treating it as a missing permission.
  queueRequired: 'queue_required',
  // Join or heartbeat in a round that has no queue (max_active NULL): the web app reads the round
  // again and shows the list without queueing.
  queueOff: 'queue_off',
} as const);

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const errorResponseSchema = z.object({
  // A plain string rather than an enum: an older web build must still parse codes added later.
  code: z.string(),
  message: z.string(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
