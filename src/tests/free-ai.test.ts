/**
 * The free AI (owner, 24 Oct 2026): Career Companion's own OpenRouter key for every user who
 * chose it, one pause shared by all of them, its own daily limit, and the owner told once about a
 * credit, key or model problem. The real pipeline, ledger and settings API, with only the provider
 * client, Gmail, the queue and Discord faked.
 */
import request from 'supertest';
import type { JobWithMetadata } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { AISettingsResponseSchema } from '../contracts/ai';
import { getCatalogProvider } from '../contracts/aiCatalog';
import { emailWorkerOptions, processEmailJob } from '../jobs/emailProcessingJob';
import { ProviderFailure } from '../services/ai/errors';
import { reofferPendingEmails } from '../services/ai/offer';
import { noteProviderFailure, reserveUserCall } from '../services/ai/usage';
import type { AIFailure } from '../contracts/ai';
import { createProviderClient } from '../services/ai/providers';
import { AI_RESUME_JOB, EmailProcessingJobData } from '../services/enqueue';
import { fetchMessageBody, fetchMessageMetadata } from '../services/gmailFetcher';
import { sendOwnerAlert } from '../services/notifications/ownerAlert';
import {
  parseAI_EMAIL_WORKER_CONCURRENCY,
  parseAI_FREE_DAILY_CALL_LIMIT,
  parseFREE_AI_ENABLED,
} from '../utils/config';
import { configureAI } from './helpers/aiAccess';
import { fakeProviderClient } from './helpers/fakeProviderClient';

vi.mock('../services/gmailFetcher');
vi.mock('../services/ai/providers', () => ({ createProviderClient: vi.fn() }));
type Send = (name: string, data: object, options?: object) => Promise<string | null>;
const send = vi.fn<Send>(async () => 'job-id');
vi.mock('../services/queue', () => ({
  getQueue: vi.fn(async () => ({ send, cancel: vi.fn(async () => undefined) })),
  stopQueue: vi.fn(),
}));
vi.mock('../services/notifications/ownerAlert', () => ({
  sendOwnerAlert: vi.fn(async () => true),
}));

const FREE = 'career-companion';
const LUNA = 'openai/gpt-6-luna';
const CONSENT = getCatalogProvider(FREE)!.disclosure.version;
const SERVER_KEY = 'free-ai-fixture-key-never-sent';
const ANNA = 'anna@free-ai.test';
const BEN = 'ben@free-ai.test';
const CARA = 'cara@free-ai.test';
const ids: Record<string, string> = {};

const notJobMail = { decision: 'IRRELEVANT', confidence: 0.99, reasoning: 'r' };
/** What the free AI answers when it sorts a mail. */
let sorting: () => unknown;
const client = fakeProviderClient({ classification: () => sorting() });

const as = (email: string) => ({ 'X-Development-User': email });
const settings = async (email: string) =>
  AISettingsResponseSchema.parse((await request(app).get('/api/ai/settings').set(as(email))).body);
const connect = (email: string, body: object) =>
  request(app).put(`/api/ai/providers/${FREE}`).set(as(email)).send(body);
const freePause = () => prisma.freeAIPause.findUnique({ where: { model: LUNA } });
const secondsFromNow = (date: Date | null | undefined) =>
  Math.round(((date?.getTime() ?? 0) - Date.now()) / 1000);

/** The free AI as the user's active provider, the way connecting it saves it. */
const useFreeAI = (email: string) =>
  prisma.aIConfiguration.create({
    data: {
      userId: ids[email],
      provider: FREE,
      encryptedApiKey: null,
      consentDisclosure: CONSENT,
      consentedAt: new Date(),
      verifiedAt: new Date(),
    },
  });

const newEmail = async (email: string) =>
  (
    await prisma.email.create({
      data: { userId: ids[email], gmailMessageId: `free-${Math.random()}`, subject: 'Hello' },
    })
  ).id;
const read = (email: string, emailId: string) =>
  processEmailJob({
    id: `job-${emailId}`,
    data: { userId: ids[email], emailId },
    retryCount: 0,
    retryLimit: 3,
  } as JobWithMetadata<EmailProcessingJobData>);
const state = async (emailId: string) =>
  (await prisma.email.findUniqueOrThrow({ where: { id: emailId } })).processingState;
const resumesQueuedFor = (email: string) =>
  send.mock.calls.filter(
    ([name, data]) => name === AI_RESUME_JOB && (data as { userId: string }).userId === ids[email],
  );
const refusal = (kind: ProviderFailure['kind'], status: number, retryAfterMs?: number) => () => {
  throw new ProviderFailure(kind, { status, retryAfterMs });
};

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: '@free-ai.test' } } });
  for (const email of [ANNA, BEN, CARA])
    ids[email] = (await prisma.user.create({ data: { email } })).id;
});
beforeEach(async () => {
  vi.stubEnv('FREE_AI_OPENROUTER_KEY', SERVER_KEY);
  vi.stubEnv('FREE_AI_ENABLED', '');
  vi.stubEnv('AI_FREE_DAILY_CALL_LIMIT', '');
  vi.stubEnv('AI_USER_DAILY_CALL_LIMIT', '');
  sorting = () => notJobMail;
  client.generateStructured.mockClear();
  vi.mocked(createProviderClient).mockReset().mockReturnValue(client);
  vi.mocked(fetchMessageMetadata).mockResolvedValue({ labelIds: ['INBOX'], snippet: 'Hello' });
  vi.mocked(fetchMessageBody).mockResolvedValue('Synthetic body');
  vi.mocked(sendOwnerAlert).mockClear();
  send.mockClear();
  const userId = { in: Object.values(ids) };
  await prisma.email.deleteMany({ where: { userId } });
  await prisma.aIUsageDay.deleteMany({ where: { userId } });
  await prisma.aIConfiguration.deleteMany({ where: { userId } });
  await prisma.aISavedProvider.deleteMany({ where: { userId } });
  await prisma.freeAIPause.deleteMany({});
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma.freeAIPause.deleteMany({});
  await prisma.user.deleteMany({ where: { email: { endsWith: '@free-ai.test' } } });
});

describe('offering the free AI', () => {
  it('is offered only while its key is set and it is switched on', async () => {
    expect((await settings(ANNA)).offeredProviders).toContain(FREE);
    vi.stubEnv('FREE_AI_ENABLED', 'false');
    expect((await settings(ANNA)).offeredProviders).not.toContain(FREE);
    vi.stubEnv('FREE_AI_ENABLED', '');
    vi.stubEnv('FREE_AI_OPENROUTER_KEY', '');
    expect((await settings(ANNA)).offeredProviders).not.toContain(FREE);
    expect((await connect(ANNA, { consentDisclosure: CONSENT })).status).toBe(400);
  });
});

describe('connecting the free AI', () => {
  it('needs only the consent, becomes active as the first provider, and stores no key', async () => {
    const res = await connect(ANNA, { consentDisclosure: CONSENT });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ provider: FREE, verification: 'VERIFIED' });
    expect(AISettingsResponseSchema.parse(res.body).connections).toMatchObject([
      {
        provider: FREE,
        active: true,
        state: 'READY',
        consentCurrent: true,
        models: { fast: { id: LUNA }, detailed: { id: LUNA } },
      },
    ]);
    expect(
      await prisma.aIConfiguration.findUniqueOrThrow({ where: { userId: ids[ANNA] } }),
    ).toMatchObject({ provider: FREE, encryptedApiKey: null, consentDisclosure: CONSENT });
    // Nothing to verify: no call to OpenRouter.
    expect(createProviderClient).not.toHaveBeenCalled();
  });

  it('refuses a key, a model choice, a missing consent, and any key check', async () => {
    expect(
      (await connect(ANNA, { consentDisclosure: CONSENT, apiKey: 'own-key-123' })).status,
    ).toBe(400);
    expect(
      (await connect(ANNA, { consentDisclosure: CONSENT, models: { fast: LUNA } })).status,
    ).toBe(400);
    expect((await connect(ANNA, {})).status).toBe(400);
    expect((await connect(ANNA, { consentDisclosure: CONSENT })).status).toBe(200);
    const check = await request(app).post(`/api/ai/providers/${FREE}/check`).set(as(ANNA)).send({});
    expect(check.status).toBe(409);
    expect(check.body.error.code).toBe('AI_PROVIDER_HAS_NO_KEY');
  });

  it('stays inactive next to an own key unless made active, then switches at once', async () => {
    await configureAI(ids[ANNA]);
    const res = await connect(ANNA, { consentDisclosure: CONSENT });
    expect(AISettingsResponseSchema.parse(res.body).connections).toMatchObject([
      { provider: 'gemini', active: true },
      { provider: FREE, active: false, state: 'READY' },
    ]);
    const switched = await connect(ANNA, { makeActive: true });
    expect(switched.status).toBe(200);
    expect(AISettingsResponseSchema.parse(switched.body).connections).toMatchObject([
      { provider: FREE, active: true },
      { provider: 'gemini', active: false },
    ]);
  });
});

describe('reading mail on the free AI', () => {
  it("uses Career Companion's key, never a key of the user's", async () => {
    await useFreeAI(ANNA);
    const emailId = await newEmail(ANNA);
    await read(ANNA, emailId);
    expect(await state(emailId)).toBe('COMPLETED');
    expect(createProviderClient).toHaveBeenCalledWith(getCatalogProvider(FREE), SERVER_KEY);
    expect(client.calls('email_relevance')[0][0].model.id).toBe(LUNA);
  });

  it('one busy answer pauses it for everyone on it, but not users on their own key', async () => {
    await useFreeAI(ANNA);
    await useFreeAI(BEN);
    await configureAI(ids[CARA]);
    sorting = refusal('RATE_LIMITED', 429, 30_000);
    const annasMail = await newEmail(ANNA);
    await read(ANNA, annasMail);
    expect(await state(annasMail)).toBe('PENDING');
    const pause = await freePause();
    expect(pause).toMatchObject({ reason: 'RATE_LIMITED', consecutiveFailures: 1 });
    expect(secondsFromNow(pause?.resumesAt)).toBe(30);

    // Ben's mail does not ask OpenRouter again: it waits, and his read is queued for the end.
    client.generateStructured.mockClear();
    const bensMail = await newEmail(BEN);
    await read(BEN, bensMail);
    expect(client.generateStructured).not.toHaveBeenCalled();
    expect(await state(bensMail)).toBe('PENDING');
    expect(resumesQueuedFor(BEN)).toHaveLength(1);
    expect((await settings(BEN)).access).toMatchObject({
      state: 'LIMITED',
      reason: 'FREE_AI_BUSY',
      pauses: [{ model: LUNA, reason: 'FREE_AI_BUSY', test: null }],
    });

    // Cara's own key is not held back.
    sorting = () => notJobMail;
    const carasMail = await newEmail(CARA);
    await read(CARA, carasMail);
    expect(await state(carasMail)).toBe('COMPLETED');
  });

  it("a sync while it is paused queues each user's read for the end of the pause", async () => {
    await useFreeAI(BEN);
    await newEmail(BEN);
    const resumesAt = new Date(Date.now() + 120_000);
    await prisma.freeAIPause.create({ data: { model: LUNA, reason: 'PROVIDER_BUSY', resumesAt } });
    expect(await reofferPendingEmails(ids[BEN])).toBe(0);
    const [resume] = resumesQueuedFor(BEN);
    expect(resume?.[2]).toMatchObject({ startAfter: new Date(resumesAt.getTime() + 2000) });
  });

  it('a busy answer in a row makes the shared pause longer', async () => {
    await useFreeAI(ANNA);
    await prisma.freeAIPause.create({
      data: {
        model: LUNA,
        reason: 'RATE_LIMITED',
        resumesAt: new Date(Date.now() - 1000),
        consecutiveFailures: 2,
      },
    });
    sorting = refusal('PROVIDER_BUSY', 503);
    await read(ANNA, await newEmail(ANNA));
    const pause = await freePause();
    expect(pause).toMatchObject({ reason: 'PROVIDER_BUSY', consecutiveFailures: 3 });
    expect(secondsFromNow(pause?.resumesAt)).toBe(240);
  });

  it('a call that works ends the shared pause for everyone', async () => {
    await useFreeAI(ANNA);
    await prisma.freeAIPause.create({
      data: {
        model: LUNA,
        reason: 'RATE_LIMITED',
        resumesAt: new Date(Date.now() - 1000),
        consecutiveFailures: 3,
      },
    });
    await read(ANNA, await newEmail(ANNA));
    expect(await freePause()).toBeNull();
  });

  it('a used-up credit pauses it for an hour, tells the owner once, and asks no user to fix a key', async () => {
    await useFreeAI(ANNA);
    sorting = refusal('ACCOUNT_OR_BILLING', 402);
    await read(ANNA, await newEmail(ANNA));
    const pause = await freePause();
    expect(pause).toMatchObject({ reason: 'ACCOUNT_OR_BILLING' });
    expect(secondsFromNow(pause?.resumesAt)).toBe(3600);
    expect(sendOwnerAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendOwnerAlert).mock.calls[0][0]).toContain('credit is used up');
    expect(
      await prisma.aIConfiguration.findUniqueOrThrow({ where: { userId: ids[ANNA] } }),
    ).toMatchObject({ accessIssue: null });
    expect((await settings(ANNA)).access).toMatchObject({
      state: 'LIMITED',
      reason: 'FREE_AI_BUDGET',
    });

    // The hourly try fails the same way: the owner already knows.
    await prisma.freeAIPause.update({
      where: { model: LUNA },
      data: { resumesAt: new Date(Date.now() - 1000) },
    });
    await read(ANNA, await newEmail(ANNA));
    expect(secondsFromNow((await freePause())?.resumesAt)).toBe(3600);
    expect(sendOwnerAlert).toHaveBeenCalledTimes(1);
  });

  it('a refused key and then a missing model are each told to the owner', async () => {
    await useFreeAI(ANNA);
    sorting = refusal('KEY_REJECTED', 401);
    await read(ANNA, await newEmail(ANNA));
    expect((await settings(ANNA)).access.reason).toBe('FREE_AI_PROBLEM');
    expect(vi.mocked(sendOwnerAlert).mock.calls[0][0]).toContain('refused the free AI key');

    await prisma.freeAIPause.update({
      where: { model: LUNA },
      data: { resumesAt: new Date(Date.now() - 1000) },
    });
    sorting = refusal('MODEL_UNAVAILABLE', 404);
    await read(ANNA, await newEmail(ANNA));
    expect(sendOwnerAlert).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(vi.mocked(sendOwnerAlert).mock.calls)).not.toContain(SERVER_KEY);
  });

  it('switched off: the mail waits for Career Companion and nothing is sent', async () => {
    await useFreeAI(ANNA);
    vi.stubEnv('FREE_AI_ENABLED', 'false');
    const emailId = await newEmail(ANNA);
    await read(ANNA, emailId);
    expect(await state(emailId)).toBe('PENDING');
    expect(createProviderClient).not.toHaveBeenCalled();
    expect((await settings(ANNA)).access).toMatchObject({
      state: 'LIMITED',
      reason: 'FREE_AI_OFF',
    });
  });
});

describe('limits and privacy', () => {
  it('has its own daily limit, smaller than on an own key', async () => {
    await useFreeAI(ANNA);
    await configureAI(ids[CARA]);
    expect((await settings(ANNA)).safetyLimit.callsPerDay).toBe(250);
    expect((await settings(CARA)).safetyLimit.callsPerDay).toBe(500);
    await prisma.aIUsageDay.create({
      data: { userId: ids[ANNA], day: new Date().toISOString().slice(0, 10), calls: 250 },
    });
    expect((await settings(ANNA)).access).toMatchObject({
      state: 'LIMITED',
      reason: 'SAFETY_LIMIT',
    });
  });

  it('counts calls made at the same moment, as with 3 mails read at once', async () => {
    await useFreeAI(ANNA);
    const call = { userId: ids[ANNA], provider: FREE, model: LUNA };
    await Promise.all(
      [1, 2, 3].map(() => prisma.$transaction((tx) => reserveUserCall(tx, call, new Date()))),
    );
    expect(
      await prisma.aIUsageDay.findFirstOrThrow({ where: { userId: ids[ANNA] } }),
    ).toMatchObject({ calls: 3 });
  });

  it('two busy answers at the same moment make one pause, on the free AI and on an own key', async () => {
    await useFreeAI(ANNA);
    await configureAI(ids[CARA]);
    const busy = (userId: string, provider: string, model: string) =>
      prisma.$transaction((tx) =>
        noteProviderFailure(tx, { userId, provider, revision: 0 }, 'RATE_LIMITED', new Date(), {
          modelId: model,
          failure: { kind: 'RATE_LIMITED' } as AIFailure,
        }),
      );
    await Promise.all([busy(ids[ANNA], FREE, LUNA), busy(ids[BEN], FREE, LUNA)]);
    expect(await prisma.freeAIPause.count()).toBe(1);
    const gemini = 'gemini-3.5-flash-lite';
    await Promise.all([1, 2].map(() => busy(ids[CARA], 'gemini', gemini)));
    expect(
      await prisma.aIModelPause.findUniqueOrThrow({
        where: { userId_model: { userId: ids[CARA], model: gemini } },
      }),
    ).toMatchObject({ consecutiveFailures: 2 });
  });

  it("never shows Career Companion's key", async () => {
    await useFreeAI(ANNA);
    const res = await request(app).get('/api/ai/settings').set(as(ANNA));
    expect(JSON.stringify(res.body)).not.toContain(SERVER_KEY);
  });

  it('reads its settings strictly', () => {
    expect(parseFREE_AI_ENABLED(undefined)).toBe(true);
    expect(parseFREE_AI_ENABLED('false')).toBe(false);
    expect(() => parseFREE_AI_ENABLED('off')).toThrow('FREE_AI_ENABLED');
    expect(parseAI_FREE_DAILY_CALL_LIMIT('')).toBe(250);
    expect(parseAI_FREE_DAILY_CALL_LIMIT('0')).toBe(0);
    expect(() => parseAI_FREE_DAILY_CALL_LIMIT('5001')).toThrow('AI_FREE_DAILY_CALL_LIMIT');
    expect(parseAI_EMAIL_WORKER_CONCURRENCY(undefined)).toBe(3);
    expect(() => parseAI_EMAIL_WORKER_CONCURRENCY('4')).toThrow('AI_EMAIL_WORKER_CONCURRENCY');
    vi.stubEnv('AI_EMAIL_WORKER_CONCURRENCY', '3');
    expect(emailWorkerOptions()).toEqual({
      includeMetadata: true,
      batchSize: 1,
      localConcurrency: 3,
    });
  });
});
