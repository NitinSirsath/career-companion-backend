import { createPaginatedResponseSchema } from './pagination';
/**
 * Zod contracts for Gmail OAuth routes (COM-19).
 * These types are shared via the sync-contracts script with the frontend.
 *
 * IMPORTANT: No token fields are ever included in response schemas.
 * accessToken and refreshToken must never appear in API responses.
 */

import { z } from 'zod';

const IsoDateTime = z.iso.datetime({ offset: true });

// ─── Shared enums (mirrors Prisma enums) ────────────────────────────────────

export const GmailConnectionStatusSchema = z.enum(['NOT_CONNECTED', 'CONNECTED', 'REVOKED']);
export type GmailConnectionStatus = z.infer<typeof GmailConnectionStatusSchema>;

export const GmailSyncStatusSchema = z.enum(['IDLE', 'SYNCING', 'FAILED']);
export type GmailSyncStatus = z.infer<typeof GmailSyncStatusSchema>;

// ─── GET /api/gmail/status ──────────────────────────────────────────────────

export const GmailStatusResponseSchema = z.object({
  connected: z.boolean(),
  gmailEmail: z.string().nullable(),
  status: GmailConnectionStatusSchema.nullable(),
  syncStatus: GmailSyncStatusSchema.nullable(),
  syncError: z.string().nullable().optional(),
  lastSyncedAt: z.date().nullable().or(z.string().nullable()),
  syncLookbackDays: z.number().optional(),
  nextScheduledSyncAt: IsoDateTime.nullable().optional(),
  unscannedGap: z.object({ from: IsoDateTime, until: IsoDateTime }).nullable().optional(),
});
export type GmailStatusResponse = z.infer<typeof GmailStatusResponseSchema>;

// ─── POST /api/gmail/disconnect ─────────────────────────────────────────────

export const GmailDisconnectResponseSchema = z.object({
  disconnected: z.boolean(),
});
export type GmailDisconnectResponse = z.infer<typeof GmailDisconnectResponseSchema>;

// ─── POST /api/gmail/sync ───────────────────────────────────────────────────

export const SyncResponseSchema = z.object({ accepted: z.literal(true) });
export type SyncResponse = z.infer<typeof SyncResponseSchema>;

// ─── GET /api/gmail/messages ────────────────────────────────────────────────

export const EmailRelevanceStateSchema = z.enum(['UNPROCESSED', 'RELEVANT', 'IRRELEVANT']);
export const EmailMatchStateSchema = z.enum(['UNMATCHED', 'MATCHED', 'AMBIGUOUS', 'IGNORED']);

export const EmailMessageSchema = z.object({
  applicationId: z.uuid().nullable().optional(),
  matchConfirmedBy: z.enum(['AI_AUTO', 'USER_CONFIRMED']).nullable().optional(),
  application: z
    .object({ id: z.uuid(), companyName: z.string(), jobTitle: z.string().nullable() })
    .nullable()
    .optional(),
  id: z.string(),
  gmailMessageId: z.string(),
  threadId: z.string().nullable(),
  subject: z.string().nullable(),
  sender: z.string().nullable(),
  receivedAt: z.union([z.string(), z.date()]).nullable(),
  relevanceState: EmailRelevanceStateSchema,
  matchState: EmailMatchStateSchema,
  // Server-derived inactivity signal; timestamps remain private.
  processingStuck: z.boolean().optional(),
  processingState: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']).optional(),
  processingErrorCategory: z.string().nullable().optional(),
  processingErrorDetails: z.string().nullable().optional(),
  processingErrorStage: z.string().nullable().optional(),
  processingRetryable: z.boolean().nullable().optional(),
  processingFailedAt: z.union([z.string(), z.date()]).nullable().optional(),
  /** Provenance of the AI result: which provider and model produced it (ADR-0001). */
  aiProcessingResult: z.object({ provider: z.string(), model: z.string() }).nullable().optional(),
});
export type EmailMessage = z.infer<typeof EmailMessageSchema>;

export const MessagesListResponseSchema = createPaginatedResponseSchema(EmailMessageSchema);
export type MessagesListResponse = z.infer<typeof MessagesListResponseSchema>;

export const GmailSettingsPatchSchema = z.object({
  syncLookbackDays: z.number().int().refine((value) => [1, 7, 14, 30].includes(value), {
    message: 'syncLookbackDays must be 1, 7, 14, or 30',
  }),
});
export type GmailSettingsPatch = z.infer<typeof GmailSettingsPatchSchema>;
