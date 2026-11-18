import { z } from 'zod';

// ─── Admin page (owner, 18 Nov 2026) ─────────────────────────────────────────
// Only for the emails in ADMIN_EMAILS; anyone else gets 404 from every /api/admin route.
// Account facts and counts only: never a mail's text, subject or sender.

/** Why an account's Gmail does not sync: the last sync failed, or the access was removed in Google. */
export const AdminGmailStateSchema = z.enum([
  'CONNECTED',
  'SYNC_FAILING',
  'ACCESS_REMOVED',
  'NOT_CONNECTED',
]);
export type AdminGmailState = z.infer<typeof AdminGmailStateSchema>;

/** A problem with the user's own AI key that only the user can fix. */
export const AdminKeyProblemSchema = z.enum([
  'KEY_REJECTED',
  'ACCOUNT_OR_BILLING',
  'MODEL_UNAVAILABLE',
  'KEY_UNREADABLE',
]);
export type AdminKeyProblem = z.infer<typeof AdminKeyProblemSchema>;

export const AdminSuspensionSchema = z.object({
  suspendedAt: z.iso.datetime(),
  reason: z.string(),
  /** The user's "Ask to resume" text, null until they send one. */
  request: z.object({ text: z.string(), sentAt: z.iso.datetime() }).nullable(),
});
export type AdminSuspension = z.infer<typeof AdminSuspensionSchema>;

export const AdminAccountSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string().nullable(),
  /** In TEST_ACCOUNTS: not counted toward the beta limit. */
  testAccount: z.boolean(),
  /** The admin's own account: it cannot be suspended. */
  self: z.boolean(),
  createdAt: z.iso.datetime(),
  /** Null when the account has not been used since this was first recorded (18 Nov 2026). */
  lastActiveAt: z.iso.datetime().nullable(),
  gmail: z.object({
    state: AdminGmailStateSchema,
    lastSyncedAt: z.iso.datetime().nullable(),
  }),
  ai: z.object({
    /** Catalog provider ID of the active setup; null when AI is not set up. */
    provider: z.string().nullable(),
    keyProblem: AdminKeyProblemSchema.nullable(),
  }),
  /** Reached today: AI calls (UTC day), replies sent from the app (last 24 hours). */
  limitsReached: z.object({ ai: z.boolean(), replies: z.boolean() }),
  /** The account's AI calls per UTC day at most (free AI or own key); 0 means AI is paused. */
  aiDailyLimit: z.number().int().nonnegative(),
  /** Mails the AI could not read in the last 24 hours. */
  aiFailedLast24h: z.number().int().nonnegative(),
  /** Inbox mails the sync took in, last 30 days (by the day each mail arrived). */
  mailsChecked30d: z.number().int().nonnegative(),
  applications: z.number().int().nonnegative(),
  suspension: AdminSuspensionSchema.nullable(),
});
export type AdminAccount = z.infer<typeof AdminAccountSchema>;

export const AdminFreeAIPauseReasonSchema = z.enum([
  'RATE_LIMITED',
  'PROVIDER_BUSY',
  'PROVIDER_UNAVAILABLE',
  'KEY_REJECTED',
  'ACCOUNT_OR_BILLING',
  'MODEL_UNAVAILABLE',
  'KEY_UNREADABLE',
]);

// GET /api/admin
export const AdminOverviewSchema = z.object({
  generatedAt: z.iso.datetime(),
  /** BETA_USER_LIMIT: real accounts at most; 0 means no limit. */
  betaUserLimit: z.number().int().nonnegative(),
  /** Every account, newest first. */
  accounts: z.array(AdminAccountSchema),
  /** Free AI models paused for every user on it. */
  freeAIPauses: z.array(
    z.object({
      model: z.string(),
      reason: AdminFreeAIPauseReasonSchema,
      resumesAt: z.iso.datetime(),
    }),
  ),
  /** AI calls of all accounts per UTC day, oldest first, the last 14 days with today last. */
  aiCallsByDay: z.array(z.object({ day: z.iso.date(), calls: z.number().int().nonnegative() })),
});
export type AdminOverview = z.infer<typeof AdminOverviewSchema>;

// GET /api/admin/free-ai-money: asked from OpenRouter when the page opens; never stored.
export const AdminFreeAIMoneySchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('OK'),
    /** US dollars spent on the free AI key: this UTC day and this UTC month. */
    todayUsd: z.number().nonnegative(),
    monthUsd: z.number().nonnegative(),
    /** Null when the key has no credit limit in OpenRouter. */
    limitUsd: z.number().nonnegative().nullable(),
    leftUsd: z.number().nullable(),
  }),
  /** FREE_AI_OPENROUTER_KEY is not set. */
  z.object({ state: z.literal('NO_KEY') }),
  /** OpenRouter did not answer in time or refused the key. */
  z.object({ state: z.literal('UNAVAILABLE') }),
]);
export type AdminFreeAIMoney = z.infer<typeof AdminFreeAIMoneySchema>;

export const SUSPEND_REASON_MAX_LENGTH = 500;

// POST /api/admin/accounts/:id/suspend
export const AdminSuspendRequestSchema = z.strictObject({
  reason: z.string().trim().min(1).max(SUSPEND_REASON_MAX_LENGTH),
});
export type AdminSuspendRequest = z.infer<typeof AdminSuspendRequestSchema>;

// POST /api/admin/accounts/:id/suspend and /resume answer with the changed account.
export const AdminAccountResponseSchema = z.object({ account: AdminAccountSchema });
export type AdminAccountResponse = z.infer<typeof AdminAccountResponseSchema>;
