import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIModelPause } from '@prisma/client';
import { prisma } from '../db/prisma';
import { getCatalogProvider } from '../contracts/aiCatalog';
import {
  ConfigurationState,
  blockingPause,
  deriveAccess,
  getAccessState,
  resolveAIAccess,
  runningPauses,
  withPause,
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
  revision: 0,
};
const FAST = 'gemini-3.5-flash-lite';
const DETAILED = 'gemini-3.8-flash';
const pauseRow = (model: string, overrides: Partial<AIModelPause> = {}): AIModelPause => ({
  userId: 'user-1',
  model,
  reason: 'PROVIDER_BUSY',
  resumesAt: later,
  consecutiveFailures: 1,
  testEmailId: null,
  testStartedAt: null,
  testResult: null,
  ...overrides,
});

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
      'safety limit',
      base,
      10,
      { state: 'LIMITED', reason: 'SAFETY_LIMIT', resumesAt: nextUtcMidnight(now) },
    ],
    [
      'needs attention outranks the limit',
      { ...base, accessIssue: 'KEY_REJECTED' },
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

describe("each model's own pause", () => {
  beforeEach(() => {
    process.env.AI_USER_DAILY_CALL_LIMIT = '10';
  });

  it('applies a running pause only to the roles whose model it is', () => {
    const rows = [pauseRow(DETAILED), pauseRow('gemini-2.5-flash')];
    const pauses = runningPauses(base, rows, now);
    expect(pauses).toEqual([
      {
        model: DETAILED,
        roles: ['detailed'],
        reason: 'PROVIDER_BUSY',
        resumesAt: later,
        testEmailId: null,
      },
    ]);
    expect(blockingPause(pauses, ['fast'])).toBeNull();
    expect(blockingPause(pauses, ['detailed'])).toMatchObject({ model: DETAILED });
    // One model in both roles pauses both.
    const same = { ...base, fastModel: DETAILED };
    expect(runningPauses(same, rows, now)[0].roles).toEqual(['fast', 'detailed']);
  });

  it('ignores a pause that has passed, and names the test mail only while it runs', () => {
    expect(runningPauses(base, [pauseRow(DETAILED, { resumesAt: now })], now)).toEqual([]);
    const testing = pauseRow(DETAILED, { testEmailId: 'mail-1', testStartedAt: now });
    expect(runningPauses(base, [testing], now)[0].testEmailId).toBe('mail-1');
    const answered = { ...testing, testResult: 'PROVIDER_BUSY' };
    expect(runningPauses(base, [answered], now)[0].testEmailId).toBeNull();
  });

  it('shows the pause that ends last, after the user’s own problems and before the limit', () => {
    const last = new Date(later.getTime() + 60_000);
    const pauses = runningPauses(
      base,
      [pauseRow(FAST, { reason: 'RATE_LIMITED' }), pauseRow(DETAILED, { resumesAt: last })],
      now,
    );
    const pause = blockingPause(pauses, ['fast', 'detailed']);
    expect(withPause(deriveAccess(base, 0, now), pause)).toMatchObject({
      state: 'LIMITED',
      reason: 'PROVIDER_BUSY',
      resumesAt: last,
    });
    expect(withPause(deriveAccess(base, 10, now), pause)).toMatchObject({
      reason: 'PROVIDER_BUSY',
    });
    expect(
      withPause(deriveAccess({ ...base, accessIssue: 'KEY_REJECTED' }, 0, now), pause),
    ).toMatchObject({ state: 'NEEDS_ATTENTION', reason: 'KEY_REJECTED' });
    expect(withPause(deriveAccess(base, 0, now), null)).toMatchObject({ state: 'READY' });
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
      models: { fast: { id: 'gemini-3.5-flash-lite' }, detailed: { id: 'gemini-2.5-flash' } },
    });
  });

  it('falls back to the recommended model when a selection left the catalog', async () => {
    await configureAI(userId, { fastModel: 'gemini-1.0-retired' });
    expect((await resolveAIAccess(userId)).models.fast.id).toBe('gemini-3.5-flash-lite');
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

  it("resolves access while one model is paused: the pause stops only that model's calls", async () => {
    await configureAI(userId);
    const resumesAt = new Date(Date.now() + 60_000);
    await prisma.aIModelPause.create({
      data: { userId, model: DETAILED, reason: 'PROVIDER_BUSY', resumesAt },
    });
    expect(await reason(resolveAIAccess(userId))).toBe('READY');
    expect(await getAccessState(userId)).toMatchObject({
      state: 'READY',
      pauses: [{ model: DETAILED, roles: ['detailed'], resumesAt }],
    });
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
