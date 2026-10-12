import { z } from 'zod';

// ─── Sign-in and the signed-in user ──────────────────────────────────────────
// Shared with the frontend. A password is only ever sent to the API, never returned by it.

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

const Email = z.string().trim().toLowerCase().pipe(z.email().max(320));
const NewPassword = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

/** What a signed-in user may see about their own account. */
export const UserProfileSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string().nullable(),
  /** True when the user can sign in with email and password. */
  hasPassword: z.boolean(),
  /** True when the user can sign in with Google. */
  hasGoogle: z.boolean(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

// POST /api/auth/login
export const PasswordLoginRequestSchema = z.strictObject({
  email: Email,
  /** Not length-checked here: a wrong password of any length gets the same answer. */
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type PasswordLoginRequest = z.infer<typeof PasswordLoginRequestSchema>;

// POST /api/auth/password
export const SetPasswordRequestSchema = z.strictObject({
  /** Needed only when the user already has a password. */
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH).optional(),
  newPassword: NewPassword,
});
export type SetPasswordRequest = z.infer<typeof SetPasswordRequestSchema>;

// POST /api/auth/register (dev mode only; 404 in prod, where Google sign-in creates the account)
export const RegisterRequestSchema = z.strictObject({
  email: Email,
  password: NewPassword,
  name: z.string().trim().min(1).max(200).optional(),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

/** `details` of the 429 TOO_MANY_ATTEMPTS answer. */
export const TooManyAttemptsDetailsSchema = z.object({
  retryAfterSeconds: z.number().int().positive(),
});
export type TooManyAttemptsDetails = z.infer<typeof TooManyAttemptsDetailsSchema>;
