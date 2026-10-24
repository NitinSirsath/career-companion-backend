import { z } from 'zod';
import { AIFailureSchema } from './ai';

const IsoDateTime = z.iso.datetime({ offset: true });

export const AmbiguousMatchResponseSchema = z.object({
  id: z.string(),
  subject: z.string().nullable(),
  sender: z.string().nullable(),
  threadId: z.string().nullable().optional(),
  gmailMessageId: z.string().optional(),
  receivedAt: z.string().nullable(), // ISO string or Date, we'll format as ISO
  aiProcessingResult: z
    .object({
      companyName: z.string().nullable(),
      jobTitle: z.string().nullable(),
      confidence: z.number().nullable(),
      category: z.string().nullable(),
      /** Which provider and model produced this result (ADR-0001). */
      provider: z.string(),
      model: z.string(),
    })
    .nullable(),
});

export type AmbiguousMatchResponse = z.infer<typeof AmbiguousMatchResponseSchema>;

export const ResolveAmbiguityRequestSchema = z.object({
  applicationId: z.string().nullable(), // null means "Ignore this email, no match"
});

export type ResolveAmbiguityRequest = z.infer<typeof ResolveAmbiguityRequestSchema>;

// ─── POST /api/emails/:id/retry ───────────────────────────────────────────────

/** Send `acceptPossibleDuplicateCharge: true` only after the user approved one more AI attempt. */
export const RetryEmailRequestSchema = z.strictObject({
  acceptPossibleDuplicateCharge: z.literal(true).optional(),
});
export type RetryEmailRequest = z.infer<typeof RetryEmailRequestSchema>;

/** Details of 409 AI_RETRY_NEEDS_APPROVAL: where the earlier attempt went and which provider a retry uses. */
export const AIRetryApprovalDetailsSchema = z.object({
  operations: z.array(
    z.object({
      operation: z.string(),
      reason: z.enum(['OUTCOME_UNKNOWN', 'INVALID_OUTPUT', 'ATTEMPTS_EXHAUSTED']),
      provider: z.string().nullable(),
      model: z.string().nullable(),
      /** When the latest try was sent. */
      attemptedAt: z.string().nullable(),
      /** When each counted try was sent, oldest first (empty for a step from before they were kept). */
      triedAt: z.array(IsoDateTime),
      /** The last try's failure; null for a step from before failures were kept. */
      failure: AIFailureSchema.nullable(),
    }),
  ),
  currentProvider: z.string().nullable(),
});

// ─── A mail's AI status (the Gmail Sync row, its (i), and the mail sandbox) ─────────

/**
 * Why a mail waits for AI or stopped. Waiting: the user's AI access (NOT_SET_UP to PAUSED,
 * SAFETY_LIMIT), or the pause of the model the mail needs next (RATE_LIMITED, PROVIDER_BUSY,
 * NO_ANSWER_IN_TIME, PROVIDER_UNAVAILABLE). Stopped: NO_ANSWER_IN_TIME after the last automatic
 * try, INVALID_OUTPUT, INVALID_REQUEST, INTERNAL_ERROR, or GMAIL_FAILED (the mail could not be
 * read from Gmail). Always from the stored kind, never from stored text, so older mails get it too.
 */
export const EmailAIReasonSchema = z.enum([
  'NOT_SET_UP',
  'KEY_REJECTED',
  'ACCOUNT_OR_BILLING',
  'MODEL_UNAVAILABLE',
  'PROVIDER_UNSUPPORTED',
  'KEY_UNREADABLE',
  'PAUSED',
  'SAFETY_LIMIT',
  'RATE_LIMITED',
  'PROVIDER_BUSY',
  'NO_ANSWER_IN_TIME',
  'PROVIDER_UNAVAILABLE',
  'INVALID_OUTPUT',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
  'GMAIL_FAILED',
  // The free AI's shared pause, or the free AI switched off (owner, 24 Oct 2026).
  'FREE_AI_BUSY',
  'FREE_AI_BUDGET',
  'FREE_AI_PROBLEM',
  'FREE_AI_OFF',
]);
export type EmailAIReason = z.infer<typeof EmailAIReasonSchema>;

/**
 * What happens next:
 * - AUTOMATIC_RETRY: Career Companion tries again by itself, at about `nextTryAt` (null: soon).
 * - WAITS_FOR_TEST_MAIL: not sent yet; it waits for the test mail of "Read waiting mails now".
 * - FIX_AI_SETTINGS: waits until the user fixes AI provider settings.
 * - RETRY_WITH_YOUR_OK: stopped; Manual Retry asks the user's OK for a possible extra charge.
 * - MANUAL_RETRY: stopped; Manual Retry sends it again.
 * - CAREER_COMPANION: stopped or paused on Career Companion's side; only Career Companion can
 *   retry it.
 */
export const EmailAINextStepSchema = z.enum([
  'AUTOMATIC_RETRY',
  'WAITS_FOR_TEST_MAIL',
  'FIX_AI_SETTINGS',
  'RETRY_WITH_YOUR_OK',
  'MANUAL_RETRY',
  'CAREER_COMPANION',
]);
export type EmailAINextStep = z.infer<typeof EmailAINextStepSchema>;

/** Why a waiting or stopped mail is not read yet, and what happens next. Null for other mails. */
export const EmailAIStatusSchema = z.object({
  reason: EmailAIReasonSchema,
  /** The AI step: sorting (classification) or reading the details (extraction). */
  step: z.enum(['classification', 'extraction']).nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  /** This mail's own last failure on that step; null when it only waits (for example a pause). */
  failure: AIFailureSchema.nullable(),
  /** Tries used on the step, and how many it may use (3, plus one for each OK of the user). */
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  /** When each counted try was sent, oldest first. */
  triedAt: z.array(IsoDateTime),
  nextTryAt: IsoDateTime.nullable(),
  nextStep: EmailAINextStepSchema,
  /** "Read waiting mails now": this is the test mail, or it waits for the test mail. */
  readNowTest: z.enum(['TEST_MAIL', 'WAITS_FOR_TEST_MAIL']).nullable(),
});
export type EmailAIStatus = z.infer<typeof EmailAIStatusSchema>;
export type AIRetryApprovalDetails = z.infer<typeof AIRetryApprovalDetailsSchema>;

export const CorrectEmailMatchRequestSchema = z
  .strictObject({
    applicationId: z.uuid().nullable(),
    expectedMatchState: z.enum(['MATCHED', 'IGNORED']),
    expectedApplicationId: z.uuid().nullable(),
  })
  .refine(
    (body) =>
      body.applicationId !== body.expectedApplicationId &&
      (body.applicationId !== null || body.expectedMatchState === 'MATCHED'),
    { message: 'Choose a different application or unlink a matched email' },
  );
export type CorrectEmailMatchRequest = z.infer<typeof CorrectEmailMatchRequestSchema>;
export const CorrectEmailMatchResponseSchema = z.object({
  email: z.object({
    id: z.uuid(),
    matchState: z.enum(['MATCHED', 'IGNORED']),
    matchConfirmedBy: z.literal('USER_CONFIRMED'),
    applicationId: z.uuid().nullable(),
  }),
  affectedApplicationIds: z.array(z.uuid()),
});
export type CorrectEmailMatchResponse = z.infer<typeof CorrectEmailMatchResponseSchema>;
