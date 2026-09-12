/**
 * Zod contracts for Gmail OAuth routes (COM-19).
 * These types are shared via the sync-contracts script with the frontend.
 *
 * IMPORTANT: No token fields are ever included in response schemas.
 * accessToken and refreshToken must never appear in API responses.
 */

import { z } from 'zod';

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
  lastSyncedAt: z.date().nullable().or(z.string().nullable()),
});
export type GmailStatusResponse = z.infer<typeof GmailStatusResponseSchema>;

// ─── POST /api/gmail/disconnect ─────────────────────────────────────────────

export const GmailDisconnectResponseSchema = z.object({
  disconnected: z.boolean(),
});
export type GmailDisconnectResponse = z.infer<typeof GmailDisconnectResponseSchema>;

// ─── POST /api/gmail/sync ───────────────────────────────────────────────────

export const SyncResponseSchema = z.object({
  synced: z.boolean(),
  messagesIngested: z.number(),
  messagesSkipped: z.number(),
  lastSyncedAt: z.union([z.string(), z.date()]).nullable(),
});
export type SyncResponse = z.infer<typeof SyncResponseSchema>;

// ─── GET /api/gmail/messages ────────────────────────────────────────────────

export const EmailRelevanceStateSchema = z.enum(['UNPROCESSED', 'RELEVANT', 'IRRELEVANT']);
export const EmailMatchStateSchema = z.enum(['UNMATCHED', 'MATCHED', 'AMBIGUOUS', 'IGNORED']);

export const EmailMessageSchema = z.object({
  id: z.string(),
  gmailMessageId: z.string(),
  subject: z.string().nullable(),
  sender: z.string().nullable(),
  receivedAt: z.union([z.string(), z.date()]).nullable(),
  relevanceState: EmailRelevanceStateSchema,
  matchState: EmailMatchStateSchema,
});
export type EmailMessage = z.infer<typeof EmailMessageSchema>;

export const MessagesListResponseSchema = z.object({
  messages: z.array(EmailMessageSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});
export type MessagesListResponse = z.infer<typeof MessagesListResponseSchema>;
