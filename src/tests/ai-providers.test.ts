import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { AISettingsResponseSchema } from '../contracts/ai';
import { resolveAIAccess } from '../services/ai/access';
import { openApiKey, sealApiKey } from '../services/ai/credentials';
import { createProviderClient, VerifyResult } from '../services/ai/providers';
import { configureAI, pauseOf, setPause } from './helpers/aiAccess';
import { fakeProviderClient } from './helpers/fakeProviderClient';

vi.mock('../services/ai/providers', () => ({ createProviderClient: vi.fn() }));
const send = vi.fn(async (): Promise<string | null> => 'job-id');
vi.mock('../services/queue', () => ({
  getQueue: vi.fn(async () => ({ send })),
  stopQueue: vi.fn(),
}));

const OWNER = 'owner@ai-providers.test';
const OTHER = 'other@ai-providers.test';
const GEMINI_KEY = 'AIza-gemini-SENTINEL-0123456789';
const OPENAI_KEY = 'sk-openai-SENTINEL-0123456789';
const OPENAI = { apiKey: OPENAI_KEY, consentDisclosure: 'openai-draft-2026-10' };
let userId: string;

const as = (email = OWNER) => ({ 'X-Development-User': email });
const get = (email = OWNER) => request(app).get('/api/ai/settings').set(as(email));
const save = (provider: string, body: object) =>
  request(app).put(`/api/ai/providers/${provider}`).set(as()).send(body);
const activate = (provider: string) =>
  request(app).post(`/api/ai/providers/${provider}/activate`).set(as()).send({});
const check = (provider: string) =>
  request(app).post(`/api/ai/providers/${provider}/check`).set(as()).send({});
const remove = (provider: string, then?: string) =>
  request(app)
    .delete(`/api/ai/providers/${provider}`)
    .query(then ? { then } : {})
    .set(as());
const active = () => prisma.aIConfiguration.findUnique({ where: { userId } });
const saved = (provider: string) =>
  prisma.aISavedProvider.findUnique({ where: { userId_provider: { userId, provider } } });

let verifyResult: VerifyResult;
let client: ReturnType<typeof fakeProviderClient>;

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: '@ai-providers.test' } } });
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
  await prisma.aISavedProvider.deleteMany({ where: { userId } });
  await prisma.aIUsageDay.deleteMany({ where: { userId } });
  await prisma.email.deleteMany({ where: { userId } });
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: '@ai-providers.test' } } });
});

/** Gemini active (as the settings API saves it), with OpenAI connected but not active. */
async function geminiActiveOpenAISaved() {
  await configureAI(userId, {
    encryptedApiKey: sealApiKey(userId, GEMINI_KEY),
    verifiedAt: new Date(),
  });
  expect((await save('openai', OPENAI)).status).toBe(200);
}

describe('connecting another provider', () => {
  it('makes the first provider active by itself', async () => {
    const res = await save('gemini', {
      apiKey: GEMINI_KEY,
      consentDisclosure: 'gemini-draft-2026-10',
    });
    expect(res.status).toBe(200);
    expect(res.body.connections).toMatchObject([{ provider: 'gemini', active: true }]);
    expect(await active()).toMatchObject({ provider: 'gemini' });
  });

  it('keeps a second provider inactive, with its own key, and leaves the active one untouched', async () => {
    await configureAI(userId, { encryptedApiKey: sealApiKey(userId, GEMINI_KEY) });
    const before = (await active())!;
    const res = await save('openai', OPENAI);
    expect(res.status).toBe(200);
    expect(AISettingsResponseSchema.parse(res.body).connections).toMatchObject([
      { provider: 'gemini', active: true },
      {
        provider: 'openai',
        active: false,
        state: 'READY',
        verified: true,
        consentCurrent: true,
        models: {
          fast: { id: 'gpt-5-nano', source: 'RECOMMENDED' },
          detailed: { id: 'gpt-5-mini', source: 'RECOMMENDED' },
        },
      },
    ]);
    expect(res.body).toMatchObject({ provider: 'gemini', verification: 'VERIFIED' });
    expect(await active()).toEqual(before);
    const row = (await saved('openai'))!;
    expect(openApiKey(userId, row.encryptedApiKey)).toBe(OPENAI_KEY);
    expect(row).toMatchObject({ consentDisclosure: 'openai-draft-2026-10' });
    expect(JSON.stringify(res.body)).not.toContain('SENTINEL');
  });

  it('needs its own key and consent, and saves nothing when the key is refused', async () => {
    await configureAI(userId);
    expect((await save('openai', { apiKey: OPENAI_KEY })).status).toBe(400);
    expect((await save('openai', { consentDisclosure: OPENAI.consentDisclosure })).status).toBe(
      400,
    );
    verifyResult = { result: 'REJECTED', kind: 'KEY_REJECTED' };
    const res = await save('openai', OPENAI);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'AI_ACCESS_REJECTED' });
    expect(await saved('openai')).toBeNull();
  });

  it('makes it active at once with makeActive, keeping the replaced one connected', async () => {
    await configureAI(userId, { encryptedApiKey: sealApiKey(userId, GEMINI_KEY) });
    const before = (await active())!;
    await setPause(userId, 'gemini-3.8-flash', { resumesAt: new Date(Date.now() + 60_000) });
    const res = await save('openai', { ...OPENAI, makeActive: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ provider: 'openai', verification: 'VERIFIED' });
    expect(res.body.connections).toMatchObject([
      { provider: 'openai', active: true },
      { provider: 'gemini', active: false },
    ]);
    expect(await active()).toMatchObject({ provider: 'openai', revision: before.revision + 1 });
    expect(openApiKey(userId, (await saved('gemini'))!.encryptedApiKey)).toBe(GEMINI_KEY);
    expect(await prisma.aIModelPause.count({ where: { userId } })).toBe(0);
  });

  it('replaces the key of an inactive provider and clears its key problem', async () => {
    await geminiActiveOpenAISaved();
    await prisma.aISavedProvider.update({
      where: { userId_provider: { userId, provider: 'openai' } },
      data: { accessIssue: 'KEY_REJECTED' },
    });
    const res = await save('openai', { apiKey: 'sk-openai-new-0123456789' });
    expect(res.status).toBe(200);
    const row = (await saved('openai'))!;
    expect(openApiKey(userId, row.encryptedApiKey)).toBe('sk-openai-new-0123456789');
    expect(row.accessIssue).toBeNull();
    expect(await active()).toMatchObject({ provider: 'gemini' });
  });

  it('changes an inactive provider model only after the key can use it', async () => {
    await geminiActiveOpenAISaved();
    verifyResult = { result: 'REJECTED', kind: 'MODEL_UNAVAILABLE', modelId: 'gpt-5-mini' };
    expect((await save('openai', { models: { fast: 'gpt-5-mini' } })).status).toBe(422);
    expect((await saved('openai'))!.fastModel).toBeNull();
    verifyResult = { result: 'VERIFIED' };
    const res = await save('openai', { models: { fast: 'gpt-5-mini' } });
    expect(res.status).toBe(200);
    expect(res.body.connections[1]).toMatchObject({
      provider: 'openai',
      models: { fast: { id: 'gpt-5-mini', source: 'SELECTED' } },
    });
    expect(client.verifyModels).toHaveBeenLastCalledWith(['gpt-5-mini', 'gpt-5-mini']);
  });
});

describe('making a provider active', () => {
  it('swaps the setups: AI work then uses only the new active provider', async () => {
    await geminiActiveOpenAISaved();
    await prisma.email.create({ data: { userId, gmailMessageId: 'waiting-switch' } });
    const before = (await active())!;
    const res = await activate('openai');
    expect(res.status).toBe(200);
    expect(res.body.connections).toMatchObject([
      { provider: 'openai', active: true },
      { provider: 'gemini', active: false },
    ]);
    expect(await active()).toMatchObject({ provider: 'openai', revision: before.revision + 1 });
    expect(await saved('openai')).toBeNull();
    const access = await resolveAIAccess(userId);
    expect(access.provider).toBe('openai');
    expect(createProviderClient).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'openai' }),
      OPENAI_KEY,
    );
    // Mail waiting for AI goes to the new provider.
    expect(send).toHaveBeenCalled();
  });

  it('changes nothing when the provider is already active', async () => {
    await geminiActiveOpenAISaved();
    const before = (await active())!;
    expect((await activate('gemini')).status).toBe(200);
    expect(await active()).toEqual(before);
  });

  it('refuses a provider that is not connected, or whose last check found a key problem', async () => {
    await configureAI(userId);
    expect((await activate('openai')).body.error).toMatchObject({
      code: 'AI_PROVIDER_NOT_CONNECTED',
    });
    await save('openai', OPENAI);
    await prisma.aISavedProvider.update({
      where: { userId_provider: { userId, provider: 'openai' } },
      data: { accessIssue: 'ACCOUNT_OR_BILLING' },
    });
    const res = await activate('openai');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'AI_PROVIDER_NOT_READY',
      details: { reason: 'ACCOUNT_OR_BILLING' },
    });
    expect(await active()).toMatchObject({ provider: 'gemini' });
  });

  it("ends the old setup's pauses; a pause on the new setup's model works as before", async () => {
    await geminiActiveOpenAISaved();
    await setPause(userId, 'gemini-3.8-flash', { resumesAt: new Date(Date.now() + 60_000) });
    await activate('openai');
    expect(await pauseOf(userId, 'gemini-3.8-flash')).toBeNull();
    await setPause(userId, 'gpt-5-mini', { resumesAt: new Date(Date.now() + 60_000) });
    const { body } = await get();
    expect(body.access).toMatchObject({ state: 'LIMITED', modelId: 'gpt-5-mini' });
    expect(body.connections[0]).toMatchObject({ provider: 'openai', state: 'LIMITED' });
  });
});

describe('checking a provider', () => {
  it('checks an inactive provider and changes only its own state', async () => {
    await geminiActiveOpenAISaved();
    const before = (await active())!;
    verifyResult = { result: 'REJECTED', kind: 'KEY_REJECTED' };
    const rejected = await check('openai');
    expect(rejected.body).toMatchObject({ verification: 'REJECTED', access: { state: 'READY' } });
    expect(rejected.body.connections[1]).toMatchObject({
      provider: 'openai',
      state: 'NEEDS_ATTENTION',
      reason: 'KEY_REJECTED',
    });
    verifyResult = { result: 'INCONCLUSIVE' };
    expect((await check('openai')).body.connections[1]).toMatchObject({ reason: 'KEY_REJECTED' });
    verifyResult = { result: 'VERIFIED' };
    expect((await check('openai')).body.connections[1]).toMatchObject({ state: 'READY' });
    expect(await active()).toEqual(before);
  });

  it('asks for the key again when an inactive key cannot be read', async () => {
    await configureAI(userId);
    const other = (await prisma.user.findUniqueOrThrow({ where: { email: OTHER } })).id;
    await prisma.aISavedProvider.create({
      data: {
        userId,
        provider: 'openai',
        encryptedApiKey: sealApiKey(other, OPENAI_KEY),
        consentDisclosure: OPENAI.consentDisclosure,
        consentedAt: new Date(),
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await check('openai');
    expect(res.body).toMatchObject({ verification: 'REJECTED' });
    expect(res.body.connections[1]).toMatchObject({ reason: 'KEY_UNREADABLE' });
    expect(client.verifyModels).not.toHaveBeenCalled();
  });

  it('returns 404 for a provider that is not connected', async () => {
    expect((await check('openai')).body.error).toMatchObject({
      code: 'AI_PROVIDER_NOT_CONNECTED',
    });
  });
});

describe('removing a provider', () => {
  it('removes an inactive provider and its key, idempotently', async () => {
    await geminiActiveOpenAISaved();
    const res = await remove('openai');
    expect(res.status).toBe(200);
    expect(res.body.connections).toMatchObject([{ provider: 'gemini', active: true }]);
    expect(await saved('openai')).toBeNull();
    expect((await remove('openai')).status).toBe(200);
  });

  it('makes the chosen provider active when the active one is removed', async () => {
    await geminiActiveOpenAISaved();
    const res = await remove('gemini', 'openai');
    expect(res.status).toBe(200);
    expect(res.body.connections).toMatchObject([{ provider: 'openai', active: true }]);
    expect(await saved('gemini')).toBeNull();
    expect(await active()).toMatchObject({ provider: 'openai' });
  });

  it('leaves no provider active with then=none: the others stay connected and new mail waits', async () => {
    await geminiActiveOpenAISaved();
    const res = await remove('gemini', 'none');
    expect(res.body).toMatchObject({
      configured: false,
      access: { state: 'NOT_SET_UP' },
      connections: [{ provider: 'openai', active: false }],
    });
    expect(await active()).toBeNull();
    // Connecting again then works on the inactive provider without making it active.
    expect((await save('openai', { apiKey: 'sk-openai-again-0123456789' })).status).toBe(200);
    expect(await active()).toBeNull();
    expect((await activate('openai')).body).toMatchObject({ provider: 'openai' });
  });

  it('keeps the active provider when the chosen next one cannot be made active', async () => {
    await geminiActiveOpenAISaved();
    expect((await remove('gemini', 'anthropic')).status).toBe(404);
    expect((await remove('gemini', 'gemini')).status).toBe(400);
    expect(await active()).toMatchObject({ provider: 'gemini' });
  });
});

describe('per user', () => {
  it("never shows or changes another user's connections", async () => {
    await geminiActiveOpenAISaved();
    expect((await get(OTHER)).body).toMatchObject({ configured: false, connections: [] });
  });

  it('deletes every connection with the user', async () => {
    const gone = await prisma.user.create({ data: { email: 'gone@ai-providers.test' } });
    await prisma.aISavedProvider.create({
      data: {
        userId: gone.id,
        provider: 'openai',
        encryptedApiKey: sealApiKey(gone.id, OPENAI_KEY),
        consentDisclosure: OPENAI.consentDisclosure,
        consentedAt: new Date(),
      },
    });
    await prisma.user.delete({ where: { id: gone.id } });
    expect(await prisma.aISavedProvider.count({ where: { userId: gone.id } })).toBe(0);
  });
});
