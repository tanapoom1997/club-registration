import { z } from 'zod';

// Clients generate one per user action (the web app uses crypto.randomUUID()); the pattern keeps
// it safe to store and compare as-is.
export const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,128}$/, 'idempotencyKey must be 16–128 characters of A-Z a-z 0-9 _ -');
