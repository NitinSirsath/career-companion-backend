/**
 * AI settings for the session user (ADR-0001 decisions 5–6; plan §5).
 *
 * One active configuration per user. Saving verifies first: a definitive rejection saves nothing
 * and leaves any current setup untouched, so switching provider keeps the old setup working until
 * the new key is verified. The key is write-only: it is sealed on save, opened only to verify or
 * call, and never returned, logged or echoed.
 */
import { AIAccessIssue, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import {
  AI_CATALOG,
  AIRole,
  CatalogProvider,
  catalogDay,
  modelsForRole,
} from '../../contracts/aiCatalog';
import type {
  AISampleTestResponse,
  AISettingsResponse,
  CheckAISettingsResponse,
  SaveAISettingsRequest,
  SaveAISettingsResponse,
} from '../../contracts/ai';
import { reofferPendingEmails } from '../gmailSync';
import {
  AIAccess,
  CONFIGURATION_STATE,
  deriveAccess,
  isOffered,
  modelsFor,
  offeredProvider,
  resolveAIAccess,
  stateOf,
} from './access';
import { CLASSIFICATION_INPUT_LIMITS as LIMITS, EXTRACTION_BODY_LIMIT } from './contracts';
import { AIAccessError, ProviderFailure } from './errors';
import { SAMPLE_EMAIL } from './sampleEmail';
import { CredentialUnreadableError, openApiKey, sealApiKey } from './credentials';
import { createProviderClient, VerifyResult } from './providers';
import {
  MAX_DAILY_VERIFICATIONS,
  nextUtcMidnight,
  noteProviderFailure,
  noteProviderSuccess,
  recordTokens,
  reserveUserCall,
  userDailyCallLimit,
  utcDay,
} from './usage';
import { logEvent, logError } from '../../utils/log';

/** An expected, user-facing outcome of a settings request. Never carries key material. */
export class SettingsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}

// Printable ASCII without spaces: no provider key format needs more, and nothing else is accepted.
const API_KEY = /^[\x21-\x7e]{8,512}$/;
const NEEDS_ATTENTION_ISSUES: AIAccessIssue[] = ['KEY_REJECTED', 'ACCOUNT_OR_BILLING', 'MODEL_UNAVAILABLE', 'KEY_UNREADABLE'];

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);

export async function readSettings(userId: string, now = new Date()): Promise<AISettingsResponse> {
  const [config, usage, waitingEmails] = await Promise.all([
    prisma.aIConfiguration.findUnique({ where: { userId }, select: CONFIGURATION_STATE }),
    prisma.aIUsageDay.findUnique({ where: { userId_day: { userId, day: utcDay(now) } } }),
    prisma.email.count({ where: { userId, processingState: 'PENDING' } }),
  ]);
  const access = deriveAccess(config, usage?.calls ?? 0, now);
  const provider = config ? AI_CATALOG.find((p) => p.id === config.provider) : undefined;
  const models = config && provider ? modelsFor(provider, config, now) : null;
  return {
    configured: !!config,
    provider: config?.provider ?? null,
    offeredProviders: AI_CATALOG.filter(isOffered).map((p) => p.id),
    models: models && {
      fast: { id: models.models.fast.id, source: models.sources.fast },
      detailed: { id: models.models.detailed.id, source: models.sources.detailed },
    },
    access: {
      state: access.state,
      reason: access.reason,
      modelId: access.modelId,
      resumesAt: iso(access.resumesAt),
      verified: !!config?.verifiedAt,
      lastCheckedAt: iso(config?.lastCheckedAt),
    },
    usageToday: {
      day: utcDay(now),
      calls: usage?.calls ?? 0,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
    },
    safetyLimit: { callsPerDay: userDailyCallLimit(), resetsAt: nextUtcMidnight(now).toISOString() },
    waitingEmails,
    consent: config && {
      disclosure: config.consentDisclosure,
      consentedAt: config.consentedAt.toISOString(),
      current: provider?.disclosure.version === config.consentDisclosure,
    },
  };
}

/** Counts one content-free verification against the user's daily cap. */
async function reserveVerification(userId: string, now: Date) {
  const day = utcDay(now);
  await prisma.aIUsageDay.upsert({ where: { userId_day: { userId, day } }, create: { userId, day }, update: {} });
  const reserved = await prisma.aIUsageDay.updateMany({
    where: { userId, day, verifications: { lt: MAX_DAILY_VERIFICATIONS } },
    data: { verifications: { increment: 1 } },
  });
  if (!reserved.count)
    throw new SettingsError(429, 'AI_VERIFY_RATE_LIMITED', 'Too many key checks today. Try again tomorrow.', {
      resetsAt: nextUtcMidnight(now).toISOString(),
    });
}

function chosenModel(
  provider: CatalogProvider,
  role: AIRole,
  requested: string | null | undefined,
  current: string | null,
  now: Date,
): string | null {
  if (requested === undefined) return current;
  if (requested === null) return null;
  if (!modelsForRole(provider, role, catalogDay(now)).some((m) => m.id === requested))
    throw new SettingsError(400, 'VALIDATION_ERROR', `That ${role} model is not offered for this provider.`);
  return requested;
}

const rejectedError = (result: Extract<VerifyResult, { result: 'REJECTED' }>) =>
  new SettingsError(422, 'AI_ACCESS_REJECTED', 'The provider refused this key or model. Nothing was saved.', {
    reason: result.kind,
    modelId: result.modelId ?? null,
  });

export async function saveSettings(
  userId: string,
  request: SaveAISettingsRequest,
  now = new Date(),
): Promise<SaveAISettingsResponse> {
  const provider = offeredProvider(request.provider);
  if (!provider) throw new SettingsError(400, 'VALIDATION_ERROR', 'That AI provider is not offered.');
  const existing = await prisma.aIConfiguration.findUnique({
    where: { userId },
    select: { ...CONFIGURATION_STATE, encryptedApiKey: true },
  });
  const switching = !existing || existing.provider !== provider.id;
  const newKey = request.apiKey?.trim() ?? '';
  if (newKey && !API_KEY.test(newKey))
    throw new SettingsError(400, 'VALIDATION_ERROR', 'The API key format is not valid.');
  if (!newKey && switching)
    throw new SettingsError(400, 'VALIDATION_ERROR', 'An API key is required for this provider.');
  if (switching && request.consentDisclosure !== provider.disclosure.version)
    throw new SettingsError(400, 'VALIDATION_ERROR', 'Confirm the data-use summary for this provider.');
  if (request.consentDisclosure !== undefined && request.consentDisclosure !== provider.disclosure.version)
    throw new SettingsError(400, 'VALIDATION_ERROR', 'The data-use summary has changed. Review it again.');

  let apiKey = newKey;
  if (!apiKey) {
    try {
      apiKey = openApiKey(userId, existing!.encryptedApiKey);
    } catch (err) {
      if (!(err instanceof CredentialUnreadableError)) throw err;
      throw new SettingsError(400, 'AI_KEY_REQUIRED', 'Enter your API key again.');
    }
  }
  const fastModel = chosenModel(provider, 'fast', request.models?.fast, switching ? null : existing!.fastModel, now);
  const detailedModel = chosenModel(provider, 'detailed', request.models?.detailed, switching ? null : existing!.detailedModel, now);
  const { models } = modelsFor(provider, { fastModel, detailedModel }, now);

  await reserveVerification(userId, now);
  const result = await createProviderClient(provider, apiKey).verifyModels([models.fast.id, models.detailed.id]);
  const keyChanged = switching || !!newKey;
  logEvent('ai_access_checked', {
    userId,
    provider: provider.id,
    on: 'save',
    result: result.result,
    kind: result.result === 'REJECTED' ? result.kind : undefined,
  });
  if (result.result === 'REJECTED') throw rejectedError(result);

  const verified = result.result === 'VERIFIED';
  // A definitive success clears problems that need the user's attention; an inconclusive check
  // never overwrites what is known about an unchanged key. A new key starts from a clean state.
  const state: Prisma.AIConfigurationUncheckedUpdateInput = keyChanged
    ? { accessIssue: null, accessIssueModel: null, cooldownUntil: null, consecutiveFailures: 0, verifiedAt: verified ? now : null }
    : verified
      ? existing!.accessIssue && NEEDS_ATTENTION_ISSUES.includes(existing!.accessIssue)
        ? { accessIssue: null, accessIssueModel: null, verifiedAt: now }
        : { verifiedAt: now }
      : {};
  const consent = request.consentDisclosure ? { consentDisclosure: request.consentDisclosure, consentedAt: now } : {};
  const fields = {
    provider: provider.id,
    fastModel,
    detailedModel,
    lastCheckedAt: now,
    ...(newKey ? { encryptedApiKey: sealApiKey(userId, newKey) } : {}),
  };
  if (existing) {
    // Overwrites the row in place: a replaced key's ciphertext is gone from the live record.
    await prisma.aIConfiguration.update({
      where: { userId },
      data: { ...fields, ...state, ...consent, revision: { increment: 1 } },
    });
  } else {
    await prisma.aIConfiguration.create({
      data: {
        userId,
        ...fields,
        encryptedApiKey: sealApiKey(userId, newKey),
        consentDisclosure: request.consentDisclosure!,
        consentedAt: now,
        verifiedAt: verified ? now : null,
      },
    });
  }
  logEvent('ai_settings_saved', { userId, provider: provider.id, verification: result.result, switched: switching, keyChanged });
  await reofferPendingEmails(userId);
  return { ...(await readSettings(userId, now)), verification: result.result };
}

export async function checkSettings(userId: string, now = new Date()): Promise<CheckAISettingsResponse> {
  const config = await prisma.aIConfiguration.findUnique({
    where: { userId },
    select: { ...CONFIGURATION_STATE, encryptedApiKey: true },
  });
  if (!config) throw new SettingsError(404, 'AI_NOT_CONFIGURED', 'AI is not set up.');
  const provider = offeredProvider(config.provider);
  if (!provider) throw new SettingsError(409, 'AI_PROVIDER_UNSUPPORTED', 'This provider is no longer offered. Choose another provider.');
  const guarded = { userId, revision: config.revision };
  let apiKey: string;
  try {
    apiKey = openApiKey(userId, config.encryptedApiKey);
  } catch (err) {
    if (!(err instanceof CredentialUnreadableError)) throw err;
    logError('ai_credential_unreadable', { userId });
    await prisma.aIConfiguration.updateMany({
      where: guarded,
      data: { accessIssue: 'KEY_UNREADABLE', accessIssueModel: null, lastCheckedAt: now },
    });
    return { ...(await readSettings(userId, now)), verification: 'REJECTED' };
  }
  await reserveVerification(userId, now);
  const { models } = modelsFor(provider, config, now);
  const result = await createProviderClient(provider, apiKey).verifyModels([models.fast.id, models.detailed.id]);
  logEvent('ai_access_checked', {
    userId,
    provider: provider.id,
    on: 'check',
    result: result.result,
    kind: result.result === 'REJECTED' ? result.kind : undefined,
  });
  if (result.result === 'VERIFIED') {
    // A model lookup proves access, not that a rate limit has cleared: a cooldown stays.
    const clears = config.accessIssue && NEEDS_ATTENTION_ISSUES.includes(config.accessIssue);
    await prisma.aIConfiguration.updateMany({
      where: guarded,
      data: { verifiedAt: now, lastCheckedAt: now, ...(clears ? { accessIssue: null, accessIssueModel: null } : {}) },
    });
    await reofferPendingEmails(userId);
  } else if (result.result === 'REJECTED') {
    await prisma.aIConfiguration.updateMany({
      where: guarded,
      data: { accessIssue: result.kind, accessIssueModel: result.modelId ?? null, lastCheckedAt: now },
    });
  } else {
    await prisma.aIConfiguration.updateMany({ where: guarded, data: { lastCheckedAt: now } });
  }
  return { ...(await readSettings(userId, now)), verification: result.result };
}

/** Removes the configuration and its sealed key. Processed data stays. Idempotent. */
export async function removeSettings(userId: string): Promise<{ removed: true }> {
  const { count } = await prisma.aIConfiguration.deleteMany({ where: { userId } });
  if (count) logEvent('ai_settings_removed', { userId });
  return { removed: true };
}

const unavailable = (err: AIAccessError) =>
  new SettingsError(409, 'AI_ACCESS_UNAVAILABLE', 'AI access cannot be used right now.', {
    state: stateOf(err.reason),
    reason: err.reason,
    resumesAt: iso(err.resumesAt),
  });

/**
 * Runs both capabilities on the built-in synthetic email (never the user's mail) with the saved
 * configuration, and returns the validated result. Real calls on the user's account: they count
 * toward the safety limit, and refusals update access state like any call. Nothing is persisted
 * apart from those counts and state: no ledger row, no result.
 */
export async function runSampleTest(userId: string, now = new Date()): Promise<AISampleTestResponse> {
  const configured = await prisma.aIConfiguration.count({ where: { userId } });
  if (!configured) throw new SettingsError(404, 'AI_NOT_CONFIGURED', 'AI is not set up.');
  let access: AIAccess;
  try {
    access = await resolveAIAccess(userId, now);
  } catch (err) {
    if (err instanceof AIAccessError) throw unavailable(err);
    throw err;
  }
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const call = async <T>(model: string, invoke: () => Promise<{ data: T; usage: { inputTokens: number | null; outputTokens: number | null } }>) => {
    try {
      await prisma.$transaction((tx) => reserveUserCall(tx, userId, now));
    } catch (err) {
      if (err instanceof AIAccessError) throw unavailable(err);
      throw err;
    }
    usage.calls++;
    try {
      const result = await invoke();
      await recordTokens(userId, now, result.usage);
      usage.inputTokens += result.usage.inputTokens ?? 0;
      usage.outputTokens += result.usage.outputTokens ?? 0;
      return result.data;
    } catch (err) {
      const kind = err instanceof ProviderFailure ? err.kind : 'OUTCOME_UNKNOWN';
      logEvent('ai_sample_test', { userId, provider: access.provider, outcome: kind, ...usage });
      if (kind === 'KEY_REJECTED' || kind === 'ACCOUNT_OR_BILLING' || kind === 'MODEL_UNAVAILABLE' || kind === 'RATE_LIMITED') {
        const resumesAt = await prisma.$transaction((tx) =>
          noteProviderFailure(tx, access, kind, now, { modelId: model, retryAfterMs: (err as ProviderFailure).retryAfterMs }),
        );
        if (kind === 'RATE_LIMITED') throw unavailable(new AIAccessError('RATE_LIMITED', resumesAt));
        throw new SettingsError(422, 'AI_ACCESS_REJECTED', 'The provider refused this key or model.', {
          reason: kind,
          modelId: kind === 'MODEL_UNAVAILABLE' ? model : null,
        });
      }
      if (err instanceof ProviderFailure && err.usage) await recordTokens(userId, now, err.usage);
      throw new SettingsError(502, 'AI_SAMPLE_FAILED', 'The sample test did not return a usable result.', { kind });
    }
  };

  const classification = await call(access.models.fast.id, () =>
    access.classifier.classifyRelevance({
      sender: SAMPLE_EMAIL.sender.slice(0, LIMITS.sender),
      subject: SAMPLE_EMAIL.subject.slice(0, LIMITS.subject),
      labels: SAMPLE_EMAIL.labels.slice(0, LIMITS.labels),
      snippet: SAMPLE_EMAIL.snippet.slice(0, LIMITS.snippet),
    }),
  );
  const extraction = await call(access.models.detailed.id, () =>
    access.analyzer.extractJobData(SAMPLE_EMAIL.body.slice(0, EXTRACTION_BODY_LIMIT)),
  );
  await noteProviderSuccess(access);
  logEvent('ai_sample_test', { userId, provider: access.provider, outcome: 'COMPLETED', ...usage });
  return {
    provider: access.provider,
    models: { fast: access.models.fast.id, detailed: access.models.detailed.id },
    classification: {
      decision: classification.decision,
      category: classification.category ?? null,
      confidence: classification.confidence,
    },
    extraction: {
      companyName: extraction.companyName,
      jobTitle: extraction.jobTitle,
      interviewStage: extraction.interviewStage,
      interviewDate: extraction.interviewDate,
      interviewTime: extraction.interviewTime,
      actionRequired: extraction.actionRequired,
      requestedAction: extraction.requestedAction,
      actionDeadline: extraction.actionDeadline,
    },
    usage,
  };
}
