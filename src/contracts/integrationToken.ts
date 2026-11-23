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

// ─── GET /api/integration-tokens/connection ─────────────────────────────────

/**
 * Where the automation reaches this backend: `https://` and the first MCP_ALLOWED_HOSTS name, or
 * null when none is set (local runs, where the frontend's own address passes /mcp on).
 */
export const McpConnectionResponseSchema = z.object({ serverAddress: z.string().nullable() });
export type McpConnectionResponse = z.infer<typeof McpConnectionResponseSchema>;

// ─── DELETE /api/integration-tokens/:id (revoke) ───────────────────────────

export const RevokeIntegrationTokenResponseSchema = IntegrationTokenSchema;
export type RevokeIntegrationTokenResponse = IntegrationToken;

// ─── One-click setup codes (owner, 23 Nov 2026) ─────────────────────────────
//
// "Open in Codex / Claude Code" links carry a setup code, never a token. The code works once, for
// SETUP_CODE_MINUTES; the user's AI swaps it for a new integration token (POST /api/setup-codes/redeem).

export const SETUP_CODE_MINUTES = 10;
/** NL-XXXX-XXXX-XXXX: letters and digits that are hard to mix up (no 0/O, 1/I/L). */
export const SETUP_CODE_PATTERN = /^NL-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;

// POST /api/integration-tokens/setup-codes (signed in)
export const CreateSetupCodeRequestSchema = z.strictObject({
  /** The name the new token gets, for example the computer. */
  name: z.string().trim().min(1, 'Name is required').max(100),
});
export type CreateSetupCodeRequest = z.input<typeof CreateSetupCodeRequestSchema>;

export const CreateSetupCodeResponseSchema = z.object({
  code: z.string().regex(SETUP_CODE_PATTERN),
  expiresAt: IsoDateTime,
});
export type CreateSetupCodeResponse = z.infer<typeof CreateSetupCodeResponseSchema>;

// POST /api/setup-codes/redeem (no sign-in; the code is the proof)
export const RedeemSetupCodeRequestSchema = z.strictObject({
  code: z.string().trim().min(1).max(40),
});
export type RedeemSetupCodeRequest = z.input<typeof RedeemSetupCodeRequestSchema>;

/** The second response that carries a plaintext token, once: to the AI that swapped the code. */
export const RedeemSetupCodeResponseSchema = z.object({
  serverAddress: z.string(),
  name: z.string(),
  plaintextToken: z.string().regex(/^ccmcp_[A-Za-z0-9_-]{43}$/),
  expiresAt: IsoDateTime,
});
export type RedeemSetupCodeResponse = z.infer<typeof RedeemSetupCodeResponseSchema>;
