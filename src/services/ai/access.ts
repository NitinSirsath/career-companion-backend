/**
 * AI access resolution (architecture §6): the single place that answers "can this user's AI work
 * run now, and with what?". It reads by the userId of the job or session only; keys never travel
 * through the queue. There is no Career Companion key and no fallback to another provider.
 */
import {
  AI_ROLES,
  AIRole, AIAccessIssue, AIModelPause } from '@prisma/client';
import { prisma } from '../../db/prisma';
import {
  CatalogProvider,
  ModelSource,
  getCatalogProvider,
  resolveModel,
} from '../../contracts/aiCatalog';
import { AICapabilities, BoundModels, bindCapabilities } from './capabilities';
import { CredentialUnreadableError, openApiKey } from './credentials';
import { AIAccessError, AccessReason } from './errors';
import { createProviderClient } from './providers';
import { nextUtcMidnight, userDailyCallLimit, utcDay } from './usage';
import { isProduction } from '../../utils/config';
import { logError } from '../../utils/log';

export type AccessState = 'NOT_SET_UP' | 'READY' | 'NEEDS_ATTENTION' | 'LIMITED';

export interface AccessStatus {
  state: AccessState;
  reason: AccessReason | null;
  /** The model a MODEL_UNAVAILABLE problem refers to. */
  modelId: string | null;
  resumesAt: Date | null;
}

/** Configuration fields that describe access. The sealed key is deliberately not among them. */
export const CONFIGURATION_STATE = {
  provider: true,
  fastModel: true,
  detailedModel: true,
  accessIssue: true,
  accessIssueModel: true,
  verifiedAt: true,
  lastCheckedAt: true,
  consentDisclosure: true,
  consentedAt: true,
  revision: true,
} as const;

export interface ConfigurationState {
  provider: string;
  fastModel: string | null;
  detailedModel: string | null;
  accessIssue: AIAccessIssue | null;
  accessIssueModel: string | null;
  revision: number;
}

/** A running pause of a model the user's setup uses now (key, billing and limits are per user). */
export interface ModelPause {
  model: string;
  /** The roles that use the model now. */
  roles: AIRole[];
  reason: AIAccessIssue;
  resumesAt: Date;
  /** The test mail of "Read waiting mails now" while it waits for the model's answer. */
  testEmailId: string | null;
}

/** The user's own access state, and the running pauses of the models the setup uses now. */
export interface UserAccess extends AccessStatus {
  pauses: ModelPause[];
}

/** Stored problems that only the user can fix; AI work waits until they do. */
export const NEEDS_ATTENTION_ISSUES: readonly AIAccessIssue[] = [
  'KEY_REJECTED',
  'ACCOUNT_OR_BILLING',
  'MODEL_UNAVAILABLE',
  'KEY_UNREADABLE',
];

/** Hidden providers are built and evaluated outside production, never offered in it. */
export const isOffered = (provider: CatalogProvider) =>
  provider.status === 'supported' || !isProduction();

export function offeredProvider(id: string): CatalogProvider | undefined {
  const provider = getCatalogProvider(id);
  return provider && isOffered(provider) ? provider : undefined;
}

/** The state an access reason belongs to. */
export function stateOf(reason: AccessReason): AccessState {
  if (reason === 'NOT_SET_UP') return 'NOT_SET_UP';
  return [
    'RATE_LIMITED',
    'PROVIDER_BUSY',
    'PROVIDER_UNAVAILABLE',
    'SAFETY_LIMIT',
    'PAUSED',
  ].includes(reason)
    ? 'LIMITED'
    : 'NEEDS_ATTENTION';
}

/**
 * The user's own access state from stored facts, in the plan §3.7 precedence. A model's pause is
 * not part of it: it stops only the work on that model (see `withPause`). Pure.
 */
export function deriveAccess(
  config: ConfigurationState | null,
  callsToday: number,
  now: Date,
): AccessStatus {
  const status = (
    state: AccessState,
    reason: AccessReason | null,
    resumesAt: Date | null = null,
    modelId: string | null = null,
  ): AccessStatus => ({ state, reason, resumesAt, modelId });
  const limit = userDailyCallLimit();
  if (limit === 0) return status('LIMITED', 'PAUSED');
  if (!config) return status('NOT_SET_UP', 'NOT_SET_UP');
  if (!offeredProvider(config.provider)) return status('NEEDS_ATTENTION', 'PROVIDER_UNSUPPORTED');
  if (config.accessIssue && NEEDS_ATTENTION_ISSUES.includes(config.accessIssue))
    return status('NEEDS_ATTENTION', config.accessIssue, null, config.accessIssueModel);
  if (callsToday >= limit) return status('LIMITED', 'SAFETY_LIMIT', nextUtcMidnight(now));
  return status('READY', null);
}

/** The running pauses of the models the configuration uses now, with the roles that use them. */
export function runningPauses(
  config: Pick<ConfigurationState, 'provider' | 'fastModel' | 'detailedModel'> | null,
  rows: AIModelPause[],
  now: Date,
): ModelPause[] {
  const provider = config && getCatalogProvider(config.provider);
  if (!provider) return [];
  const { models } = modelsFor(provider, config);
  return rows.flatMap(({ model, reason, resumesAt, testEmailId, testResult }) => {
    const roles = AI_ROLES.filter((role) => models[role].id === model);
    if (!roles.length || !resumesAt || resumesAt <= now) return [];
    return [
      { model, roles, reason, resumesAt, testEmailId: testResult === null ? testEmailId : null },
    ];
  });
}

/** Of the pauses on models these roles use, the one that ends last. */
export function blockingPause(
  pauses: readonly ModelPause[],
  roles: readonly AIRole[],
): ModelPause | null {
  return pauses
    .filter((pause) => pause.roles.some((role) => roles.includes(role)))
    .reduce<ModelPause | null>(
      (last, pause) => (last && last.resumesAt >= pause.resumesAt ? last : pause),
      null,
    );
}

/**
 * The state for work that needs a paused model: the user's own problems come first, then the
 * pause, then Career Companion's daily limit (the plan §3.7 precedence).
 */
export function withPause(access: AccessStatus, pause: ModelPause | null): AccessStatus {
  if (!pause || (access.state !== 'READY' && access.reason !== 'SAFETY_LIMIT')) return access;
  return { state: 'LIMITED', reason: pause.reason, modelId: null, resumesAt: pause.resumesAt };
}

export async function callsToday(userId: string, now: Date): Promise<number> {
  const usage = await prisma.aIUsageDay.findUnique({
    where: { userId_day: { userId, day: utcDay(now) } },
    select: { calls: true },
  });
  return usage?.calls ?? 0;
}

/** Access state without decrypting anything. Used by the status API and the waiting re-offer. */
export async function getAccessState(userId: string): Promise<UserAccess> {
  const now = new Date();
  const [config, pauses] = await Promise.all([
    prisma.aIConfiguration.findUnique({ where: { userId }, select: CONFIGURATION_STATE }),
    prisma.aIModelPause.findMany({ where: { userId } }),
  ]);
  return {
    ...deriveAccess(config, await callsToday(userId, now), now),
    pauses: runningPauses(config, pauses, now),
  };
}

export function modelsFor(
  provider: CatalogProvider,
  config: Pick<ConfigurationState, 'fastModel' | 'detailedModel'>,
): { models: BoundModels; sources: Record<keyof BoundModels, ModelSource> } {
  const fast = resolveModel(provider, 'fast', config.fastModel);
  const detailed = resolveModel(provider, 'detailed', config.detailedModel);
  return {
    models: { fast: fast.model, detailed: detailed.model },
    sources: { fast: fast.source, detailed: detailed.source },
  };
}

export interface AIAccess extends AICapabilities {
  userId: string;
  provider: string;
  models: BoundModels;
  /** The saved configuration this access came from; job-side state writes are guarded by it. */
  revision: number;
}

/**
 * Resolves the user's own AI access for one job (decrypting the key in memory) or throws
 * AIAccessError with the reason. Runs before any ledger claim, so waiting uses no attempt or call.
 * A model's pause is checked when its call is claimed (`reserveUserCall`).
 */
export async function resolveAIAccess(userId: string): Promise<AIAccess> {
  const now = new Date();
  const config = await prisma.aIConfiguration.findUnique({
    where: { userId },
    select: { ...CONFIGURATION_STATE, encryptedApiKey: true },
  });
  const status = deriveAccess(config, await callsToday(userId, now), now);
  if (status.state !== 'READY' || !config)
    throw new AIAccessError(status.reason ?? 'NOT_SET_UP', status.resumesAt);
  const provider = offeredProvider(config.provider)!;
  let apiKey: string;
  try {
    apiKey = openApiKey(userId, config.encryptedApiKey);
  } catch (err) {
    if (!(err instanceof CredentialUnreadableError)) throw err;
    // An operator problem (lost or wrong encryption key) the user can repair by re-entering the key.
    logError('ai_credential_unreadable', { userId });
    await prisma.aIConfiguration.updateMany({
      where: { userId, revision: config.revision },
      data: { accessIssue: 'KEY_UNREADABLE', accessIssueModel: null },
    });
    throw new AIAccessError('KEY_UNREADABLE');
  }
  const { models } = modelsFor(provider, config);
  return {
    userId,
    provider: provider.id,
    models,
    revision: config.revision,
    ...bindCapabilities(createProviderClient(provider, apiKey), models),
  };
}
