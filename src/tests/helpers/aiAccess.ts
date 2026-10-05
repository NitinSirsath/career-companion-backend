import { vi } from 'vitest';
import { prisma } from '../../db/prisma';
import { getCatalogProvider, recommendedModel } from '../../contracts/aiCatalog';
import type { AIAccess } from '../../services/ai/access';
import { sealApiKey } from '../../services/ai/credentials';

export const FIXTURE_KEY = 'fixture-ai-key-never-sent';

/** Saves a user's AI configuration the way the settings API does (sealed key, consent). */
export function configureAI(userId: string, overrides: Record<string, unknown> = {}) {
  const data = {
    provider: 'gemini',
    encryptedApiKey: sealApiKey(userId, FIXTURE_KEY),
    consentDisclosure: 'gemini-draft-2026-10',
    consentedAt: new Date(),
    ...overrides,
  };
  return prisma.aIConfiguration.upsert({ where: { userId }, create: { userId, ...data }, update: data });
}

/** Resolved access for ledger tests; the test supplies the provider call itself. */
export function fakeAccess(userId: string, revision = 0): AIAccess {
  const gemini = getCatalogProvider('gemini')!;
  return {
    userId,
    provider: 'gemini',
    models: { fast: recommendedModel(gemini, 'fast'), detailed: recommendedModel(gemini, 'detailed') },
    revision,
    classifier: { classifyRelevance: vi.fn(), classifyRelevanceBatch: vi.fn() },
    analyzer: { extractJobData: vi.fn() },
  };
}
