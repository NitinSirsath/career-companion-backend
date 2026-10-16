import { spawnSync } from 'child_process';
import path from 'path';
import type { JobWithMetadata } from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_PROVIDER_IDS, getCatalogProvider, recommendedModel } from '../contracts/aiCatalog';
import { prisma } from '../db/prisma';
import {
  FAKE_AI_ERRORS,
  FAKE_TIMEOUT_MS,
  FakeAiError,
  blockProviderRequests,
  fakeAiAnswers,
} from './helpers/fakeAiErrors';
import { processEmailJob } from '../jobs/emailProcessingJob';
import { CLASSIFICATION_CONTRACT } from '../services/ai/contracts';
import { ProviderFailure } from '../services/ai/errors';
import { createProviderClient } from '../services/ai/providers';
import { nextPacificMidnight } from '../services/ai/usage';
import { EmailProcessingJobData } from '../services/enqueue';
import { fetchMessageBody, fetchMessageMetadata } from '../services/gmailFetcher';
import { FIXTURE_KEY, configureAI } from './helpers/aiAccess';

// The real adapters run; only the AI libraries' calls are the fakes, as in the fake-error command.
let answers = fakeAiAnswers('busy');
vi.mock('@google/genai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google/genai')>()),
  GoogleGenAI: vi.fn().mockImplementation(function () {
    return {
      models: {
        generateContent: (params: { model: string }) => answers.gemini.generateContent(params),
      },
    };
  }),
}));
vi.mock('openai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openai')>();
  const OpenAIMock = vi.fn().mockImplementation(function () {
    return {
      chat: { completions: { create: (body: { model: string }) => answers.openai.create(body) } },
      models: { retrieve: (id: string) => answers.openai.retrieve(id) },
    };
  });
  return { ...actual, default: OpenAIMock, OpenAI: OpenAIMock };
});
vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/sdk')>();
  const AnthropicMock = vi.fn().mockImplementation(function () {
    return {
      messages: { create: (body: { model: string }) => answers.anthropic.create(body) },
      models: { retrieve: (id: string) => answers.anthropic.retrieve(id) },
    };
  });
  return { ...actual, default: AnthropicMock, Anthropic: AnthropicMock };
});
vi.mock('../services/gmailFetcher');
vi.mock('../services/queue', () => ({ getQueue: async () => ({ cancel: async () => undefined }) }));
vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueAiResume: vi.fn(),
}));

const FAULTS = Object.keys(FAKE_AI_ERRORS) as FakeAiError[];
const providerClient = (providerId: string) => {
  const provider = getCatalogProvider(providerId)!;
  return { provider, client: createProviderClient(provider, FIXTURE_KEY) };
};

/** Runs one call to the provider's fast model; settles a fake "no answer" by moving the clock. */
async function failureOf(fault: FakeAiError, providerId: string) {
  answers = fakeAiAnswers(fault);
  const { provider, client: ai } = providerClient(providerId);
  const pending = ai
    .generateStructured({
      contract: CLASSIFICATION_CONTRACT,
      model: recommendedModel(provider, 'fast'),
      input: 'Synthetic mail',
    })
    .then(
      () => {
        throw new Error('expected a failure');
      },
      (err: ProviderFailure) => err,
    );
  await vi.advanceTimersByTimeAsync(FAKE_TIMEOUT_MS);
  return pending;
}

/** The kind each fault gets from today's real error handling: Gemini, OpenAI, Anthropic. */
const KINDS_TODAY: Record<FakeAiError, [string, string, string]> = {
  busy: ['PROVIDER_BUSY', 'RATE_LIMITED', 'RATE_LIMITED'],
  'no-answer': ['OUTCOME_UNKNOWN', 'OUTCOME_UNKNOWN', 'OUTCOME_UNKNOWN'],
  deadline: ['OUTCOME_UNKNOWN', 'OUTCOME_UNKNOWN', 'OUTCOME_UNKNOWN'],
  'rate-minute': ['RATE_LIMITED', 'RATE_LIMITED', 'RATE_LIMITED'],
  'rate-day': ['RATE_LIMITED', 'RATE_LIMITED', 'RATE_LIMITED'],
  key: ['KEY_REJECTED', 'KEY_REJECTED', 'KEY_REJECTED'],
  billing: ['ACCOUNT_OR_BILLING', 'ACCOUNT_OR_BILLING', 'ACCOUNT_OR_BILLING'],
  'model-gone': ['MODEL_UNAVAILABLE', 'MODEL_UNAVAILABLE', 'MODEL_UNAVAILABLE'],
  unusable: ['INVALID_OUTPUT', 'INVALID_OUTPUT', 'INVALID_OUTPUT'],
  'no-connection': ['PROVIDER_BUSY', 'PROVIDER_BUSY', 'PROVIDER_BUSY'],
  'line-dropped': ['OUTCOME_UNKNOWN', 'OUTCOME_UNKNOWN', 'OUTCOME_UNKNOWN'],
  'server-error': ['PROVIDER_BUSY', 'OUTCOME_UNKNOWN', 'OUTCOME_UNKNOWN'],
};
const answer = ['PROVIDER_ANSWER', 'PROVIDER_ANSWER', 'PROVIDER_ANSWER'] as const;
/** Where each fault failed, as the adapters sort it: Gemini, OpenAI, Anthropic. */
const CAUSES: Record<FakeAiError, readonly [string, string, string]> = {
  busy: answer,
  'no-answer': ['TIMEOUT', 'TIMEOUT', 'TIMEOUT'],
  deadline: ['PROVIDER_DEADLINE', 'PROVIDER_ANSWER', 'PROVIDER_ANSWER'],
  'rate-minute': answer,
  'rate-day': answer,
  key: answer,
  billing: answer,
  'model-gone': answer,
  unusable: answer,
  'no-connection': ['NETWORK', 'NETWORK', 'NETWORK'],
  'line-dropped': ['NETWORK_AFTER_SEND', 'NETWORK_AFTER_SEND', 'NETWORK_AFTER_SEND'],
  'server-error': answer,
};
const NETWORK_CODES: Partial<Record<FakeAiError, string>> = {
  'no-connection': 'ENOTFOUND',
  'line-dropped': 'ECONNRESET',
};
const byProvider = FAULTS.flatMap((fault) =>
  AI_PROVIDER_IDS.map(
    (providerId, i) => [fault, providerId, KINDS_TODAY[fault][i], CAUSES[fault][i]] as const,
  ),
);

describe('each fake AI error through the real adapter and error handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(byProvider)('%s from %s → %s, cause %s', async (fault, providerId, kind, cause) => {
    const failure = await failureOf(fault, providerId);
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect(failure.kind).toBe(kind);
    expect(failure.failureCause).toBe(cause);
    expect(failure.networkCode).toBe(NETWORK_CODES[fault]);
  });

  it.each([
    ['busy', 503, 'UNAVAILABLE', undefined],
    ['deadline', 504, 'DEADLINE_EXCEEDED', undefined],
    ['rate-minute', 429, 'RESOURCE_EXHAUSTED', 10_000],
    ['rate-day', 429, 'RESOURCE_EXHAUSTED', 10_000],
    ['key', 400, 'API_KEY_INVALID', undefined],
    ['billing', 403, 'SERVICE_DISABLED', undefined],
    ['model-gone', 404, 'NOT_FOUND', undefined],
    ['server-error', 500, 'INTERNAL', undefined],
  ] as const)(
    'Google %s answers %i %s, as the app reads it',
    async (fault, status, providerCode, retryAfterMs) => {
      expect(await failureOf(fault, 'gemini')).toMatchObject({
        status,
        providerCode,
        retryAfterMs,
      });
    },
  );

  it('stops waiting for an answer after 5 seconds, not the model limit of 30 or 60', async () => {
    answers = fakeAiAnswers('no-answer');
    const { provider, client: ai } = providerClient('gemini');
    let settled = false;
    const pending = ai
      .generateStructured({
        contract: CLASSIFICATION_CONTRACT,
        model: recommendedModel(provider, 'detailed'),
        input: 'Synthetic mail',
      })
      .catch((err: ProviderFailure) => err)
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(FAKE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ kind: 'OUTCOME_UNKNOWN' });
  });

  const KEY_CHECKS: Partial<Record<FakeAiError, object>> = {
    key: { result: 'REJECTED', kind: 'KEY_REJECTED' },
    billing: { result: 'REJECTED', kind: 'ACCOUNT_OR_BILLING' },
    'model-gone': { result: 'REJECTED', kind: 'MODEL_UNAVAILABLE' },
    unusable: { result: 'VERIFIED' },
  };
  it.each(byProvider)(
    'the key check under %s from %s answers with the fault too',
    async (fault, providerId) => {
      answers = fakeAiAnswers(fault);
      const { provider, client: ai } = providerClient(providerId);
      const pending = ai.verifyModels([recommendedModel(provider, 'fast').id]);
      await vi.advanceTimersByTimeAsync(FAKE_TIMEOUT_MS);
      expect(await pending).toMatchObject(KEY_CHECKS[fault] ?? { result: 'INCONCLUSIVE' });
    },
  );
});

describe('each fake Gemini error through the email pipeline', () => {
  const OWNER = 'owner@fake-ai-errors.test';
  let userId: string;

  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { email: OWNER } });
    userId = (await prisma.user.create({ data: { email: OWNER } })).id;
  });
  beforeEach(async () => {
    vi.mocked(fetchMessageMetadata).mockResolvedValue({ labelIds: ['INBOX'], snippet: 'Hello' });
    vi.mocked(fetchMessageBody).mockResolvedValue('Synthetic interview invitation body');
    await configureAI(userId, { accessIssue: null, accessIssueModel: null });
    await prisma.aIModelPause.deleteMany({ where: { userId } });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: OWNER } });
  });

  /** Runs the mail's job; a fake "no answer" is settled by moving the clock while the job runs. */
  async function runJob(emailId: string) {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    let done = false;
    const job = processEmailJob({
      id: `job-${emailId}`,
      data: { userId, emailId },
      retryCount: 0,
      retryLimit: 3,
    } as JobWithMetadata<EmailProcessingJobData>)
      .catch(() => undefined)
      .finally(() => (done = true));
    while (!done) {
      await vi.advanceTimersByTimeAsync(500);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await job;
  }

  /** How long the model pauses, from the try (to the second): seconds, or until Google's daily reset. */
  const pauseOf = (until: Date | null | undefined, startedAt: Date | null) => {
    if (!until || !startedAt) return null;
    if (until.getTime() === nextPacificMidnight(startedAt).getTime()) return 'Pacific midnight';
    return Math.round((until.getTime() - startedAt.getTime()) / 1000);
  };
  const busy = { mail: 'PENDING', step: 'PENDING PROVIDER_BUSY', issue: 'PROVIDER_BUSY' };
  const rateLimited = { mail: 'PENDING', step: 'PENDING RATE_LIMITED', issue: 'RATE_LIMITED' };
  // No answer in time: the try is used, the mail waits, and the model pauses as for a busy provider.
  const noAnswer = { mail: 'PENDING', step: 'RETRYABLE OUTCOME_UNKNOWN', issue: 'PROVIDER_BUSY' };
  const waitsFor = (issue: string) => ({ mail: 'PENDING', step: `PENDING ${issue}`, issue });
  // What the mail, its first AI step and the user's or the model's AI state show after one fake error.
  it.each([
    ['busy', { ...busy, pause: 60 }],
    ['no-answer', { ...noAnswer, pause: 60 }],
    ['deadline', { ...noAnswer, pause: 60 }],
    ['rate-minute', { ...rateLimited, pause: 10 }],
    ['rate-day', { ...rateLimited, pause: 'Pacific midnight' }],
    ['key', { ...waitsFor('KEY_REJECTED'), pause: null }],
    ['billing', { ...waitsFor('ACCOUNT_OR_BILLING'), pause: null }],
    ['model-gone', { ...waitsFor('MODEL_UNAVAILABLE'), pause: null }],
    ['unusable', { mail: 'FAILED', step: 'FAILED INVALID_OUTPUT', issue: null, pause: null }],
    ['no-connection', { ...busy, pause: 60 }],
    ['line-dropped', { ...noAnswer, pause: 60 }],
    ['server-error', { ...busy, pause: 60 }],
  ] as const)('%s → %o', async (fault, expected) => {
    answers = fakeAiAnswers(fault);
    const { id: emailId } = await prisma.email.create({
      data: { userId, gmailMessageId: `fake-${fault}`, subject: 'Interview' },
    });
    await runJob(emailId);
    const email = await prisma.email.findUniqueOrThrow({ where: { id: emailId } });
    const operation = await prisma.aIOperation.findFirstOrThrow({ where: { emailId } });
    const config = await prisma.aIConfiguration.findUniqueOrThrow({ where: { userId } });
    const paused = await prisma.aIModelPause.findMany({ where: { userId } });
    // Only the model of the step that failed pauses.
    expect(paused.map((pause) => pause.model)).toEqual(
      expected.pause === null ? [] : [operation.model],
    );
    expect({
      mail: email.processingState,
      step: `${operation.status} ${operation.errorCode}`,
      issue: config.accessIssue ?? paused[0]?.reason ?? null,
      pause: pauseOf(paused[0]?.resumesAt, operation.startedAt),
    }).toEqual(expected);
  });
});

describe('the fake-error command never runs outside dev mode and sends nothing', () => {
  const root = path.resolve(__dirname, '../..');
  const DEV_DB = 'postgresql://u:p@127.0.0.1:1/fake_ai_errors_dev';
  // A child process stands in for the dev-mode server: the preload, then the real adapters.
  const SERVER = `
    const sent = [];
    globalThis.fetch = async (input) => { sent.push(String(input)); throw new Error('offline'); };
    const { createProviderClient } = require('./src/services/ai/providers');
    const { AI_CATALOG } = require('./src/contracts/aiCatalog');
    const { CLASSIFICATION_CONTRACT } = require('./src/services/ai/contracts');
    (async () => {
      const results = {};
      for (const provider of AI_CATALOG) {
        const client = createProviderClient(provider, 'fixture-key');
        const model = provider.models[0];
        const call = await client
          .generateStructured({ contract: CLASSIFICATION_CONTRACT, model, input: 'Synthetic' })
          .then(() => 'answered', (err) => err.kind);
        results[provider.id] = { call, check: (await client.verifyModels([model.id])).result };
      }
      console.log('RESULT ' + JSON.stringify({ results, sent }));
    })();
  `;
  const start = (env: Record<string, string>) =>
    spawnSync(
      process.execPath,
      [
        '-r',
        'ts-node/register/transpile-only',
        '-r',
        './scripts/fake-ai-errors-preload.cjs',
        '-e',
        SERVER,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 60_000,
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
      },
    );

  it.each([
    ['prod mode', { DATABASE_URL: DEV_DB }],
    ['APP_MODE=prod', { APP_MODE: 'prod', DATABASE_URL: DEV_DB }],
    ['NODE_ENV=production', { APP_MODE: 'dev', NODE_ENV: 'production', DATABASE_URL: DEV_DB }],
    [
      'a database that is not the dev database',
      { APP_MODE: 'dev', DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/career_companion' },
    ],
  ])('refuses to start in %s', (_label, env) => {
    const run = start({ ...env, FAKE_AI_ERROR: 'busy' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('refused: the app is not in dev mode');
    expect(run.stdout).not.toContain('RESULT');
  });

  it('refuses an unknown fault', () => {
    const run = start({ APP_MODE: 'dev', DATABASE_URL: DEV_DB, FAKE_AI_ERROR: 'nope' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('unknown fault "nope"');
  });

  it('in dev mode answers every AI call and key check with the fault, without any request', () => {
    const run = start({ APP_MODE: 'dev', DATABASE_URL: DEV_DB, FAKE_AI_ERROR: 'busy' });
    expect(run.status).toBe(0);
    const line = run.stdout.split('\n').find((text) => text.startsWith('RESULT '));
    expect(JSON.parse(line?.slice('RESULT '.length) ?? '{}')).toEqual({
      results: {
        gemini: { call: 'PROVIDER_BUSY', check: 'INCONCLUSIVE' },
        openai: { call: 'RATE_LIMITED', check: 'INCONCLUSIVE' },
        anthropic: { call: 'RATE_LIMITED', check: 'INCONCLUSIVE' },
      },
      sent: [],
    });
  });

  it('blocks every request to an AI provider and lets other requests through', async () => {
    const send = vi.fn(async () => new Response('ok'));
    const guarded = blockProviderRequests(send);
    for (const url of [
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
      new URL('https://api.openai.com/v1/chat/completions'),
      new Request('https://api.anthropic.com/v1/messages'),
    ])
      await expect(guarded(url)).rejects.toThrow('was blocked');
    expect(send).not.toHaveBeenCalled();
    await guarded('https://gmail.googleapis.com/gmail/v1/users/me/profile');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
