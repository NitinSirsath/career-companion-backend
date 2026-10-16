/**
 * Zod contracts for the AI settings routes (ADR-0001). Shared with the frontend by sync-contracts.
 *
 * IMPORTANT: no response schema has any key field. A saved API key is write-only and never
 * returned, masked, hinted or echoed, including in the save response and in validation errors.
 */
import { z } from 'zod';
import { AI_ROLES } from './aiCatalog';

const IsoDateTime = z.iso.datetime({ offset: true });

// ─── The exact error ────────────────────────────────────────────────────────

/**
 * What a failed AI call was, in the words the screens use:
 * - PROVIDER_BUSY: a short server error, overloaded, a conflict (409, OpenAI or Anthropic), or a
 *   request that never left. No try used.
 * - NO_ANSWER_IN_TIME: our timer, Google's deadline (504), or a line that dropped after sending.
 *   Uses one try; the provider may have charged it.
 * - RATE_LIMITED: 429, per minute or per day (`quotaScope`).
 * - KEY_REJECTED, ACCOUNT_OR_BILLING, MODEL_UNAVAILABLE: the user's key, account or model.
 * - INVALID_OUTPUT: an answer Career Companion could not use (`stopReason` when it stopped early).
 * - INVALID_REQUEST: the provider refused Career Companion's request (another 400): our problem.
 * - INTERNAL_ERROR: an error in Career Companion's own code.
 */
export const AIFailureKindSchema = z.enum([
  'PROVIDER_BUSY',
  'NO_ANSWER_IN_TIME',
  'RATE_LIMITED',
  'KEY_REJECTED',
  'ACCOUNT_OR_BILLING',
  'MODEL_UNAVAILABLE',
  'INVALID_OUTPUT',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
]);
export type AIFailureKind = z.infer<typeof AIFailureKindSchema>;

/**
 * One failed AI call as Career Companion measured it: the status, the provider's short code, the
 * model and our own times. Never the provider's message text: it can echo the key or mail content.
 */
export const AIFailureSchema = z.object({
  kind: AIFailureKindSchema,
  /**
   * Where it failed: our own timer (TIMEOUT), the provider's deadline (PROVIDER_DEADLINE), no
   * connection before sending (NETWORK), the line dropped after sending (NETWORK_AFTER_SEND), the
   * provider's answer (PROVIDER_ANSWER), or Career Companion's own code (UNCLASSIFIED).
   */
  cause: z.enum([
    'TIMEOUT',
    'PROVIDER_DEADLINE',
    'NETWORK',
    'NETWORK_AFTER_SEND',
    'PROVIDER_ANSWER',
    'UNCLASSIFIED',
  ]),
  provider: z.string(),
  model: z.string(),
  httpStatus: z.number().int().nullable(),
  /** The provider's short code, for example UNAVAILABLE or API_KEY_INVALID. */
  providerCode: z.string().nullable(),
  /** Which quota a 429 hit. */
  quotaScope: z.enum(['PER_DAY', 'PER_MINUTE']).nullable(),
  /** The quota was the provider's free tier. */
  freeTier: z.boolean(),
  /** A failed connection's code, for example ENOTFOUND or ECONNRESET. */
  networkCode: z.string().nullable(),
  /** Why the provider stopped an answer that could not be used, for example MAX_TOKENS or SAFETY. */
  stopReason: z.string().nullable(),
  at: IsoDateTime,
  /** How long Career Companion waited for the answer. */
  waitedMs: z.number().int(),
  /**
   * The time limit the provider got: the model's own (60 seconds for Gemini 3.8 Flash), or the key
   * check's. Career Companion stops waiting 15 seconds after a model's limit.
   */
  timeoutMs: z.number().int(),
  /** The try this call used, of `maxAttempts`; null when it used none (it was refused). */
  attempt: z.number().int().nullable(),
  maxAttempts: z.number().int().nullable(),
});
export type AIFailure = z.infer<typeof AIFailureSchema>;

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
  'PROVIDER_BUSY',
  'PROVIDER_UNAVAILABLE',
  'SAFETY_LIMIT',
  'PAUSED',
]);
export type AIAccessReason = z.infer<typeof AIAccessReasonSchema>;

export const ModelInUseSchema = z.object({
  id: z.string(),
  source: z.enum(['RECOMMENDED', 'SELECTED', 'REPLACED_RETIRED']),
});

/** A model the setup uses now is paused. A model with no pause is working. */
export const AIModelPauseSchema = z.object({
  model: z.string(),
  /** The roles that use the model now. */
  roles: z.array(z.enum(AI_ROLES)),
  /**
   * RATE_LIMITED, PROVIDER_BUSY, or PROVIDER_UNAVAILABLE (older pauses). No answer in time pauses
   * as PROVIDER_BUSY: `failure.kind` says NO_ANSWER_IN_TIME.
   */
  reason: AIAccessReasonSchema,
  resumesAt: IsoDateTime,
  /** The failure that started or last extended the pause; null for a pause from before it was kept. */
  failure: AIFailureSchema.nullable(),
  /**
   * The test mail of "Read waiting mails now": which mail, when it was sent, and how it failed.
   * `result` is null while it waits for the answer. Other mail that needs this model waits for it.
   */
  test: z
    .object({
      emailId: z.uuid(),
      startedAt: IsoDateTime.nullable(),
      result: AIFailureKindSchema.nullable(),
    })
    .nullable(),
});
export type AIModelPause = z.infer<typeof AIModelPauseSchema>;

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
    /** The model a MODEL_UNAVAILABLE problem or a pause refers to. */
    modelId: z.string().nullable(),
    resumesAt: IsoDateTime.nullable(),
    /**
     * The exact failure behind `reason`: the pause's, or the key, billing or model problem's. A
     * pause after no answer in time has reason PROVIDER_BUSY and failure kind NO_ANSWER_IN_TIME.
     */
    failure: AIFailureSchema.nullable(),
    /** Each running pause of a model the setup uses now. */
    pauses: z.array(AIModelPauseSchema),
    verified: z.boolean(),
    lastCheckedAt: IsoDateTime.nullable(),
  }),
  /** The latest failure kept for the account: a model's pause (also one that ended) or access. */
  lastFailure: AIFailureSchema.nullable(),
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
  /**
   * Mails that got no answer in time on their last automatic try: they wait for the user's OK
   * (Manual Retry). `model`, `lastTriedAt` and `tries` are those of the one tried last; a mail
   * held after a failed batch or from before tries were kept can have fewer than 3 tries.
   */
  needsYourOk: z.object({
    emails: z.number().int(),
    model: z.string().nullable(),
    lastTriedAt: IsoDateTime.nullable(),
    tries: z.number().int(),
  }),
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
  /** INCONCLUSIVE only: why the provider did not confirm the key, for example no answer in time. */
  verificationFailure: AIFailureSchema.nullable(),
});
export type SaveAISettingsResponse = z.infer<typeof SaveAISettingsResponseSchema>;

// ─── POST /api/ai/settings/check ────────────────────────────────────────────

export const CheckAISettingsResponseSchema = AISettingsResponseSchema.extend({
  verification: z.enum(['VERIFIED', 'REJECTED', 'INCONCLUSIVE']),
  /** INCONCLUSIVE only: why the provider did not confirm the key, for example no answer in time. */
  verificationFailure: AIFailureSchema.nullable(),
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
  usage: z.object({
    calls: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
  }),
});
export type AISampleTestResponse = z.infer<typeof AISampleTestResponseSchema>;

// ─── POST /api/ai/waiting/read ──────────────────────────────────────────────

/**
 * "Read waiting mails now": while a model is paused, sends one waiting mail first as a test, and
 * the others follow only if it works; without a pause, offers the waiting mail again. Answers with
 * the AI settings as they are right after that; the result of the new try shows in a later read.
 */
export const ReadWaitingMailResponseSchema = AISettingsResponseSchema;
export type ReadWaitingMailResponse = z.infer<typeof ReadWaitingMailResponseSchema>;

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
  /** The paused model, when a model's pause is the reason. */
  modelId: z.string().nullable(),
  /** The failure behind the reason, when it is known. */
  failure: AIFailureSchema.nullable(),
});

/** 502 AI_SAMPLE_FAILED: the sample test got no usable result. */
export const AISampleFailedDetailsSchema = z.object({
  /** Which model did not answer or answered unusably, how, and how long Career Companion waited. */
  failure: AIFailureSchema,
});
