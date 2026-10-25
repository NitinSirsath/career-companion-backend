/**
 * AI settings for the session user (ADR-0001 decisions 5–6; plan §5).
 *
 * The active configuration: the one setup that does the user's AI work. Other connected providers
 * are in `connections.ts`. Saving verifies first: a definitive rejection saves nothing and leaves
 * the current setup untouched. The key is write-only: it is sealed on save, opened only to verify
 * or call, and never returned, logged or echoed.
 */
import { AIAccessIssue, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { AppError } from '../../errors';
import {
  AI_CATALOG,
  AI_ROLES,
  AIRole,
  CatalogModel,
  CatalogProvider,
  modelsForRole,
} from '../../contracts/aiCatalog';
import type {
  AIConnection,
  AIFailure,
  AISampleTestResponse,
  AISettingsResponse,
  CheckAIProviderResponse,
  SaveAIProviderRequest,
  SaveAIProviderResponse,
} from '../../contracts/ai';
import { SAVED_PROVIDER_STATE, savedConnection, shownModels } from './connectionView';
import { reofferPendingEmails } from './offer';
import {
  AIAccess,
  CONFIGURATION_STATE,
  NEEDS_ATTENTION_ISSUES,
  blockingPause,
  deriveAccess,
  isOffered,
  modelsFor,
  offeredProvider,
  ModelPause,
  resolveAIAccess,
  setupPauses,
  stateOf,
  withPause,
} from './access';
import { CLASSIFICATION_INPUT_LIMITS as LIMITS, EXTRACTION_BODY_LIMIT } from './contracts';
import { AIAccessError, ProviderFailure, RefusalKind, isRefusal } from './errors';
import { failureRecord, latestFailure, readFailure, shownPause } from './failures';
import { needsYourOk } from './mailStatus';
import { SAMPLE_EMAIL } from './sampleEmail';
import { CredentialUnreadableError, openApiKey, sealApiKey } from './credentials';
import { freeReason, isFreeAI, noFreeAIKey } from './freeAI';
import { createProviderClient, VerifyResult } from './providers';
import {
  MAX_DAILY_VERIFICATIONS,
  afterProviderFailure,
  dailyCallLimit,
  ensureUsageDay,
  nextUtcMidnight,
  noteProviderFailure,
  noteProviderSuccess,
  recordTokens,
  reserveUserCall,
  utcDay,
} from './usage';
import { logEvent, logError } from '../../utils/log';

// Printable ASCII without spaces: no provider key format needs more, and nothing else is accepted.
const API_KEY = /^[\x21-\x7e]{8,512}$/;

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);

type SavedState = Prisma.AIConfigurationGetPayload<{ select: typeof CONFIGURATION_STATE }>;

/** A save of the active setup: the provider and what changes. */
export type SaveRequest = Omit<SaveAIProviderRequest, 'makeActive'> & { provider: string };

/**
 * The user's AI access as the screens get it. The pause that ends last decides; one whose test
 * mail is being tried shows as a new try. Each running pause, and the exact failure behind the
 * reason: the pause's, or the key, billing or model problem's.
 */
function shownAccess(
  config: SavedState | null,
  pauses: ModelPause[],
  callsToday: number,
  now: Date,
): AISettingsResponse['access'] {
  const access = withPause(
    deriveAccess(config, callsToday, now),
    blockingPause(
      pauses.filter((pause) => !pause.testEmailId),
      AI_ROLES,
    ),
  );
  const issue = !!config?.accessIssue && access.reason === config.accessIssue;
  const failure = access.pause?.failure ?? (issue ? readFailure(config?.accessFailure) : null);
  return {
    state: access.state,
    reason: access.reason,
    modelId: access.modelId,
    resumesAt: iso(access.resumesAt),
    failure,
    pauses: pauses.map(shownPause),
    verified: !!config?.verifiedAt,
    lastCheckedAt: iso(config?.lastCheckedAt),
  };
}

export async function readSettings(userId: string): Promise<AISettingsResponse> {
  const now = new Date();
  const config = await prisma.aIConfiguration.findUnique({
    where: { userId },
    select: CONFIGURATION_STATE,
  });
  const [{ pauses, rows: pauseRows }, usage, waitingEmails, needsOk, saved] = await Promise.all([
    setupPauses(userId, config, now),
    prisma.aIUsageDay.findUnique({ where: { userId_day: { userId, day: utcDay(now) } } }),
    prisma.email.count({ where: { userId, processingState: 'PENDING' } }),
    needsYourOk(userId, now),
    prisma.aISavedProvider.findMany({
      where: { userId },
      select: SAVED_PROVIDER_STATE,
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  const provider = config ? AI_CATALOG.find((p) => p.id === config.provider) : undefined;
  const models = config ? shownModels(provider, config) : null;
  const access = shownAccess(config, pauses, usage?.calls ?? 0, now);
  const consentCurrent = provider?.disclosure.version === config?.consentDisclosure;
  const active: AIConnection[] = config
    ? [
        {
          provider: config.provider,
          active: true,
          state: access.state,
          reason: access.reason,
          modelId: access.modelId,
          failure: access.failure,
          models,
          verified: access.verified,
          lastCheckedAt: access.lastCheckedAt,
          consentCurrent,
        },
      ]
    : [];
  return {
    configured: !!config,
    provider: config?.provider ?? null,
    offeredProviders: AI_CATALOG.filter(isOffered).map((p) => p.id),
    models,
    access,
    lastFailure: latestFailure([
      readFailure(config?.accessFailure),
      ...pauseRows.map((row) => readFailure(row.lastFailure)),
    ]),
    usageToday: usageToday(usage, now),
    safetyLimit: {
      callsPerDay: dailyCallLimit(config?.provider),
      resetsAt: nextUtcMidnight(now).toISOString(),
    },
    waitingEmails,
    needsYourOk: needsOk,
    consent: config && {
      disclosure: config.consentDisclosure,
      consentedAt: config.consentedAt.toISOString(),
      current: consentCurrent,
    },
    connections: [...active, ...saved.map(savedConnection)],
  };
}

/** Career Companion's own counts for today. */
const usageToday = (
  usage: { calls: number; inputTokens: number; outputTokens: number } | null,
  now: Date,
): AISettingsResponse['usageToday'] => ({
  day: utcDay(now),
  calls: usage?.calls ?? 0,
  inputTokens: usage?.inputTokens ?? 0,
  outputTokens: usage?.outputTokens ?? 0,
});

/** Counts one key check against the user's daily cap. */
export async function reserveVerification(userId: string, now: Date) {
  const day = utcDay(now);
  await ensureUsageDay(prisma, userId, day);
  const reserved = await prisma.aIUsageDay.updateMany({
    where: { userId, day, verifications: { lt: MAX_DAILY_VERIFICATIONS } },
    data: { verifications: { increment: 1 } },
  });
  if (!reserved.count)
    throw new AppError(
      429,
      'AI_VERIFY_RATE_LIMITED',
      'Too many key checks today. Try again tomorrow.',
      {
        resetsAt: nextUtcMidnight(now).toISOString(),
      },
    );
}

export function chosenModel(
  provider: CatalogProvider,
  role: AIRole,
  requested: string | null | undefined,
  current: string | null,
): string | null {
  if (requested === undefined) return current;
  if (requested === null) return null;
  if (!modelsForRole(provider, role).some((m) => m.id === requested))
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `That ${role} model is not offered for this provider.`,
    );
  return requested;
}

export const rejectedError = (result: Extract<VerifyResult, { result: 'REJECTED' }>) =>
  new AppError(
    422,
    'AI_ACCESS_REJECTED',
    'The provider refused this key or model. Nothing was saved.',
    {
      reason: result.kind,
      modelId: result.modelId ?? null,
    },
  );

/**
 * Rejects a save request that cannot be verified or saved as sent. `connecting`: the provider has
 * no saved key yet, so the request needs a key and the current data-use consent.
 */
export function checkSaveRequest(
  request: Pick<SaveRequest, 'consentDisclosure'>,
  provider: CatalogProvider,
  newKey: string,
  connecting: boolean,
): void {
  if (newKey && !API_KEY.test(newKey))
    throw new AppError(400, 'VALIDATION_ERROR', 'The API key format is not valid.');
  if (!newKey && connecting)
    throw new AppError(400, 'VALIDATION_ERROR', 'An API key is required for this provider.');
  if (connecting && request.consentDisclosure !== provider.disclosure.version)
    throw new AppError(400, 'VALIDATION_ERROR', 'Confirm the data-use summary for this provider.');
  if (
    request.consentDisclosure !== undefined &&
    request.consentDisclosure !== provider.disclosure.version
  )
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'The data-use summary has changed. Review it again.',
    );
}

/** Opens the saved key for a save that keeps it. A key that cannot be read must be entered again. */
export function savedKey(userId: string, saved: { encryptedApiKey: string | null } | null): string {
  // checkSaveRequest already requires a new key when there is no saved setup to keep.
  if (!saved) throw new Error('No saved AI key to keep');
  try {
    return openApiKey(userId, saved.encryptedApiKey);
  } catch (err) {
    if (!(err instanceof CredentialUnreadableError)) throw err;
    throw new AppError(400, 'AI_KEY_REQUIRED', 'Enter your API key again.');
  }
}

/**
 * The access state a save leaves. A new key starts from a clean state. For an unchanged key, a
 * definitive success clears problems that need the user's attention, and an inconclusive check
 * never overwrites what is known.
 */
export function accessStateAfterSave(
  keyChanged: boolean,
  verified: boolean,
  accessIssue: AIAccessIssue | null,
  now: Date,
): {
  accessIssue?: null;
  accessIssueModel?: null;
  accessFailure?: typeof Prisma.DbNull;
  verifiedAt?: Date | null;
} {
  const cleared = { accessIssue: null, accessIssueModel: null, accessFailure: Prisma.DbNull };
  if (keyChanged) return { ...cleared, verifiedAt: verified ? now : null };
  if (!verified) return {};
  if (accessIssue && NEEDS_ATTENTION_ISSUES.includes(accessIssue))
    return { ...cleared, verifiedAt: now };
  return { verifiedAt: now };
}

export const logAccessCheck = (
  userId: string,
  provider: CatalogProvider,
  on: 'save' | 'check',
  result: VerifyResult,
) =>
  logEvent('ai_access_checked', {
    userId,
    provider: provider.id,
    on,
    result: result.result,
    kind: result.result === 'REJECTED' ? result.kind : undefined,
    providerMessage: result.result === 'VERIFIED' ? undefined : result.providerMessage,
  });

/**
 * Saves the active setup: a new key or models for the active provider, or the first provider when
 * none is active (it becomes active). `connections.ts` routes every other provider elsewhere.
 */
export async function saveSettings(
  userId: string,
  request: SaveRequest,
): Promise<SaveAIProviderResponse> {
  const now = new Date();
  const provider = offeredProvider(request.provider);
  if (!provider) throw new AppError(400, 'VALIDATION_ERROR', 'That AI provider is not offered.');
  const current = await prisma.aIConfiguration.findUnique({
    where: { userId },
    select: { ...CONFIGURATION_STATE, encryptedApiKey: true },
  });
  // Another active provider is never overwritten here: `connections.ts` saves it as inactive.
  if (current && current.provider !== provider.id) throw new Error('Another provider is active');
  const firstSetup = current === null;
  const newKey = request.apiKey?.trim() ?? '';
  checkSaveRequest(request, provider, newKey, firstSetup);
  const apiKey = newKey || savedKey(userId, current);

  const fastModel = chosenModel(provider, 'fast', request.models?.fast, current?.fastModel ?? null);
  const detailedModel = chosenModel(
    provider,
    'detailed',
    request.models?.detailed,
    current?.detailedModel ?? null,
  );
  const { models } = modelsFor(provider, { fastModel, detailedModel });

  await reserveVerification(userId, now);
  const result = await createProviderClient(provider, apiKey).verifyModels([
    models.fast.id,
    models.detailed.id,
  ]);
  logAccessCheck(userId, provider, 'save', result);
  if (result.result === 'REJECTED') throw rejectedError(result);

  const keyChanged = firstSetup || !!newKey;
  const verified = result.result === 'VERIFIED';
  const state = accessStateAfterSave(keyChanged, verified, current?.accessIssue ?? null, now);
  const consent = request.consentDisclosure
    ? { consentDisclosure: request.consentDisclosure, consentedAt: now }
    : {};
  const fields = {
    provider: provider.id,
    fastModel,
    detailedModel,
    lastCheckedAt: now,
    ...(newKey ? { encryptedApiKey: sealApiKey(userId, newKey) } : {}),
  };
  if (current) {
    // Overwrites the row in place: a replaced key's ciphertext is gone from the live record.
    // A new key starts with no pause. Choosing another model ends that role's pause: a model no
    // role uses any more keeps none. A paused model the save keeps stays paused.
    await prisma.$transaction([
      prisma.aIConfiguration.update({
        where: { userId },
        data: { ...fields, ...state, ...consent, revision: { increment: 1 } },
      }),
      prisma.aIModelPause.deleteMany({
        where: keyChanged
          ? { userId }
          : { userId, model: { notIn: [models.fast.id, models.detailed.id] } },
      }),
    ]);
  } else {
    await prisma.aIConfiguration.create({
      data: {
        userId,
        ...fields,
        encryptedApiKey: sealApiKey(userId, newKey),
        // checkSaveRequest made sure a new setup confirms this exact disclosure.
        consentDisclosure: provider.disclosure.version,
        consentedAt: now,
        verifiedAt: verified ? now : null,
      },
    });
  }
  logEvent('ai_settings_saved', {
    userId,
    provider: provider.id,
    verification: result.result,
    firstSetup,
    keyChanged,
  });
  await reofferPendingEmails(userId);
  return { ...(await readSettings(userId)), ...verification(result) };
}

/** A key check's result, and why it could not decide (for example no answer in time). */
export function verification<R extends VerifyResult>(result: R) {
  const checked: VerifyResult = result;
  return {
    verification: result.result as R['result'],
    verificationFailure: checked.result === 'INCONCLUSIVE' ? (checked.failure ?? null) : null,
  };
}

export async function checkSettings(userId: string): Promise<CheckAIProviderResponse> {
  const now = new Date();
  const config = await prisma.aIConfiguration.findUnique({
    where: { userId },
    select: { ...CONFIGURATION_STATE, encryptedApiKey: true },
  });
  if (!config) throw new AppError(404, 'AI_NOT_CONFIGURED', 'AI is not set up.');
  if (isFreeAI(config.provider)) throw noFreeAIKey();
  const provider = offeredProvider(config.provider);
  if (!provider)
    throw new AppError(
      409,
      'AI_PROVIDER_UNSUPPORTED',
      'This provider is no longer offered. Choose another provider.',
    );
  const guarded = { userId, revision: config.revision };
  let apiKey: string;
  try {
    apiKey = openApiKey(userId, config.encryptedApiKey);
  } catch (err) {
    if (!(err instanceof CredentialUnreadableError)) throw err;
    logError('ai_credential_unreadable', { userId });
    await prisma.aIConfiguration.updateMany({
      where: guarded,
      data: {
        accessIssue: 'KEY_UNREADABLE',
        accessIssueModel: null,
        accessFailure: Prisma.DbNull,
        lastCheckedAt: now,
      },
    });
    return { ...(await readSettings(userId)), verification: 'REJECTED', verificationFailure: null };
  }
  await reserveVerification(userId, now);
  const { models } = modelsFor(provider, config);
  const result = await createProviderClient(provider, apiKey).verifyModels([
    models.fast.id,
    models.detailed.id,
  ]);
  logAccessCheck(userId, provider, 'check', result);
  if (result.result === 'VERIFIED') {
    // A key check proves access, not that a model's pause has passed: pauses stay as they are.
    const clears = config.accessIssue && NEEDS_ATTENTION_ISSUES.includes(config.accessIssue);
    await prisma.aIConfiguration.updateMany({
      where: guarded,
      data: {
        verifiedAt: now,
        lastCheckedAt: now,
        ...(clears
          ? { accessIssue: null, accessIssueModel: null, accessFailure: Prisma.DbNull }
          : {}),
      },
    });
    await reofferPendingEmails(userId);
  } else if (result.result === 'REJECTED') {
    await prisma.aIConfiguration.updateMany({
      where: guarded,
      data: {
        accessIssue: result.kind,
        accessIssueModel: result.modelId ?? null,
        accessFailure: result.failure ?? Prisma.DbNull,
        lastCheckedAt: now,
      },
    });
  } else {
    await prisma.aIConfiguration.updateMany({ where: guarded, data: { lastCheckedAt: now } });
  }
  return { ...(await readSettings(userId)), ...verification(result) };
}

/** Removes the configuration and its sealed key. Processed data stays. Idempotent. */
export async function removeSettings(userId: string): Promise<{ removed: true }> {
  const { count } = await prisma.aIConfiguration.deleteMany({ where: { userId } });
  if (count) logEvent('ai_settings_removed', { userId });
  return { removed: true };
}

/** 409 AI_ACCESS_UNAVAILABLE; a model's pause names the model and the failure behind it. */
export const unavailable = (err: AIAccessError, modelId: string | null) =>
  new AppError(409, 'AI_ACCESS_UNAVAILABLE', 'AI access cannot be used right now.', {
    state: stateOf(err.reason),
    reason: err.reason,
    resumesAt: iso(err.resumesAt),
    // Only a model's pause names the model; Career Companion's daily limit is for all of them.
    modelId: err.resumesAt && err.reason !== 'SAFETY_LIMIT' ? modelId : null,
    failure: err.failure,
  });

/**
 * What the sample test answers to a refusal: a pause (409), or a key, billing or model problem
 * (422). On the free AI, every refusal pauses it for everyone: never a problem of the user's key.
 */
function refusedError(
  provider: string,
  kind: RefusalKind,
  pause: { resumesAt: Date | null; failure: AIFailure; modelId: string },
): AppError {
  const { resumesAt, failure, modelId } = pause;
  if (isFreeAI(provider))
    return unavailable(new AIAccessError(freeReason(kind), resumesAt, failure), modelId);
  if (kind === 'RATE_LIMITED' || kind === 'PROVIDER_BUSY')
    return unavailable(new AIAccessError(kind, resumesAt, failure), modelId);
  return new AppError(422, 'AI_ACCESS_REJECTED', 'The provider refused this key or model.', {
    reason: kind,
    modelId: kind === 'MODEL_UNAVAILABLE' ? modelId : null,
  });
}

/**
 * Runs both capabilities on the built-in synthetic email (never the user's mail) with the saved
 * configuration, and returns the validated result. Real calls on the user's account: they count
 * toward the safety limit, and refusals update access state like any call. Nothing is persisted
 * apart from those counts and state: no ledger row, no result.
 */
export async function runSampleTest(userId: string): Promise<AISampleTestResponse> {
  const now = new Date();
  const configured = await prisma.aIConfiguration.count({ where: { userId } });
  if (!configured) throw new AppError(404, 'AI_NOT_CONFIGURED', 'AI is not set up.');
  let access: AIAccess;
  try {
    access = await resolveAIAccess(userId);
  } catch (err) {
    if (err instanceof AIAccessError) throw unavailable(err, null);
    throw err;
  }
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const call = async <T>(
    model: CatalogModel,
    invoke: () => Promise<{
      data: T;
      usage: { inputTokens: number | null; outputTokens: number | null };
    }>,
  ) => {
    try {
      await prisma.$transaction((tx) =>
        reserveUserCall(tx, { userId, provider: access.provider, model: model.id }, now),
      );
    } catch (err) {
      if (err instanceof AIAccessError) throw unavailable(err, model.id);
      throw err;
    }
    usage.calls++;
    const startedAt = new Date();
    try {
      const result = await invoke();
      await recordTokens(userId, now, result.usage);
      await noteProviderSuccess(access, model.id);
      usage.inputTokens += result.usage.inputTokens ?? 0;
      usage.outputTokens += result.usage.outputTokens ?? 0;
      return result.data;
    } catch (err) {
      const failedAt = new Date();
      const kind = err instanceof ProviderFailure ? err.kind : 'OUTCOME_UNKNOWN';
      // Which model did not answer or answered unusably, and how long the test waited.
      const failure = failureRecord(err, {
        provider: access.provider,
        model: model.id,
        startedAt,
        failedAt,
        timeoutMs: model.timeoutMs,
      });
      logEvent('ai_sample_test', {
        userId,
        provider: access.provider,
        outcome: kind,
        providerRequestId: err instanceof ProviderFailure ? err.providerRequestId : undefined,
        providerMessage: err instanceof ProviderFailure ? err.providerMessage : undefined,
        ...usage,
      });
      if (isRefusal(kind)) {
        const resumesAt = await prisma.$transaction((tx) =>
          noteProviderFailure(tx, access, kind, failedAt, {
            modelId: model.id,
            retryAfterMs: (err as ProviderFailure).retryAfterMs,
            quotaScope: (err as ProviderFailure).quotaScope,
            failure,
          }),
        );
        await afterProviderFailure(access, resumesAt);
        throw refusedError(access.provider, kind, { resumesAt, failure, modelId: model.id });
      }
      if (err instanceof ProviderFailure && err.usage) await recordTokens(userId, now, err.usage);
      throw new AppError(
        502,
        'AI_SAMPLE_FAILED',
        'The sample test did not return a usable result.',
        { failure },
      );
    }
  };

  const classification = await call(access.models.fast, () =>
    access.classifier.classifyRelevance({
      sender: SAMPLE_EMAIL.sender.slice(0, LIMITS.sender),
      subject: SAMPLE_EMAIL.subject.slice(0, LIMITS.subject),
      labels: SAMPLE_EMAIL.labels.slice(0, LIMITS.labels),
      snippet: SAMPLE_EMAIL.snippet.slice(0, LIMITS.snippet),
    }),
  );
  const extraction = await call(access.models.detailed, () =>
    access.analyzer.extractJobData(SAMPLE_EMAIL.body.slice(0, EXTRACTION_BODY_LIMIT)),
  );
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
