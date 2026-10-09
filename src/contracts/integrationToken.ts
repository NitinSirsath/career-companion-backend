/**
 * Integration tokens for the MCP endpoint (ADR-0002 decision 10). Shared with the frontend by
 * sync-contracts.
 *
 * IMPORTANT: the plaintext token appears only in the create response, once. No other response
 * carries it, its hash, or any part of it beyond the display prefix.
 */
import { z } from 'zod';
import { createPaginatedResponseSchema } from './pagination';

const IsoDateTime = z.iso.datetime({ offset: true });

export const INTEGRATION_TOKEN_DEFAULT_EXPIRY_DAYS = 90;
export const INTEGRATION_TOKEN_MAX_EXPIRY_DAYS = 365;
export const INTEGRATION_TOKEN_MAX_ACTIVE = 5;
/** Expiry warnings start this many days before a token expires. */
export const INTEGRATION_TOKEN_EXPIRY_WARNING_DAYS = 14;

export const IntegrationTokenStatusSchema = z.enum(['active', 'expired', 'revoked']);
export type IntegrationTokenStatus = z.infer<typeof IntegrationTokenStatusSchema>;

// ─── POST /api/integration-tokens ───────────────────────────────────────────

export const CreateIntegrationTokenRequestSchema = z.strictObject({
  name: z.string().trim().min(1, 'Name is required').max(100),
  expiresInDays: z
    .number()
    .int()
    .min(1)
    .max(INTEGRATION_TOKEN_MAX_EXPIRY_DAYS)
    .default(INTEGRATION_TOKEN_DEFAULT_EXPIRY_DAYS),
});
export type CreateIntegrationTokenRequest = z.input<typeof CreateIntegrationTokenRequestSchema>;

export const IntegrationTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The first characters of the token, for recognising it. Never enough to use it. */
  displayPrefix: z.string(),
  scope: z.string(),
  status: IntegrationTokenStatusSchema,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  lastUsedAt: IsoDateTime.nullable(),
  revokedAt: IsoDateTime.nullable(),
});
export type IntegrationToken = z.infer<typeof IntegrationTokenSchema>;

/** The only response that carries the plaintext token. Show it once; never store it client-side. */
export const CreateIntegrationTokenResponseSchema = z.object({
  integrationToken: IntegrationTokenSchema,
  plaintextToken: z.string().regex(/^ccmcp_[A-Za-z0-9_-]{43}$/),
});
export type CreateIntegrationTokenResponse = z.infer<typeof CreateIntegrationTokenResponseSchema>;

// ─── GET /api/integration-tokens ────────────────────────────────────────────

export const ListIntegrationTokensResponseSchema =
  createPaginatedResponseSchema(IntegrationTokenSchema);
export type ListIntegrationTokensResponse = z.infer<typeof ListIntegrationTokensResponseSchema>;

// ─── DELETE /api/integration-tokens/:id (revoke) ───────────────────────────

export const RevokeIntegrationTokenResponseSchema = IntegrationTokenSchema;
export type RevokeIntegrationTokenResponse = IntegrationToken;
