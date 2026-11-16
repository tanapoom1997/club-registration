import { z } from 'zod';

export const ROLES = Object.freeze(['student', 'admin'] as const);
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const PASSWORD_MIN_LENGTH = 8;
// Bounds the work an attacker can force into each Argon2 call.
export const PASSWORD_MAX_LENGTH = 128;

// Lower-cased so "Admin" and "admin" can never become two accounts.
export const loginIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{1,64}$/, 'รหัสผู้ใช้ใช้ได้เฉพาะ a-z 0-9 . _ - ไม่เกิน 64 ตัว');

export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `รหัสผ่านต้องยาวอย่างน้อย ${PASSWORD_MIN_LENGTH} ตัว`)
  .max(PASSWORD_MAX_LENGTH, `รหัสผ่านต้องยาวไม่เกิน ${PASSWORD_MAX_LENGTH} ตัว`);

export const loginRequestSchema = z.object({
  loginId: loginIdSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const changePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    newPassword: newPasswordSchema,
  })
  .refine(({ currentPassword, newPassword }) => currentPassword !== newPassword, {
    message: 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม',
    path: ['newPassword'],
  });
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const sessionUserSchema = z.object({
  id: z.number().int().positive(),
  loginId: z.string(),
  fullName: z.string(),
  role: roleSchema,
  mustChangePassword: z.boolean(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const sessionResponseSchema = z.object({ user: sessionUserSchema });
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
