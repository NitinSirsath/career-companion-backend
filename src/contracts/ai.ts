/**
 * Zod contracts for the AI settings routes (ADR-0001). Shared with the frontend by sync-contracts.
 *
 * IMPORTANT: no response schema has any key field. A saved API key is write-only and never
 * returned, masked, hinted or echoed, including in the save response and in validation errors.
 */
import { z } from 'zod';

const IsoDateTime = z.iso.datetime({ offset: true });

export const AIAccessStateSchema = z.enum(['NOT_SET_UP', 'READY', 'NEEDS_ATTENTION', 'LIMITED']);
export type AIAccessState = z.infer<typeof AIAccessStateSchema>;

export const AIAccessReasonSchema = z.enum([
  'NOT_SET_UP',
  'KEY_REJECTED',
  'ACCOUNT_OR_BILLING',
  'MODEL_UNAVAILABLE',
  'PROVIDER_UNSUPPORTED',
  'KEY_UNREADABLE',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'SAFETY_LIMIT',
  'PAUSED',
]);
export type AIAccessReason = z.infer<typeof AIAccessReasonSchema>;

export const ModelInUseSchema = z.object({
  id: z.string(),
  source: z.enum(['RECOMMENDED', 'SELECTED', 'REPLACED_RETIRED']),
});

// ─── GET /api/ai/settings ───────────────────────────────────────────────────

export const AISettingsResponseSchema = z.object({
  configured: z.boolean(),
  provider: z.string().nullable(),
  /** Catalog providers this server accepts now (hidden providers are not offered in production). */
  offeredProviders: z.array(z.string()),
  models: z.object({ fast: ModelInUseSchema, detailed: ModelInUseSchema }).nullable(),
  access: z.object({
    state: AIAccessStateSchema,
    reason: AIAccessReasonSchema.nullable(),
    /** The model a MODEL_UNAVAILABLE problem refers to. */
    modelId: z.string().nullable(),
    resumesAt: IsoDateTime.nullable(),
    verified: z.boolean(),
    lastCheckedAt: IsoDateTime.nullable(),
  }),
  /** Career Companion's own counts for today (UTC). Not provider billing data. */
  usageToday: z.object({
    day: z.string(),
    calls: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
  }),
  /** Career Companion's safeguard, not the provider's quota. */
  safetyLimit: z.object({ callsPerDay: z.number().int(), resetsAt: IsoDateTime }),
  waitingEmails: z.number().int(),
  consent: z
    .object({ disclosure: z.string(), consentedAt: IsoDateTime, current: z.boolean() })
    .nullable(),
});
export type AISettingsResponse = z.infer<typeof AISettingsResponseSchema>;

// ─── PUT /api/ai/settings ───────────────────────────────────────────────────

export const SaveAISettingsRequestSchema = z.strictObject({
  provider: z.string().min(1).max(64),
  /** Required for a new provider. Omitted or empty keeps the saved key (same provider only). */
  apiKey: z.string().max(512).optional(),
  /** null = recommended; omitted = keep the current choice (same provider) or recommended. */
  models: z
    .strictObject({
      fast: z.string().max(128).nullable().optional(),
      detailed: z.string().max(128).nullable().optional(),
    })
    .optional(),
  /** Catalog disclosure version the user agreed to. Required for a new provider. */
  consentDisclosure: z.string().max(128).optional(),
});
export type SaveAISettingsRequest = z.infer<typeof SaveAISettingsRequestSchema>;

export const SaveAISettingsResponseSchema = AISettingsResponseSchema.extend({
  verification: z.enum(['VERIFIED', 'INCONCLUSIVE']),
});
export type SaveAISettingsResponse = z.infer<typeof SaveAISettingsResponseSchema>;

// ─── POST /api/ai/settings/check ────────────────────────────────────────────

export const CheckAISettingsResponseSchema = AISettingsResponseSchema.extend({
  verification: z.enum(['VERIFIED', 'REJECTED', 'INCONCLUSIVE']),
});
export type CheckAISettingsResponse = z.infer<typeof CheckAISettingsResponseSchema>;

// ─── POST /api/ai/settings/sample-test ──────────────────────────────────────

export const AISampleTestResponseSchema = z.object({
  provider: z.string(),
  models: z.object({ fast: z.string(), detailed: z.string() }),
  classification: z.object({
    decision: z.enum(['RELEVANT', 'IRRELEVANT', 'UNCERTAIN']),
    category: z.string().nullable(),
    confidence: z.number(),
  }),
  extraction: z.object({
    companyName: z.string().nullable(),
    jobTitle: z.string().nullable(),
    interviewStage: z.string().nullable(),
    interviewDate: z.string().nullable(),
    interviewTime: z.string().nullable(),
    actionRequired: z.boolean().nullable(),
    requestedAction: z.string().nullable(),
    actionDeadline: z.string().nullable(),
  }),
  usage: z.object({ calls: z.number().int(), inputTokens: z.number().int(), outputTokens: z.number().int() }),
});
export type AISampleTestResponse = z.infer<typeof AISampleTestResponseSchema>;

// ─── DELETE /api/ai/settings ────────────────────────────────────────────────

export const RemoveAISettingsResponseSchema = z.object({ removed: z.literal(true) });

// ─── Error details ──────────────────────────────────────────────────────────

/** 422 AI_ACCESS_REJECTED: the provider definitively refused; nothing was saved. */
export const AIAccessRejectedDetailsSchema = z.object({
  reason: z.enum(['KEY_REJECTED', 'ACCOUNT_OR_BILLING', 'MODEL_UNAVAILABLE']),
  modelId: z.string().nullable(),
});

/** 409 AI_ACCESS_UNAVAILABLE: AI access cannot be used right now. */
export const AIAccessUnavailableDetailsSchema = z.object({
  state: AIAccessStateSchema,
  reason: AIAccessReasonSchema.nullable(),
  resumesAt: IsoDateTime.nullable(),
});
