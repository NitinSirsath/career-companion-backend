import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db/prisma';
import { getCatalogProvider } from '../contracts/aiCatalog';
import {
  ConfigurationState,
  deriveAccess,
  getAccessState,
  resolveAIAccess,
} from '../services/ai/access';
import { sealApiKey } from '../services/ai/credentials';
import { AIAccessError } from '../services/ai/errors';
import { createProviderClient } from '../services/ai/providers';
import { nextUtcMidnight, utcDay } from '../services/ai/usage';
import { FIXTURE_KEY, configureAI } from './helpers/aiAccess';
import { fakeProviderClient } from './helpers/fakeProviderClient';

vi.mock('../services/ai/providers', () => ({ createProviderClient: vi.fn() }));

const now = new Date('2026-10-02T12:00:00Z');
const later = new Date('2026-10-02T12:05:00Z');
const base: ConfigurationState = {
  provider: 'gemini',
  fastModel: null,
  detailedModel: null,
  accessIssue: null,
  accessIssueModel: null,
  cooldownUntil: null,
  revision: 0,
};

describe('access state precedence (plan §3.7)', () => {
  beforeEach(() => {
    process.env.AI_USER_DAILY_CALL_LIMIT = '10';
  });

  it.each([
    ['ready', base, 0, { state: 'READY', reason: null }],
    ['not set up', null, 0, { state: 'NOT_SET_UP', reason: 'NOT_SET_UP' }],
    [
      'unknown provider',
      { ...base, provider: 'custom' },
      0,
      { state: 'NEEDS_ATTENTION', reason: 'PROVIDER_UNSUPPORTED' },
    ],
    [
      'key rejected',
      { ...base, accessIssue: 'KEY_REJECTED' },
      0,
      { state: 'NEEDS_ATTENTION', reason: 'KEY_REJECTED' },
    ],
    [
      'unreadable key',
      { ...base, accessIssue: 'KEY_UNREADABLE' },
      0,
      { state: 'NEEDS_ATTENTION', reason: 'KEY_UNREADABLE' },
    ],
    [
      'model unavailable names the model',
      { ...base, accessIssue: 'MODEL_UNAVAILABLE', accessIssueModel: 'gemini-2.5-flash' },
      0,
      { state: 'NEEDS_ATTENTION', reason: 'MODEL_UNAVAILABLE', modelId: 'gemini-2.5-flash' },
    ],
    [
      'rate limited',
      { ...base, accessIssue: 'RATE_LIMITED', cooldownUntil: later },
      0,
      { state: 'LIMITED', reason: 'RATE_LIMITED', resumesAt: later },
    ],
    [
      'provider unavailable',
      { ...base, accessIssue: 'PROVIDER_UNAVAILABLE', cooldownUntil: later },
      0,
      { state: 'LIMITED', reason: 'PROVIDER_UNAVAILABLE' },
    ],
    [
      'passed cooldown',
      { ...base, accessIssue: 'RATE_LIMITED', cooldownUntil: now },
      0,
      { state: 'READY' },
    ],
    [
      'safety limit',
      base,
      10,
      { state: 'LIMITED', reason: 'SAFETY_LIMIT', resumesAt: nextUtcMidnight(now) },
    ],
    [
      'needs attention outranks a cooldown and the limit',
      { ...base, accessIssue: 'KEY_REJECTED', cooldownUntil: later },
      10,
      { state: 'NEEDS_ATTENTION' },
    ],
  ] as const)('%s', (_label, config, calls, expected) => {
    expect(deriveAccess(config as ConfigurationState | null, calls, now)).toMatchObject(expected);
  });

  it('pauses everyone when the operator sets the limit to 0', () => {
    process.env.AI_USER_DAILY_CALL_LIMIT = '0';
    expect(deriveAccess(base, 0, now)).toMatchObject({ state: 'LIMITED', reason: 'PAUSED' });
    expect(deriveAccess(null, 0, now)).toMatchObject({ reason: 'PAUSED' });
  });

  it('never offers a hidden provider in production', () => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(getCatalogProvider('gemini')!.status).toBe('hidden');
      expect(deriveAccess(base, 0, now)).toMatchObject({
        state: 'NEEDS_ATTENTION',
        reason: 'PROVIDER_UNSUPPORTED',
      });
    } finally {
      process.env.NODE_ENV = env;
    }
  });
});

describe('resolving a user’s own AI access', () => {
  let userId: string;
  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { email: { endsWith: '@access.test' } } });
    userId = (await prisma.user.create({ data: { email: 'owner@access.test' } })).id;
  });
  beforeEach(async () => {
    process.env.AI_USER_DAILY_CALL_LIMIT = '100';
    vi.mocked(createProviderClient).mockReset().mockReturnValue(fakeProviderClient({}));
    await prisma.aIConfiguration.deleteMany({ where: { userId } });
    await prisma.aIUsageDay.deleteMany({ where: { userId } });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { endsWith: '@access.test' } } });
  });

  const reason = (pending: Promise<unknown>) =>
    pending.then(
      () => 'READY',
      (err: AIAccessError) => (err instanceof AIAccessError ? err.reason : err),
    );

  it('waits when the user has not set up AI (there is no Career Companion key)', async () => {
    expect(await reason(resolveAIAccess(userId))).toBe('NOT_SET_UP');
    expect(createProviderClient).not.toHaveBeenCalled();
  });

  it("builds the client from the user's decrypted key, the catalog endpoint and resolved models", async () => {
    await configureAI(userId, { detailedModel: 'gemini-2.5-flash', revision: 4 });
    const access = await resolveAIAccess(userId);
    expect(createProviderClient).toHaveBeenCalledWith(getCatalogProvider('gemini'), FIXTURE_KEY);
    expect(access).toMatchObject({
      userId,
      provider: 'gemini',
      revision: 4,
      models: { fast: { id: 'gemini-2.5-flash-lite' }, detailed: { id: 'gemini-2.5-flash' } },
    });
  });

  it('falls back to the recommended model when a selection left the catalog', async () => {
    await configureAI(userId, { fastModel: 'gemini-1.0-retired' });
    expect((await resolveAIAccess(userId)).models.fast.id).toBe('gemini-2.5-flash-lite');
  });

  it('marks an unreadable key as needing attention and logs no key material', async () => {
    const other = (await prisma.user.create({ data: { email: 'other@access.test' } })).id;
    await configureAI(userId, { encryptedApiKey: sealApiKey(other, FIXTURE_KEY) }); // wrong owner
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await reason(resolveAIAccess(userId))).toBe('KEY_UNREADABLE');
    expect(
      (await prisma.aIConfiguration.findUniqueOrThrow({ where: { userId } })).accessIssue,
    ).toBe('KEY_UNREADABLE');
    expect(JSON.stringify(log.mock.calls)).not.toContain(FIXTURE_KEY);
    expect(createProviderClient).not.toHaveBeenCalled();
  });

  it('reports state without decrypting the key', async () => {
    await configureAI(userId, { encryptedApiKey: 'v1:not:decryptable' });
    expect(await getAccessState(userId)).toMatchObject({ state: 'READY' });
    await prisma.aIUsageDay.create({ data: { userId, day: utcDay(new Date()), calls: 100 } });
    expect(await getAccessState(userId)).toMatchObject({
      state: 'LIMITED',
      reason: 'SAFETY_LIMIT',
    });
  });
});
