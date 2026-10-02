import { z } from 'zod';

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
      attemptedAt: z.string().nullable(),
    }),
  ),
  currentProvider: z.string().nullable(),
});
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
