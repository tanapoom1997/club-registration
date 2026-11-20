import { z } from 'zod';
import { STUDENT_COLUMNS, classroomSchema } from './import.js';
import { dbIdSchema, roundSchema } from './rounds.js';

// Name lists an admin downloads for teachers (docs/excel.md "Export รายชื่อ"), as Excel or PDF. The
// format is always named, so a client written before a format was added keeps getting its own.
export const EXPORT_VIEWS = Object.freeze(['club', 'classroom'] as const);
export const EXPORT_FORMATS = Object.freeze(['xlsx', 'pdf'] as const);

export const exportViewSchema = z.enum(EXPORT_VIEWS);
export type ExportView = z.infer<typeof exportViewSchema>;

export const exportFormatSchema = z.enum(EXPORT_FORMATS);
export type ExportFormat = z.infer<typeof exportFormatSchema>;

// Shown in the club column of the per-classroom list for a student with no club in the round.
export const NOT_REGISTERED_LABEL = 'ยังไม่ลง';

// Column order of each list. The per-club list is for taking attendance, the per-classroom list
// for chasing students who have not registered yet.
export const CLUB_LIST_COLUMNS = Object.freeze({
  order: 'ลำดับ',
  loginId: STUDENT_COLUMNS.loginId,
  fullName: STUDENT_COLUMNS.fullName,
  classroom: 'ชั้น/ห้อง',
  seatNo: STUDENT_COLUMNS.seatNo,
} as const);

export const CLASSROOM_LIST_COLUMNS = Object.freeze({
  seatNo: STUDENT_COLUMNS.seatNo,
  loginId: STUDENT_COLUMNS.loginId,
  fullName: STUDENT_COLUMNS.fullName,
  club: 'ชุมนุม',
} as const);

export const roundExportParamsSchema = z.object({ roundId: dbIdSchema });
export type RoundExportParams = z.infer<typeof roundExportParamsSchema>;

// Strict per view, so a scope meant for the other view (e.g. clubId with view=classroom) or a
// misspelt field fails with 400 instead of silently widening the export to the whole round.
// Leaving clubId / classroom out exports the whole round.
export const exportQuerySchema = z.discriminatedUnion('view', [
  z.strictObject({
    view: z.literal(exportViewSchema.enum.club),
    clubId: dbIdSchema.optional(),
    format: exportFormatSchema,
  }),
  z.strictObject({
    view: z.literal(exportViewSchema.enum.classroom),
    classroom: classroomSchema.optional(),
    format: exportFormatSchema,
  }),
]);
export type ExportQuery = z.infer<typeof exportQuerySchema>;

const countSchema = z.number().int().nonnegative();

export const roundClassroomSchema = z.object({
  classroom: z.string(),
  studentCount: countSchema,
  registeredCount: countSchema,
});
export type RoundClassroom = z.infer<typeof roundClassroomSchema>;

// Classrooms of the round's grade, so the export page can offer them and show who is missing.
export const roundClassroomsResponseSchema = z.object({
  round: roundSchema,
  classrooms: z.array(roundClassroomSchema),
});
export type RoundClassroomsResponse = z.infer<typeof roundClassroomsResponseSchema>;
