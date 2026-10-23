/**
 * How connected providers look in the settings response. The active one is described by the
 * access state; an inactive one only by its own last check and the catalog.
 */
import { Prisma } from '@prisma/client';
import { CatalogProvider, getCatalogProvider } from '../../contracts/aiCatalog';
import type { AIConnection, AISettingsResponse } from '../../contracts/ai';
import { NEEDS_ATTENTION_ISSUES, modelsFor, offeredProvider } from './access';
import { readFailure } from './failures';

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);

/** Fields of a connected, inactive provider that describe it. The sealed key is not among them. */
export const SAVED_PROVIDER_STATE = {
  provider: true,
  fastModel: true,
  detailedModel: true,
  accessIssue: true,
  accessIssueModel: true,
  accessFailure: true,
  verifiedAt: true,
  lastCheckedAt: true,
  consentDisclosure: true,
} as const;

type SavedProviderState = Prisma.AISavedProviderGetPayload<{ select: typeof SAVED_PROVIDER_STATE }>;

export function shownModels(
  provider: CatalogProvider | undefined,
  config: { fastModel: string | null; detailedModel: string | null },
): AISettingsResponse['models'] {
  if (!provider) return null;
  const { models, sources } = modelsFor(provider, config);
  return {
    fast: { id: models.fast.id, source: sources.fast },
    detailed: { id: models.detailed.id, source: sources.detailed },
  };
}

/**
 * A connected provider that is not active. It does no AI work, so only its own last check and the
 * catalog decide its state: a key, billing or model problem, or a provider no longer offered.
 */
export function savedConnection(row: SavedProviderState): AIConnection {
  const provider = getCatalogProvider(row.provider);
  const issue =
    row.accessIssue && NEEDS_ATTENTION_ISSUES.includes(row.accessIssue) ? row.accessIssue : null;
  const reason = offeredProvider(row.provider) ? issue : 'PROVIDER_UNSUPPORTED';
  return {
    provider: row.provider,
    active: false,
    state: reason ? 'NEEDS_ATTENTION' : 'READY',
    reason,
    modelId: reason && reason === issue ? row.accessIssueModel : null,
    failure: reason && reason === issue ? readFailure(row.accessFailure) : null,
    models: shownModels(provider, row),
    verified: !!row.verifiedAt,
    lastCheckedAt: iso(row.lastCheckedAt),
    consentCurrent: provider?.disclosure.version === row.consentDisclosure,
  };
}
