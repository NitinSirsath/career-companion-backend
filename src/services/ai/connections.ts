/**
 * Connected AI providers (ADR-0001 decision 5, owner 22 Oct 2026). A user may connect several
 * providers, with at most one key per provider, and exactly one is active. The active one is the
 * user's AIConfiguration and does all AI work. The others wait in AISavedProvider: only a check, a
 * key change or a model change that the user starts calls them. Nothing ever switches the active
 * provider by itself (decision 11).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { AppError } from '../../errors';
import type { CatalogProvider } from '../../contracts/aiCatalog';
import type {
  AISettingsResponse,
  CheckAIProviderResponse,
  SaveAIProviderRequest,
  SaveAIProviderResponse,
} from '../../contracts/ai';
import { NEEDS_ATTENTION_ISSUES, modelsFor, offeredProvider } from './access';
import { CredentialUnreadableError, openApiKey, sealApiKey } from './credentials';
import type { BoundModels } from './capabilities';
import { reofferPendingEmails } from './offer';
import { createProviderClient, VerifyResult } from './providers';
import {
  accessStateAfterSave,
  checkSaveRequest,
  checkSettings,
  chosenModel,
  logAccessCheck,
  readSettings,
  rejectedError,
  removeSettings,
  reserveVerification,
  saveSettings,
  savedKey,
  verification,
} from './settings';
import { logError, logEvent } from '../../utils/log';

/** Everything a setup is made of, in both tables. */
const SETUP_FIELDS = {
  provider: true,
  encryptedApiKey: true,
  fastModel: true,
  detailedModel: true,
  accessIssue: true,
  accessIssueModel: true,
  accessFailure: true,
  verifiedAt: true,
  lastCheckedAt: true,
  consentDisclosure: true,
  consentedAt: true,
} as const;

type Setup = Prisma.AISavedProviderGetPayload<{ select: typeof SETUP_FIELDS }>;

/** A setup as written to the other table when it becomes active or inactive. */
const moved = (setup: Setup) => ({
  ...setup,
  accessFailure:
    setup.accessFailure === null ? Prisma.DbNull : (setup.accessFailure as Prisma.InputJsonValue),
});

const savedWhere = (userId: string, provider: string) => ({
  userId_provider: { userId, provider },
});

const notConnected = () =>
  new AppError(404, 'AI_PROVIDER_NOT_CONNECTED', 'That AI provider is not connected.');

const unsupported = () =>
  new AppError(
    409,
    'AI_PROVIDER_UNSUPPORTED',
    'This provider is no longer offered. Choose another provider.',
  );

function offered(id: string): CatalogProvider {
  const provider = offeredProvider(id);
  if (!provider) throw new AppError(400, 'VALIDATION_ERROR', 'That AI provider is not offered.');
  return provider;
}

const activeProvider = async (userId: string) =>
  (await prisma.aIConfiguration.findUnique({ where: { userId }, select: { provider: true } }))
    ?.provider ?? null;

const savedSetup = (userId: string, provider: string) =>
  prisma.aISavedProvider.findUnique({ where: savedWhere(userId, provider), select: SETUP_FIELDS });

/** The models a save asks for: the request's choice, else what the provider has saved. */
function requestedModels(
  provider: CatalogProvider,
  requested: SaveAIProviderRequest['models'],
  saved: Setup | null,
) {
  const fastModel = chosenModel(provider, 'fast', requested?.fast, saved?.fastModel ?? null);
  const detailedModel = chosenModel(
    provider,
    'detailed',
    requested?.detailed,
    saved?.detailedModel ?? null,
  );
  return { fastModel, detailedModel, ...modelsFor(provider, { fastModel, detailedModel }) };
}

/** One key check, counted against the user's daily cap and logged. */
async function verifyKey(
  userId: string,
  provider: CatalogProvider,
  { apiKey, models }: { apiKey: string; models: BoundModels },
  on: 'save' | 'check',
): Promise<VerifyResult> {
  await reserveVerification(userId, new Date());
  const result = await createProviderClient(provider, apiKey).verifyModels([
    models.fast.id,
    models.detailed.id,
  ]);
  logAccessCheck(userId, provider, on, result);
  return result;
}

/** Verifies and saves an inactive provider: a new connection, a new key or new models. */
async function saveInactive(
  userId: string,
  provider: CatalogProvider,
  save: Omit<SaveAIProviderRequest, 'makeActive'>,
  saved: Setup | null,
) {
  const now = new Date();
  const newKey = save.apiKey?.trim() ?? '';
  checkSaveRequest(save, provider, newKey, !saved);
  const apiKey = newKey || savedKey(userId, saved);
  const { fastModel, detailedModel, models } = requestedModels(provider, save.models, saved);
  const result = await verifyKey(userId, provider, { apiKey, models }, 'save');
  if (result.result === 'REJECTED') throw rejectedError(result);

  const keyChanged = !saved || !!newKey;
  const verified = result.result === 'VERIFIED';
  const consent = save.consentDisclosure
    ? { consentDisclosure: save.consentDisclosure, consentedAt: now }
    : {};
  const fields = {
    fastModel,
    detailedModel,
    lastCheckedAt: now,
    ...accessStateAfterSave(keyChanged, verified, saved?.accessIssue ?? null, now),
    ...consent,
    ...(newKey ? { encryptedApiKey: sealApiKey(userId, newKey) } : {}),
  };
  await prisma.aISavedProvider.upsert({
    where: savedWhere(userId, provider.id),
    // checkSaveRequest made sure a new connection has a key and confirms this exact disclosure.
    create: {
      userId,
      provider: provider.id,
      encryptedApiKey: sealApiKey(userId, newKey),
      consentDisclosure: provider.disclosure.version,
      consentedAt: now,
      ...fields,
    },
    update: fields,
  });
  logEvent('ai_provider_saved', {
    userId,
    provider: provider.id,
    verification: result.result,
    connected: !saved,
    keyChanged,
  });
  return result;
}

/**
 * Connects a provider, replaces its key, or changes its models, after verifying them. The active
 * provider, and the first provider when nothing is active, go to the active setup. Any other is
 * saved as inactive and becomes active only with `makeActive`.
 */
export async function saveProvider(
  userId: string,
  providerId: string,
  request: SaveAIProviderRequest,
): Promise<SaveAIProviderResponse> {
  const provider = offered(providerId);
  const { makeActive, ...save } = request;
  const [active, saved] = await Promise.all([
    activeProvider(userId),
    savedSetup(userId, provider.id),
  ]);
  if (active === provider.id || (!active && !saved))
    return saveSettings(userId, { provider: provider.id, ...save });
  const result = await saveInactive(userId, provider, save, saved);
  const settings = makeActive
    ? await activateProvider(userId, provider.id)
    : await readSettings(userId);
  return { ...settings, ...verification(result) };
}

/**
 * Makes a connected provider the active one. The setup it replaces stays connected, as inactive,
 * with its key. It affects future work only: the revision changes, so a job started on the old
 * setup writes nothing for the new one, and pauses (which belong to the old models) end. Mails
 * waiting for AI are offered to the new one. Doing it twice changes nothing.
 */
export async function activateProvider(
  userId: string,
  providerId: string,
): Promise<AISettingsResponse> {
  const provider = offeredProvider(providerId);
  if (!provider) throw unsupported();
  const switched = await prisma.$transaction(async (tx) => {
    const active = await tx.aIConfiguration.findUnique({
      where: { userId },
      select: { ...SETUP_FIELDS, revision: true },
    });
    if (active?.provider === provider.id) return false;
    const saved = await tx.aISavedProvider.findUnique({
      where: savedWhere(userId, provider.id),
      select: SETUP_FIELDS,
    });
    if (!saved) throw notConnected();
    if (saved.accessIssue && NEEDS_ATTENTION_ISSUES.includes(saved.accessIssue))
      throw new AppError(
        409,
        'AI_PROVIDER_NOT_READY',
        'Its last check found a problem with the key. Fix the key first.',
        { reason: saved.accessIssue, modelId: saved.accessIssueModel },
      );
    await tx.aISavedProvider.delete({ where: savedWhere(userId, provider.id) });
    if (!active) {
      await tx.aIConfiguration.create({ data: { userId, ...moved(saved) } });
      return true;
    }
    const { revision, ...outgoing } = active;
    const { count } = await tx.aIConfiguration.updateMany({
      where: { userId, revision },
      data: { ...moved(saved), revision: { increment: 1 } },
    });
    if (!count)
      throw new AppError(409, 'AI_SETTINGS_CHANGED', 'Your AI settings changed. Try again.');
    await tx.aISavedProvider.create({ data: { userId, ...moved(outgoing) } });
    await tx.aIModelPause.deleteMany({ where: { userId } });
    return true;
  });
  if (switched) {
    logEvent('ai_provider_activated', { userId, provider: provider.id });
    await reofferPendingEmails(userId);
  }
  return readSettings(userId);
}

/**
 * Checks a connected provider's key and models again. For an inactive provider only its own state
 * changes; nothing else is offered to it.
 */
export async function checkProvider(
  userId: string,
  providerId: string,
): Promise<CheckAIProviderResponse> {
  if ((await activeProvider(userId)) === providerId) return checkSettings(userId);
  const saved = await savedSetup(userId, providerId);
  if (!saved) throw notConnected();
  const provider = offeredProvider(providerId);
  if (!provider) throw unsupported();
  const now = new Date();
  const update = (data: Prisma.AISavedProviderUpdateManyMutationInput) =>
    prisma.aISavedProvider.updateMany({ where: { userId, provider: provider.id }, data });
  let apiKey: string;
  try {
    apiKey = openApiKey(userId, saved.encryptedApiKey);
  } catch (err) {
    if (!(err instanceof CredentialUnreadableError)) throw err;
    logError('ai_credential_unreadable', { userId, provider: provider.id });
    await update({
      accessIssue: 'KEY_UNREADABLE',
      accessIssueModel: null,
      accessFailure: Prisma.DbNull,
      lastCheckedAt: now,
    });
    return { ...(await readSettings(userId)), verification: 'REJECTED', verificationFailure: null };
  }
  const result = await verifyKey(
    userId,
    provider,
    { apiKey, models: modelsFor(provider, saved).models },
    'check',
  );
  if (result.result === 'VERIFIED') {
    const clears = saved.accessIssue && NEEDS_ATTENTION_ISSUES.includes(saved.accessIssue);
    await update({
      verifiedAt: now,
      lastCheckedAt: now,
      ...(clears
        ? { accessIssue: null, accessIssueModel: null, accessFailure: Prisma.DbNull }
        : {}),
    });
  } else if (result.result === 'REJECTED') {
    await update({
      accessIssue: result.kind,
      accessIssueModel: result.modelId ?? null,
      accessFailure: result.failure ?? Prisma.DbNull,
      lastCheckedAt: now,
    });
  } else {
    await update({ lastCheckedAt: now });
  }
  return { ...(await readSettings(userId)), ...verification(result) };
}

/**
 * Removes a provider's key. Removing the active provider makes `then` active (a connected provider)
 * or leaves no provider active (`none`, or no `then`): new mails then wait. Processed data stays.
 * Removing a provider that is not connected changes nothing.
 */
export async function removeProvider(
  userId: string,
  providerId: string,
  then?: string,
): Promise<AISettingsResponse> {
  if ((await activeProvider(userId)) !== providerId) {
    const { count } = await prisma.aISavedProvider.deleteMany({
      where: { userId, provider: providerId },
    });
    if (count) logEvent('ai_provider_removed', { userId, provider: providerId, active: false });
    return readSettings(userId);
  }
  if (then && then !== 'none') {
    if (then === providerId)
      throw new AppError(400, 'VALIDATION_ERROR', 'Choose another provider to make active.');
    // The removed provider moves to the inactive ones first, so its key is gone only once the
    // next one is active.
    await activateProvider(userId, then);
    await prisma.aISavedProvider.deleteMany({ where: { userId, provider: providerId } });
  } else {
    await removeSettings(userId);
  }
  logEvent('ai_provider_removed', {
    userId,
    provider: providerId,
    active: true,
    then: then ?? 'none',
  });
  return readSettings(userId);
}
