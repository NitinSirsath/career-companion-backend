import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { openApiKey, sealApiKey } from '../services/ai/credentials';
import { createProviderClient, VerifyResult } from '../services/ai/providers';
import { utcDay } from '../services/ai/usage';
import { reofferPendingEmails } from '../services/gmailSync';
import { configureAI } from './helpers/aiAccess';
import { JobExtractionSchema } from '../services/ai/contracts';
import { ProviderFailure } from '../services/ai/errors';
import { fakeProviderClient } from './helpers/fakeProviderClient';

vi.mock('../services/ai/providers', () => ({ createProviderClient: vi.fn() }));
const send = vi.fn(async () => 'job-id');
vi.mock('../services/queue', () => ({
  getQueue: vi.fn(async () => ({ send })),
  stopQueue: vi.fn(),
}));

const OWNER = 'owner@ai-settings.test';
const OTHER = 'other@ai-settings.test';
const KEY = 'AIza-test-SENTINEL-0123456789abcdef';
const DISCLOSURE = 'gemini-draft-2026-10';
let userId: string;

const as = (email: string) => ({ 'X-Development-User': email });
const get = (email = OWNER) => request(app).get('/api/ai/settings').set(as(email));
const put = (body: object, email = OWNER) =>
  request(app).put('/api/ai/settings').set(as(email)).send(body);
const check = () => request(app).post('/api/ai/settings/check').set(as(OWNER)).send({});
const config = () => prisma.aIConfiguration.findUnique({ where: { userId } });

let verifyResult: VerifyResult;
let client: ReturnType<typeof fakeProviderClient>;

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: '@ai-settings.test' } } });
  userId = (await prisma.user.create({ data: { email: OWNER } })).id;
  await prisma.user.create({ data: { email: OTHER } });
});
beforeEach(async () => {
  delete process.env.AI_USER_DAILY_CALL_LIMIT;
  verifyResult = { result: 'VERIFIED' };
  client = fakeProviderClient({});
  client.verifyModels.mockImplementation(async () => verifyResult);
  vi.mocked(createProviderClient).mockReset().mockReturnValue(client);
  send.mockClear();
  await prisma.aIConfiguration.deleteMany({ where: { userId } });
  await prisma.aIUsageDay.deleteMany({ where: { userId } });
  await prisma.email.deleteMany({ where: { userId } });
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: '@ai-settings.test' } } });
});

describe('AI settings API: authentication and reading', () => {
  it.each([
    ['get', '/api/ai/settings'],
    ['put', '/api/ai/settings'],
    ['post', '/api/ai/settings/check'],
    ['delete', '/api/ai/settings'],
  ] as const)('requires a session for %s %s', async (method, path) => {
    const res = await request(app)[method](path).send({});
    expect(res.status).toBe(401);
  });

  it('reports a user without AI as not set up, with the waiting count and safety limit', async () => {
    await prisma.email.create({ data: { userId, gmailMessageId: 'waiting-1' } });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: false,
      provider: null,
      offeredProviders: ['gemini', 'openai', 'anthropic'],
      models: null,
      access: { state: 'NOT_SET_UP', reason: 'NOT_SET_UP', verified: false },
      usageToday: { day: utcDay(new Date()), calls: 0 },
      safetyLimit: { callsPerDay: 500 },
      waitingEmails: 1,
      consent: null,
    });
  });
});

describe('saving verifies first and stores a write-only key', () => {
  const create = { provider: 'gemini', apiKey: `  ${KEY}  `, consentDisclosure: DISCLOSURE };

  it('saves a verified key sealed for this user, records consent and resumes waiting mail newest first', async () => {
    const older = await prisma.email.create({
      data: { userId, gmailMessageId: 'old', receivedAt: new Date('2026-09-01') },
    });
    const newer = await prisma.email.create({
      data: { userId, gmailMessageId: 'new', receivedAt: new Date('2026-10-01') },
    });
    const res = await put(create);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      verification: 'VERIFIED',
      configured: true,
      provider: 'gemini',
      models: {
        fast: { id: 'gemini-2.5-flash-lite', source: 'RECOMMENDED' },
        detailed: { id: 'gemini-2.5-flash', source: 'RECOMMENDED' },
      },
      access: { state: 'READY', verified: true },
      consent: { disclosure: DISCLOSURE, current: true },
    });
    expect(JSON.stringify(res.body)).not.toContain('SENTINEL');
    const saved = (await config())!;
    expect(saved.encryptedApiKey).not.toContain('SENTINEL');
    expect(openApiKey(userId, saved.encryptedApiKey)).toBe(KEY); // trimmed
    expect(saved).toMatchObject({ consentDisclosure: DISCLOSURE, accessIssue: null });
    expect(client.verifyModels).toHaveBeenCalledWith(['gemini-2.5-flash-lite', 'gemini-2.5-flash']);
    expect(send.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { userId, emailId: newer.id },
      { userId, emailId: older.id },
    ]);
  });

  it('saves an inconclusive check as unverified but ready', async () => {
    verifyResult = { result: 'INCONCLUSIVE' };
    const res = await put(create);
    expect(res.body).toMatchObject({
      verification: 'INCONCLUSIVE',
      access: { state: 'READY', verified: false },
    });
    expect((await config())!.verifiedAt).toBeNull();
  });

  it('saves nothing when the provider definitively rejects the key or model', async () => {
    verifyResult = { result: 'REJECTED', kind: 'MODEL_UNAVAILABLE', modelId: 'gemini-2.5-flash' };
    const res = await put(create);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({
      code: 'AI_ACCESS_REJECTED',
      details: { reason: 'MODEL_UNAVAILABLE', modelId: 'gemini-2.5-flash' },
    });
    expect(await config()).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps the current setup untouched when a replacement key is rejected', async () => {
    await configureAI(userId, { verifiedAt: new Date('2026-10-01T00:00:00Z') });
    const before = await config();
    verifyResult = { result: 'REJECTED', kind: 'KEY_REJECTED' };
    expect((await put({ provider: 'gemini', apiKey: 'AIza-replacement-key-000' })).status).toBe(
      422,
    );
    expect(await config()).toEqual(before);
  });

  it('keeps the saved key when the key is blank and only models change', async () => {
    await configureAI(userId, {
      accessIssue: 'MODEL_UNAVAILABLE',
      accessIssueModel: 'gemini-2.5-flash-lite',
    });
    const before = (await config())!;
    const res = await put({ provider: 'gemini', apiKey: '', models: { fast: 'gemini-2.5-flash' } });
    expect(res.status).toBe(200);
    expect(res.body.models.fast).toEqual({ id: 'gemini-2.5-flash', source: 'SELECTED' });
    const after = (await config())!;
    expect(after.encryptedApiKey).toBe(before.encryptedApiKey);
    expect(after).toMatchObject({
      fastModel: 'gemini-2.5-flash',
      revision: before.revision + 1,
      accessIssue: null,
    });
    expect(createProviderClient).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'gemini' }),
      'fixture-ai-key-never-sent',
    );
  });

  it('replaces the ciphertext when a new key is saved and resets limitation state', async () => {
    await configureAI(userId, {
      cooldownUntil: new Date(Date.now() + 60_000),
      accessIssue: 'RATE_LIMITED',
      consecutiveFailures: 3,
    });
    const before = (await config())!;
    await put({ provider: 'gemini', apiKey: KEY });
    const after = (await config())!;
    expect(after.encryptedApiKey).not.toBe(before.encryptedApiKey);
    expect(after).toMatchObject({ cooldownUntil: null, accessIssue: null, consecutiveFailures: 0 });
  });

  it.each([
    ['an unknown field', { ...create, endpoint: 'https://evil.example' }],
    ['an unknown provider', { ...create, provider: 'custom' }],
    ['a missing key for a new provider', { provider: 'gemini', consentDisclosure: DISCLOSURE }],
    ['a key with spaces', { ...create, apiKey: 'AIza key with spaces SENTINEL' }],
    ['a key over 512 characters', { ...create, apiKey: `SENTINEL${'x'.repeat(600)}` }],
    ['missing consent', { provider: 'gemini', apiKey: KEY }],
    ['an outdated consent version', { ...create, consentDisclosure: 'gemini-1999-01' }],
    ['a free-form model', { ...create, models: { fast: 'my-custom-model' } }],
    [
      'a model that does not serve the role',
      { ...create, models: { detailed: 'gemini-2.5-flash-lite' } },
    ],
  ])('rejects %s without echoing the key', async (_label, body) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('SENTINEL');
    expect(await config()).toBeNull();
    expect(createProviderClient).not.toHaveBeenCalled();
  });

  it('caps content-free key checks at 20 per user per day', async () => {
    await prisma.aIUsageDay.create({
      data: { userId, day: utcDay(new Date()), verifications: 20 },
    });
    const res = await put(create);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('AI_VERIFY_RATE_LIMITED');
    expect(client.verifyModels).not.toHaveBeenCalled();
  });

  it('never logs the key on any path', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    await put(create);
    verifyResult = { result: 'REJECTED', kind: 'KEY_REJECTED' };
    await put({ provider: 'gemini', apiKey: `${KEY}-2` });
    await put({ ...create, apiKey: 'bad key SENTINEL' });
    expect(JSON.stringify(logs.map((spy) => spy.mock.calls))).not.toContain('SENTINEL');
    logs.forEach((spy) => spy.mockRestore());
  });

  it('switches provider only after the new key verifies, with new consent and a fresh state', async () => {
    await configureAI(userId, {
      accessIssue: 'RATE_LIMITED',
      cooldownUntil: new Date(Date.now() + 60_000),
      consecutiveFailures: 2,
    });
    const before = (await config())!;
    const switchTo = {
      provider: 'openai',
      apiKey: 'sk-test-openai-key-0000',
      consentDisclosure: 'openai-draft-2026-10',
    };
    // A new provider needs its own key and its own data-use consent.
    expect((await put({ provider: 'openai', apiKey: 'sk-test-openai-key-0000' })).status).toBe(400);
    expect(
      (await put({ provider: 'openai', consentDisclosure: 'openai-draft-2026-10' })).status,
    ).toBe(400);
    expect(await config()).toEqual(before);

    const res = await put(switchTo);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      provider: 'openai',
      models: {
        fast: { id: 'gpt-5-nano', source: 'RECOMMENDED' },
        detailed: { id: 'gpt-5-mini', source: 'RECOMMENDED' },
      },
      access: { state: 'READY' },
      consent: { disclosure: 'openai-draft-2026-10', current: true },
    });
    expect(createProviderClient).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'openai', baseUrl: 'https://api.openai.com/v1' }),
      'sk-test-openai-key-0000',
    );
    const after = (await config())!;
    expect(after.encryptedApiKey).not.toBe(before.encryptedApiKey);
    expect(openApiKey(userId, after.encryptedApiKey)).toBe('sk-test-openai-key-0000');
    expect(after).toMatchObject({
      provider: 'openai',
      accessIssue: null,
      cooldownUntil: null,
      consecutiveFailures: 0,
      revision: before.revision + 1,
    });
  });

  it("is per user: another user's settings stay separate", async () => {
    await put(create);
    expect((await get(OTHER)).body).toMatchObject({ configured: false });
  });
});

describe('check again and remove', () => {
  it('returns 404 when AI is not set up', async () => {
    expect((await check()).status).toBe(404);
  });

  it('clears a needs-attention problem on success but keeps an active rate-limit cooldown', async () => {
    const cooldownUntil = new Date(Date.now() + 60_000);
    await configureAI(userId, { accessIssue: 'KEY_REJECTED', cooldownUntil });
    const res = await check();
    expect(res.body).toMatchObject({ verification: 'VERIFIED', access: { verified: true } });
    expect(await config()).toMatchObject({ accessIssue: null, cooldownUntil });
  });

  it('records a definitive rejection and never overwrites known state when inconclusive', async () => {
    await configureAI(userId);
    verifyResult = { result: 'REJECTED', kind: 'ACCOUNT_OR_BILLING' };
    expect((await check()).body).toMatchObject({
      verification: 'REJECTED',
      access: { state: 'NEEDS_ATTENTION', reason: 'ACCOUNT_OR_BILLING' },
    });
    verifyResult = { result: 'INCONCLUSIVE' };
    expect((await check()).body).toMatchObject({
      verification: 'INCONCLUSIVE',
      access: { reason: 'ACCOUNT_OR_BILLING' },
    });
  });

  it('asks for the key again when the stored key cannot be read', async () => {
    const other = (await prisma.user.findUniqueOrThrow({ where: { email: OTHER } })).id;
    await configureAI(userId, { encryptedApiKey: sealApiKey(other, KEY) });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await check()).body).toMatchObject({
      verification: 'REJECTED',
      access: { reason: 'KEY_UNREADABLE' },
    });
    expect(client.verifyModels).not.toHaveBeenCalled();
  });

  it('rejects any body on check', async () => {
    const res = await request(app)
      .post('/api/ai/settings/check')
      .set(as(OWNER))
      .send({ apiKey: KEY });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('SENTINEL');
  });

  it('removes the configuration and its key, idempotently', async () => {
    await configureAI(userId);
    expect((await request(app).delete('/api/ai/settings').set(as(OWNER))).body).toEqual({
      removed: true,
    });
    expect(await config()).toBeNull();
    expect((await request(app).delete('/api/ai/settings').set(as(OWNER))).status).toBe(200);
  });
});

describe('re-offering waiting emails (no scheduler)', () => {
  it('re-offers nothing while the user has no usable AI access', async () => {
    await prisma.email.create({ data: { userId, gmailMessageId: 'wait-1' } });
    expect(await reofferPendingEmails(userId)).toBe(0);
    await configureAI(userId, { accessIssue: 'KEY_REJECTED' });
    expect(await reofferPendingEmails(userId)).toBe(0);
    await configureAI(userId, {
      accessIssue: 'RATE_LIMITED',
      cooldownUntil: new Date(Date.now() + 60_000),
    });
    expect(await reofferPendingEmails(userId)).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('re-offers at most 100 pending emails, newest first, once access is ready', async () => {
    await configureAI(userId);
    await prisma.email.createMany({
      data: Array.from({ length: 101 }, (_, i) => ({
        userId,
        gmailMessageId: `bulk-${i}`,
        receivedAt: new Date(Date.UTC(2026, 9, 1, 0, i)),
      })),
    });
    await prisma.email.create({
      data: { userId, gmailMessageId: 'done', processingState: 'COMPLETED' },
    });
    expect(await reofferPendingEmails(userId)).toBe(100);
    const offered = await prisma.email.findMany({
      where: {
        id: {
          in: send.mock.calls.map(
            (call) => ((call as unknown[])[1] as { emailId: string }).emailId,
          ),
        },
      },
      select: { gmailMessageId: true },
    });
    expect(offered.map((e) => e.gmailMessageId)).not.toContain('bulk-0'); // the oldest waits for the next sync
    expect(offered.map((e) => e.gmailMessageId)).not.toContain('done');
  });
});

describe('sample-email test', () => {
  const sample = () => request(app).post('/api/ai/settings/sample-test').set(as(OWNER)).send({});
  const extraction = JobExtractionSchema.parse({
    ...Object.fromEntries(Object.keys(JobExtractionSchema.shape).map((key) => [key, null])),
    companyName: 'Northwind Robotics',
    interviewDate: '2026-11-04',
    actionRequired: true,
  });

  it('returns 404 when AI is not set up', async () => {
    expect((await sample()).status).toBe(404);
  });

  it('runs both capabilities on the built-in synthetic email, counts the calls and persists no result', async () => {
    await configureAI(userId);
    client = fakeProviderClient({
      classification: {
        decision: 'RELEVANT',
        category: 'INTERVIEW',
        confidence: 0.92,
        reasoning: 'r',
      },
      extraction,
    });
    vi.mocked(createProviderClient).mockReturnValue(client);
    const res = await sample();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      provider: 'gemini',
      models: { fast: 'gemini-2.5-flash-lite', detailed: 'gemini-2.5-flash' },
      classification: { decision: 'RELEVANT', category: 'INTERVIEW' },
      extraction: {
        companyName: 'Northwind Robotics',
        interviewDate: '2026-11-04',
        actionRequired: true,
      },
      usage: { calls: 2, inputTokens: 20, outputTokens: 10 },
    });
    // Only the synthetic sample is sent, never mail from the user's mailbox.
    expect(client.calls('email_relevance')[0][0].input).toContain('Northwind Robotics');
    expect(client.calls('job_extraction')[0][0].input).toContain('Priya Raman');
    expect(await prisma.aIUsageDay.findFirst({ where: { userId } })).toMatchObject({
      calls: 2,
      inputTokens: 20,
    });
    expect(await prisma.aIOperation.count({ where: { email: { userId } } })).toBe(0);
    expect(await prisma.aIProcessingResult.count({ where: { email: { userId } } })).toBe(0);
  });

  it('makes no call when access is unavailable', async () => {
    await configureAI(userId);
    process.env.AI_USER_DAILY_CALL_LIMIT = '1';
    await prisma.aIUsageDay.create({ data: { userId, day: utcDay(new Date()), calls: 1 } });
    const res = await sample();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'AI_ACCESS_UNAVAILABLE',
      details: { state: 'LIMITED', reason: 'SAFETY_LIMIT' },
    });
    expect(client.generateStructured).not.toHaveBeenCalled();
  });

  it('records a refusal like a real call', async () => {
    await configureAI(userId);
    client.generateStructured.mockRejectedValue(new ProviderFailure('ACCOUNT_OR_BILLING'));
    const res = await sample();
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({
      code: 'AI_ACCESS_REJECTED',
      details: { reason: 'ACCOUNT_OR_BILLING' },
    });
    expect((await config())!.accessIssue).toBe('ACCOUNT_OR_BILLING');
  });

  it('reports unusable output without holding anything', async () => {
    await configureAI(userId);
    client.generateStructured.mockRejectedValue(new ProviderFailure('INVALID_OUTPUT'));
    const res = await sample();
    expect(res.status).toBe(502);
    expect(res.body.error).toMatchObject({
      code: 'AI_SAMPLE_FAILED',
      details: { kind: 'INVALID_OUTPUT' },
    });
    expect((await config())!.accessIssue).toBeNull();
  });
});
