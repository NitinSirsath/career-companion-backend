import { z } from 'zod';

// ─── Sign-in and the signed-in user ──────────────────────────────────────────
// Shared with the frontend. A password is only ever sent to the API, never returned by it.

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

const Email = z.string().trim().toLowerCase().pipe(z.email().max(320));
const NewPassword = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

/**
 * The guided first run (owner, 22 Nov 2026), in order. The app shows only the steps this device
 * can do (no Install where the browser cannot install, for example).
 */
export const ONBOARDING_STEPS = [
  'welcome',
  'gmail',
  'install',
  'alerts',
  'theme',
  'tour',
  'ai',
  'done',
] as const;
export const OnboardingStepSchema = z.enum(ONBOARDING_STEPS);
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

/** What a signed-in user may see about their own account. */
export const UserProfileSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string().nullable(),
  /** True when the user can sign in with email and password. */
  hasPassword: z.boolean(),
  /** True when the user can sign in with Google. */
  hasGoogle: z.boolean(),
  /** True for a test account: it signs in on the test sign-in page and uses the mail sandbox. */
  testAccount: z.boolean(),
  /** True when the account's email is in `ADMIN_EMAILS`: the app shows the Admin page. */
  admin: z.boolean(),
  /** Set while the owner has suspended the account: the app shows only the suspended page. */
  suspension: z
    .object({
      suspendedAt: z.iso.datetime(),
      reason: z.string(),
      /** The user's "Ask to resume" text, null until they send one. */
      request: z.object({ text: z.string(), sentAt: z.iso.datetime() }).nullable(),
    })
    .nullable(),
  /**
   * While the first run is not finished: the step to open, where the user stopped. Null once it is
   * finished or skipped, and for every account made before it existed.
   */
  onboarding: z.object({ step: OnboardingStepSchema }).nullable(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

export const RESUME_REQUEST_MAX_LENGTH = 1000;

// POST /api/auth/resume-request (suspended accounts only): sends or replaces the request.
export const ResumeRequestSchema = z.strictObject({
  text: z.string().trim().min(1).max(RESUME_REQUEST_MAX_LENGTH),
});
export type ResumeRequest = z.infer<typeof ResumeRequestSchema>;

// POST /api/auth/onboarding: the step the user reached (ignored once the first run is finished).
export const OnboardingStepRequestSchema = z.strictObject({ step: OnboardingStepSchema });
export type OnboardingStepRequest = z.infer<typeof OnboardingStepRequestSchema>;

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
