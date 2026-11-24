import { z } from 'zod';
import { CAPACITY_MAX, clubDescriptionSchema, clubNameSchema } from './import.js';
import { dbIdSchema, roundSchema } from './rounds.js';

const CAPACITY_MESSAGE = `จำนวนรับต้องเป็นจำนวนเต็ม 0–${CAPACITY_MAX}`;

export const capacitySchema = z
  .number({ error: CAPACITY_MESSAGE })
  .int(CAPACITY_MESSAGE)
  .min(0, CAPACITY_MESSAGE)
  .max(CAPACITY_MAX, CAPACITY_MESSAGE);

export const roundClubsParamsSchema = z.object({ roundId: dbIdSchema });
export type RoundClubsParams = z.infer<typeof roundClubsParamsSchema>;

export const clubIdParamsSchema = z.object({ id: dbIdSchema });
export type ClubIdParams = z.infer<typeof clubIdParamsSchema>;

// Strict so an attempt to change club_code, round_id or registered fails loudly instead of being
// dropped: the code keys the Excel upsert and registered belongs to registrations.
export const updateClubRequestSchema = z
  .strictObject({
    name: clubNameSchema.optional(),
    description: clubDescriptionSchema.optional(),
    capacity: capacitySchema.optional(),
  })
  .refine(
    ({ name, description, capacity }) =>
      name !== undefined || description !== undefined || capacity !== undefined,
    { message: 'ไม่มีข้อมูลที่จะแก้ไข' },
  );
export type UpdateClubRequest = z.infer<typeof updateClubRequestSchema>;

// Contact fields are personal data: only admin routes return them.
export const clubAdvisorSchema = z.object({
  id: z.number().int().positive(),
  fullName: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  lineId: z.string().nullable(),
});
export type ClubAdvisor = z.infer<typeof clubAdvisorSchema>;

export const adminClubSchema = z.object({
  id: z.number().int().positive(),
  roundId: z.number().int().positive(),
  clubCode: z.string(),
  name: z.string(),
  // Plain text written by an admin; the web app must render it as text, never as HTML.
  description: z.string(),
  capacity: z.number().int().nonnegative(),
  registered: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  // Students on the club's waitlist now; who they are is in GET /api/admin/clubs/:id/waitlist.
  waitlistCount: z.number().int().nonnegative(),
  advisors: z.array(clubAdvisorSchema),
});
export type AdminClub = z.infer<typeof adminClubSchema>;

// The round comes along so a poll also refreshes its status and totals.
export const roundClubsResponseSchema = z.object({
  round: roundSchema,
  clubs: z.array(adminClubSchema),
});
export type RoundClubsResponse = z.infer<typeof roundClubsResponseSchema>;

export const adminClubResponseSchema = z.object({ club: adminClubSchema });
export type AdminClubResponse = z.infer<typeof adminClubResponseSchema>;
