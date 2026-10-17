/**
 * The exact error in the API, end to end: the real pipeline, ledger, pauses and API with the real
 * Gemini adapter, only the AI library's call faked. Each mail says why it waits or stopped, the
 * exact failure, its tries and what happens next; the account says each model's state, the last
 * test mail and how many mails need the user's OK. Old rows get plain reasons from their stored
 * kind, never from stored text.
 */
import { Prisma } from '@prisma/client';
import type { JobWithMetadata } from 'pg-boss';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError } from '@google/genai';
import { AISettingsResponseSchema } from '../contracts/ai';
import { AIRetryApprovalDetailsSchema, EmailAIStatus } from '../contracts/email';
import { MessagesListResponseSchema } from '../contracts/gmail';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { processEmailJob } from '../jobs/emailProcessingJob';
import { AI_CONTRACT_VERSIONS } from '../services/ai/contracts';
import { runTriage } from '../services/ai/triage';
import { nextPacificMidnight, nextUtcMidnight, utcDay } from '../services/ai/usage';
import { EmailProcessingJobData } from '../services/enqueue';
import { fetchMessageBody, fetchMessageMetadata } from '../services/gmailFetcher';
import { configureAI, pauseOf } from './helpers/aiAccess';

const generateContent = vi.fn();
vi.mock('@google/genai', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  GoogleGenAI: vi.fn().mockImplementation(function () {
    return { models: { generateContent } };
  }),
}));
vi.mock('../services/gmailFetcher');
vi.mock('../services/queue', () => ({
  getQueue: vi.fn(async () => ({ send: vi.fn(async () => 'job-id'), cancel: vi.fn() })),
  stopQueue: vi.fn(),
}));

const EMAIL = 'owner@ai-error-api.test';
/** Fast screening: Gemini 3.5 Flash-Lite (30 s). Detailed analysis: Gemini 3.8 Flash (60 s). */
const FAST = 'gemini-3.5-flash-lite';
const DETAILED = 'gemini-3.8-flash';
let userId: string;

const relevant = {
  text: JSON.stringify({
    decision: 'RELEVANT',
    category: 'INTERVIEW',
    confidence: 0.95,
    reasoning: 'r',
  }),
};
const googleError = (status: number, error: object = {}) =>
  new ApiError({
    status,
    message: JSON.stringify({ error: { code: status, message: 'Provider text', ...error } }),
  });
const busy = () => googleError(503, { status: 'UNAVAILABLE' });
const noAnswer = () => new DOMException('This operation was aborted', 'AbortError');

const as = { 'X-Development-User': EMAIL };
const newEmail = async (day = 14) =>
  (
    await prisma.email.create({
      data: {
        userId,
        gmailMessageId: `error-api-${Math.random()}`,
        receivedAt: new Date(Date.UTC(2026, 9, day)),
      },
    })
  ).id;
const job = (emailId: string) =>
  ({
    id: `job-${emailId}`,
    data: { userId, emailId },
    retryCount: 0,
    retryLimit: 3,
  }) as JobWithMetadata<EmailProcessingJobData>;
/** Sorting works; reading the details fails as given. */
async function detailsFail(emailId: string, failure: unknown) {
  generateContent.mockResolvedValueOnce(relevant).mockRejectedValueOnce(failure);
  await processEmailJob(job(emailId));
}
const messages = async () =>
  MessagesListResponseSchema.parse(
    (await request(app).get('/api/gmail/messages').set(as).expect(200)).body,
  ).items;
const statusOf = async (emailId: string): Promise<EmailAIStatus | null | undefined> =>
  (await messages()).find((message) => message.id === emailId)?.aiStatus;
const settings = async () =>
  AISettingsResponseSchema.parse((await request(app).get('/api/ai/settings').set(as)).body);
const iso = (date: Date | null | undefined) => date?.toISOString();
/**
 * One model for both steps, so no fast model can take a detailed step while Gemini 3.8 Flash is
 * paused: the mail waits for it.
 */
const oneModel = () => configureAI(userId, { fastModel: DETAILED });

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  userId = (await prisma.user.create({ data: { email: EMAIL } })).id;
});
beforeEach(async () => {
  generateContent.mockReset();
  process.env.AI_USER_DAILY_CALL_LIMIT = '100';
  delete process.env.AI_TRIAGE_BATCH_ENABLED;
  vi.mocked(fetchMessageMetadata).mockResolvedValue({ labelIds: ['INBOX'], snippet: 'Hello' });
  vi.mocked(fetchMessageBody).mockResolvedValue('Synthetic interview invitation body');
  await prisma.email.deleteMany({ where: { userId } });
  await prisma.aIUsageDay.deleteMany({ where: { userId } });
  await configureAI(userId, { accessIssue: null, accessFailure: Prisma.DbNull, fastModel: null });
  await prisma.aIModelPause.deleteMany({ where: { userId } });
});
afterAll(async () => {
  delete process.env.AI_TRIAGE_BATCH_ENABLED;
  await prisma.user.deleteMany({ where: { email: EMAIL } });
});

describe('a mail that waits for AI', () => {
  it('Google busy: the row and the AI provider page name the model, the code and the next try', async () => {
    await oneModel();
    const emailId = await newEmail();
    await detailsFail(emailId, busy());
    const pause = await pauseOf(userId, DETAILED);

    // Row: "Waiting for AI". (i) "Gemini 3.8 Flash was busy (503 UNAVAILABLE)": Google answered
    // after a few seconds, no try used, next try about {resumesAt}, by itself.
    expect(await statusOf(emailId)).toEqual({
      reason: 'PROVIDER_BUSY',
      step: 'extraction',
      provider: 'gemini',
      model: DETAILED,
      failure: expect.objectContaining({
        kind: 'PROVIDER_BUSY',
        cause: 'PROVIDER_ANSWER',
        provider: 'gemini',
        model: DETAILED,
        httpStatus: 503,
        providerCode: 'UNAVAILABLE',
        waitedMs: expect.any(Number),
        timeoutMs: 60_000,
        attempt: null,
      }),
      attempts: 0,
      maxAttempts: 3,
      triedAt: [],
      nextTryAt: iso(pause!.resumesAt),
      nextStep: 'AUTOMATIC_RETRY',
      readNowTest: null,
    });

    // AI provider page: 3.8 Flash paused with its reason and code, for both steps it does here.
    const { access, waitingEmails, lastFailure } = await settings();
    expect(access).toMatchObject({
      state: 'LIMITED',
      reason: 'PROVIDER_BUSY',
      modelId: DETAILED,
      resumesAt: iso(pause!.resumesAt),
      failure: { kind: 'PROVIDER_BUSY', httpStatus: 503, providerCode: 'UNAVAILABLE' },
    });
    expect(access.pauses).toEqual([
      {
        model: DETAILED,
        roles: ['fast', 'detailed']
        reason: 'PROVIDER_BUSY',
        resumesAt: iso(pause!.resumesAt),
        failure: access.failure,
        test: null,
      },
    ]);
    expect(lastFailure).toEqual(access.failure);
    expect(waitingEmails).toBe(1);
  });

  it('no answer in time: says so with the model’s time limit and the measured wait, though it pauses as busy', async () => {
    await oneModel();
    const emailId = await newEmail();
    await detailsFail(emailId, noAnswer());
    // The pause is stored as for a busy provider; the API says what really happened.
    const pause = await pauseOf(userId, DETAILED);
    expect(pause!.reason).toBe('PROVIDER_BUSY');

    const status = await statusOf(emailId);
    expect(status).toMatchObject({
      reason: 'NO_ANSWER_IN_TIME',
      model: DETAILED,
      // "We waited 60 seconds ... That used try 1 of 3. Next try: about {next} (try 2 of 3)."
      failure: {
        kind: 'NO_ANSWER_IN_TIME',
        cause: 'TIMEOUT',
        timeoutMs: 60_000,
        attempt: 1,
        maxAttempts: 3,
      },
      attempts: 1,
      maxAttempts: 3,
      nextTryAt: iso(pause!.resumesAt),
      nextStep: 'AUTOMATIC_RETRY',
    });
    expect(status!.triedAt).toHaveLength(1);
    expect(status!.failure!.waitedMs).toBeGreaterThanOrEqual(0);

    // The account keeps the stored reason, so today's screens still read it; the failure says
    // what really happened.
    const { access } = await settings();
    expect(access).toMatchObject({
      reason: 'PROVIDER_BUSY',
      modelId: DETAILED,
      failure: { kind: 'NO_ANSWER_IN_TIME' },
    });
    expect(access.pauses).toMatchObject([
      {
        model: DETAILED,
        reason: 'PROVIDER_BUSY',
        failure: { kind: 'NO_ANSWER_IN_TIME', attempt: 1, timeoutMs: 60_000 },
      },
    ]);
  });

  it('no connection: says where it failed and the connection’s code', async () => {
    await oneModel();
    const emailId = await newEmail();
    const fetchFailed = (code: string) =>
      new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code }) });
    await detailsFail(emailId, fetchFailed('ENOTFOUND'));
    // "Could not reach Google Gemini. No connection at {time} (ENOTFOUND)." Nothing was sent.
    expect(await statusOf(emailId)).toMatchObject({
      reason: 'PROVIDER_BUSY',
      failure: { cause: 'NETWORK', networkCode: 'ENOTFOUND', httpStatus: null, attempt: null },
      attempts: 0,
      nextStep: 'AUTOMATIC_RETRY',
    });

    // The line dropped after sending: like no answer in time, it uses a try.
    await prisma.aIModelPause.deleteMany({ where: { userId } });
    generateContent.mockRejectedValueOnce(fetchFailed('ECONNRESET'));
    await processEmailJob(job(emailId));
    expect(await statusOf(emailId)).toMatchObject({
      reason: 'NO_ANSWER_IN_TIME',
      failure: { cause: 'NETWORK_AFTER_SEND', networkCode: 'ECONNRESET', attempt: 1 },
      attempts: 1,
    });
  });

  it('a daily free-tier limit gives the scope and waits until Google’s reset', async () => {
    await oneModel();
    const emailId = await newEmail();
    await detailsFail(
      emailId,
      googleError(429, {
        status: 'RESOURCE_EXHAUSTED',
        details: [
          { violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
        ],
      }),
    );
    const status = await statusOf(emailId);
    expect(status).toMatchObject({
      reason: 'RATE_LIMITED',
      failure: {
        httpStatus: 429,
        providerCode: 'RESOURCE_EXHAUSTED',
        quotaScope: 'PER_DAY',
        freeTier: true,
      },
      nextStep: 'AUTOMATIC_RETRY',
    });
    expect(new Date(status!.nextTryAt!).getTime()).toBe(
      nextPacificMidnight(new Date(status!.failure!.at)).getTime(),
    );
  });

  it('a newer pause of another kind is the reason, not the mail’s own older failure', async () => {
    await oneModel();
    const older = await newEmail(14);
    const newer = await newEmail(13);
    await detailsFail(older, busy());
    // The busy pause ends; another mail then uses up the daily free-tier limit.
    await prisma.aIModelPause.deleteMany({ where: { userId } });
    await detailsFail(
      newer,
      googleError(429, {
        status: 'RESOURCE_EXHAUSTED',
        details: [
          { violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
        ],
      }),
    );
    const pause = await pauseOf(userId, DETAILED);
    expect(pause!.reason).toBe('RATE_LIMITED');

    // Held back by the daily limit before any call; it still keeps its own busy failure.
    await processEmailJob(job(older));
    expect(generateContent).toHaveBeenCalledTimes(4);
    expect(
      await prisma.aIOperation.findFirstOrThrow({
        where: { emailId: older, operation: 'extraction' },
      }),
    ).toMatchObject({ lastFailure: expect.objectContaining({ kind: 'PROVIDER_BUSY' }) });

    // "Free-tier daily limit for Gemini 3.8 Flash. Next try about {reset}", not "was busy".
    expect(await statusOf(older)).toMatchObject({
      reason: 'RATE_LIMITED',
      model: DETAILED,
      failure: null,
      nextTryAt: iso(pause!.resumesAt),
      nextStep: 'AUTOMATIC_RETRY',
    });
  });

  it('a key Google rejects names the code on the account; the mail waits for the settings', async () => {
    const emailId = await newEmail();
    await detailsFail(
      emailId,
      googleError(400, { status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] }),
    );
    expect((await settings()).access).toMatchObject({
      state: 'NEEDS_ATTENTION',
      reason: 'KEY_REJECTED',
      failure: { kind: 'KEY_REJECTED', httpStatus: 400, providerCode: 'API_KEY_INVALID' },
      pauses: [],
    });
    expect(await statusOf(emailId)).toMatchObject({
      reason: 'KEY_REJECTED',
      failure: { providerCode: 'API_KEY_INVALID' },
      nextTryAt: null,
      nextStep: 'FIX_AI_SETTINGS',
    });
  });

  it('Career Companion’s own daily limit continues by itself at midnight UTC', async () => {
    process.env.AI_USER_DAILY_CALL_LIMIT = '1';
    const emailId = await newEmail();
    await prisma.aIUsageDay.create({ data: { userId, day: utcDay(new Date()), calls: 1 } });
    expect(await statusOf(emailId)).toMatchObject({
      reason: 'SAFETY_LIMIT',
      step: 'classification',
      failure: null,
      nextTryAt: iso(nextUtcMidnight(new Date())),
      nextStep: 'AUTOMATIC_RETRY',
    });
  });

  it('a mail in line with nothing to explain has no status', async () => {
    const emailId = await newEmail();
    expect(await statusOf(emailId)).toBeNull();
  });

  it('a mail a batch answer left out keeps no reason from an earlier try', async () => {
    process.env.AI_TRIAGE_BATCH_ENABLED = 'true';
    const emailId = await newEmail();
    generateContent.mockRejectedValueOnce(busy());
    await runTriage(userId);
    expect(await statusOf(emailId)).toMatchObject({ reason: 'PROVIDER_BUSY' });

    await prisma.aIModelPause.deleteMany({ where: { userId } });
    generateContent.mockResolvedValueOnce({ text: JSON.stringify({ results: [] }) });
    await runTriage(userId);
    expect(await prisma.aIOperation.findFirstOrThrow({ where: { emailId } })).toMatchObject({
      status: 'RETRYABLE',
      errorCode: 'BATCH_ITEM_MISSING',
      lastFailure: null,
    });
    // In line again: Google answered, so the earlier busy answer is not its reason any more.
    expect(await statusOf(emailId)).toBeNull();
  });
});

describe('"Read waiting mails now"', () => {
  it('names the test mail, its result, and the mail that waits for it', async () => {
    await oneModel();
    const test = await newEmail(14);
    const other = await newEmail(13);
    await detailsFail(test, busy());
    // Held back by the 3.8 Flash pause before any call.
    await processEmailJob(job(other));
    expect(await statusOf(other)).toMatchObject({
      reason: 'PROVIDER_BUSY',
      provider: 'gemini',
      model: DETAILED,
      failure: null,
      attempts: 0,
      readNowTest: null,
    });

    const read = await request(app).post('/api/ai/waiting/read').set(as).send({}).expect(200);
    expect(read.body.access.pauses).toMatchObject([
      { model: DETAILED, test: { emailId: test, result: null } },
    ]);
    // Sent as the test, waiting for the answer.
    expect(await statusOf(test)).toMatchObject({ readNowTest: 'TEST_MAIL', nextTryAt: null });

    generateContent.mockRejectedValueOnce(busy());
    await processEmailJob(job(test));
    const pause = await pauseOf(userId, DETAILED);
    // "This was the test mail: still busy. Sent at {time}. Google answered 503 UNAVAILABLE."
    expect(await statusOf(test)).toMatchObject({
      reason: 'PROVIDER_BUSY',
      failure: { httpStatus: 503, providerCode: 'UNAVAILABLE', attempt: null },
      nextTryAt: iso(pause!.resumesAt),
      nextStep: 'AUTOMATIC_RETRY',
      readNowTest: 'TEST_MAIL',
    });
    // "Not sent yet: waits for the test mail."
    expect(await statusOf(other)).toMatchObject({
      nextStep: 'WAITS_FOR_TEST_MAIL',
      readNowTest: 'WAITS_FOR_TEST_MAIL',
    });
    // "Tried 1 test mail at {time}: Google answered 503 UNAVAILABLE."
    const { access } = await settings();
    expect(access.pauses).toMatchObject([
      {
        model: DETAILED,
        reason: 'PROVIDER_BUSY',
        failure: { httpStatus: 503, providerCode: 'UNAVAILABLE' },
        test: { emailId: test, startedAt: iso(pause!.testStartedAt), result: 'PROVIDER_BUSY' },
      },
    ]);
  });
});

describe('a mail that stopped', () => {
  it('after 3 tries with no answer it needs the user’s OK, with the time of each try', async () => {
    await oneModel();
    const emailId = await newEmail();
    await detailsFail(emailId, noAnswer());
    for (let i = 0; i < 2; i++) {
      // The pause ends and the mail is tried again by itself.
      await prisma.aIModelPause.deleteMany({ where: { userId } });
      generateContent.mockRejectedValueOnce(noAnswer());
      await processEmailJob(job(emailId));
    }
    const { triedAt } = await prisma.aIOperation.findFirstOrThrow({
      where: { emailId, operation: 'extraction' },
    });
    const tries = triedAt.map((at) => at.toISOString());
    expect(tries).toHaveLength(3);
    expect([...tries].sort()).toEqual(tries);

    // Row: "Needs your OK". (i) "Gemini 3.8 Flash did not answer 3 times. No answer within 60
    // seconds at {tries}." Next: waits for you. Use Manual Retry.
    expect(await statusOf(emailId)).toMatchObject({
      reason: 'NO_ANSWER_IN_TIME',
      step: 'extraction',
      model: DETAILED,
      failure: { kind: 'NO_ANSWER_IN_TIME', timeoutMs: 60_000, attempt: 3 },
      attempts: 3,
      maxAttempts: 3,
      triedAt: tries,
      nextTryAt: null,
      nextStep: 'RETRY_WITH_YOUR_OK',
    });
    // Banner: "1 email needs your OK · Gemini 3.8 Flash did not answer it 3 times, the last at …"
    expect((await settings()).needsYourOk).toEqual({
      emails: 1,
      model: DETAILED,
      lastTriedAt: tries[2],
      tries: 3,
    });
    // Retry dialog: sent 3 times, at …; each time no answer within 60 seconds.
    const retry = await request(app).post(`/api/emails/${emailId}/retry`).set(as).send({});
    expect(retry.status).toBe(409);
    expect(AIRetryApprovalDetailsSchema.parse(retry.body.error.details)).toMatchObject({
      operations: [
        {
          operation: 'extraction',
          reason: 'ATTEMPTS_EXHAUSTED',
          model: DETAILED,
          triedAt: tries,
          failure: { kind: 'NO_ANSWER_IN_TIME', timeoutMs: 60_000 },
        },
      ],
    });

    // After the user's OK the mail stays stopped until the worker picks it up: it is tried again
    // by itself, once more, and no longer needs the user's OK.
    await prisma.aIModelPause.deleteMany({ where: { userId } });
    await request(app)
      .post(`/api/emails/${emailId}/retry`)
      .set(as)
      .send({ acceptPossibleDuplicateCharge: true })
      .expect(200);
    expect(await statusOf(emailId)).toMatchObject({
      reason: 'NO_ANSWER_IN_TIME',
      step: 'extraction',
      attempts: 3,
      maxAttempts: 4,
      nextTryAt: null,
      nextStep: 'AUTOMATIC_RETRY',
    });
    expect((await settings()).needsYourOk.emails).toBe(0);

    // If that try then fails in our own code, the mail does not wait for the worker any more.
    await prisma.email.update({
      where: { id: emailId },
      data: { processingErrorCategory: 'ProcessingError' },
    });
    expect(await statusOf(emailId)).toMatchObject({ nextStep: 'MANUAL_RETRY' });
  });

  it('an unusable answer says why Google stopped early, and is not counted as needing an OK', async () => {
    const emailId = await newEmail();
    generateContent.mockResolvedValueOnce(relevant).mockResolvedValueOnce({
      text: '{"companyName": "North',
      candidates: [{ finishReason: 'MAX_TOKENS' }],
    });
    await processEmailJob(job(emailId));
    // "AI could not read it" + Manual Retry. (i) "… could not use (stopped early: MAX_TOKENS)."
    expect(await statusOf(emailId)).toMatchObject({
      reason: 'INVALID_OUTPUT',
      failure: { kind: 'INVALID_OUTPUT', stopReason: 'MAX_TOKENS', attempt: 1 },
      nextStep: 'RETRY_WITH_YOUR_OK',
    });
    expect((await settings()).needsYourOk.emails).toBe(0);
  });

  it('a request Google refuses is ours to retry', async () => {
    const emailId = await newEmail();
    await detailsFail(emailId, googleError(400, { status: 'INVALID_ARGUMENT' }));
    // "Career Companion sent a request Google refused (400 INVALID_ARGUMENT)."
    expect(await statusOf(emailId)).toMatchObject({
      reason: 'INVALID_REQUEST',
      failure: { httpStatus: 400, providerCode: 'INVALID_ARGUMENT' },
      nextStep: 'CAREER_COMPANION',
    });
  });

  it('a mail that failed in batch sorting gets a plain reason', async () => {
    process.env.AI_TRIAGE_BATCH_ENABLED = 'true';
    const emailId = await newEmail();
    generateContent.mockRejectedValueOnce(googleError(504, { status: 'DEADLINE_EXCEEDED' }));
    await runTriage(userId);
    const email = await prisma.email.findUniqueOrThrow({ where: { id: emailId } });
    // Batch rules are unchanged: held at once, and no stored text.
    expect(email).toMatchObject({ processingState: 'FAILED', processingErrorDetails: null });
    expect(await statusOf(emailId)).toMatchObject({
      reason: 'NO_ANSWER_IN_TIME',
      step: 'classification',
      model: FAST,
      failure: { cause: 'PROVIDER_DEADLINE', httpStatus: 504, timeoutMs: 30_000 },
      attempts: 1,
      nextStep: 'RETRY_WITH_YOUR_OK',
    });
    expect(
      (await prisma.aIOperation.findFirstOrThrow({ where: { emailId } })).triedAt,
    ).toHaveLength(1);
    // Banner: held after its one try, so it says 1 time, not 3.
    expect((await settings()).needsYourOk).toMatchObject({ emails: 1, model: FAST, tries: 1 });
  });

  it('a batch that failed on our own error says so, and does not need the user’s OK', async () => {
    process.env.AI_TRIAGE_BATCH_ENABLED = 'true';
    const emailId = await newEmail();
    generateContent.mockRejectedValueOnce(new Error('bug'));
    await runTriage(userId);
    // Batch rules are unchanged: held at once.
    expect(await prisma.aIOperation.findFirstOrThrow({ where: { emailId } })).toMatchObject({
      status: 'UNKNOWN',
    });
    expect(await statusOf(emailId)).toMatchObject({
      reason: 'INTERNAL_ERROR',
      step: 'classification',
      failure: { kind: 'INTERNAL_ERROR', cause: 'UNCLASSIFIED', httpStatus: null },
    });
    expect((await settings()).needsYourOk.emails).toBe(0);
  });

  it('old mails get plain reasons from the stored kind, never from the stored text', async () => {
    const STORED = 'AI provider outcome unknown; reconciliation required';
    const failed = async (op: object, category = 'OutcomeUnknown') => {
      const emailId = await newEmail();
      await prisma.email.update({
        where: { id: emailId },
        data: {
          processingState: 'FAILED',
          processingErrorCategory: category,
          processingErrorDetails: STORED,
          processingErrorStage: 'classification',
        },
      });
      if (Object.keys(op).length)
        await prisma.aIOperation.create({
          data: {
            emailId,
            operation: 'classification',
            version: AI_CONTRACT_VERSIONS.CLASSIFICATION,
            attempts: 1,
            provider: 'gemini',
            model: FAST,
            ...op,
          },
        });
      return emailId;
    };
    const unknown = await failed({ status: 'UNKNOWN', errorCode: 'OUTCOME_UNKNOWN' });
    const unusable = await failed(
      { status: 'FAILED', errorCode: 'SchemaValidationFailure' },
      'SchemaValidationFailure',
    );
    const refused = await failed({ status: 'FAILED', errorCode: 'INVALID_REQUEST' });
    const gmail = await failed({}, 'GmailRequestFailed');
    const lost = await failed({});

    expect(await statusOf(unknown)).toMatchObject({
      reason: 'NO_ANSWER_IN_TIME',
      model: FAST,
      failure: null,
      triedAt: [],
      nextStep: 'RETRY_WITH_YOUR_OK',
    });
    expect(await statusOf(unusable)).toMatchObject({
      reason: 'INVALID_OUTPUT',
      nextStep: 'RETRY_WITH_YOUR_OK',
    });
    expect(await statusOf(refused)).toMatchObject({
      reason: 'INVALID_REQUEST',
      nextStep: 'CAREER_COMPANION',
    });
    expect(await statusOf(gmail)).toMatchObject({
      reason: 'GMAIL_FAILED',
      step: null,
      nextStep: 'MANUAL_RETRY',
    });
    // No AI step left to say more: the stored kind still gives the reason.
    expect(await statusOf(lost)).toMatchObject({
      reason: 'NO_ANSWER_IN_TIME',
      step: null,
      failure: null,
      nextStep: 'MANUAL_RETRY',
    });
    const statuses = (await messages()).map((message) => message.aiStatus);
    expect(JSON.stringify(statuses)).not.toContain('reconciliation');
    expect((await settings()).needsYourOk).toMatchObject({ emails: 1, model: FAST, tries: 1 });
  });
});

describe('a check or sample test that does not finish', () => {
  it('a key check Google did not confirm says why', async () => {
    generateContent.mockRejectedValueOnce(busy());
    const res = await request(app).post('/api/ai/settings/check').set(as).send({}).expect(200);
    expect(res.body).toMatchObject({
      verification: 'INCONCLUSIVE',
      verificationFailure: {
        kind: 'PROVIDER_BUSY',
        model: FAST,
        httpStatus: 503,
        providerCode: 'UNAVAILABLE',
        timeoutMs: 10_000,
      },
    });
    generateContent.mockResolvedValue({ text: 'OK' });
    const verified = await request(app).post('/api/ai/settings/check').set(as).send({});
    expect(verified.body).toMatchObject({ verification: 'VERIFIED', verificationFailure: null });
  });

  it('the sample test says which model did not answer and how long it waited', async () => {
    generateContent.mockResolvedValueOnce(relevant).mockRejectedValueOnce(noAnswer());
    const res = await request(app).post('/api/ai/settings/sample-test').set(as).send({});
    expect(res.status).toBe(502);
    // "The sample test did not finish: Gemini 3.8 Flash did not answer within 60 seconds."
    expect(res.body.error).toMatchObject({
      code: 'AI_SAMPLE_FAILED',
      details: {
        failure: {
          kind: 'NO_ANSWER_IN_TIME',
          model: DETAILED,
          timeoutMs: 60_000,
          waitedMs: expect.any(Number),
        },
      },
    });

    generateContent.mockResolvedValueOnce(relevant).mockRejectedValueOnce(busy());
    const paused = await request(app).post('/api/ai/settings/sample-test').set(as).send({});
    expect(paused.status).toBe(409);
    expect(paused.body.error.details).toMatchObject({
      reason: 'PROVIDER_BUSY',
      modelId: DETAILED,
      failure: { model: DETAILED, httpStatus: 503 },
    });
  });
});

/**
 * The frontend's copy of the settings response on main before this work (its src/contracts/ai.ts).
 * It parses the answer of GET /api/ai/settings, "Read waiting mails now", save and check: it drops
 * new fields, but a new value in an enum it knows breaks the AI provider page.
 */
const IsoDateTime = z.iso.datetime({ offset: true });
const ModelInUseSchema = z.object({
  id: z.string(),
  source: z.enum(['RECOMMENDED', 'SELECTED', 'REPLACED_RETIRED']),
});
const FrontendMainSettingsSchema = z.object({
  configured: z.boolean(),
  provider: z.string().nullable(),
  offeredProviders: z.array(z.string()),
  models: z.object({ fast: ModelInUseSchema, detailed: ModelInUseSchema }).nullable(),
  access: z.object({
    state: z.enum(['NOT_SET_UP', 'READY', 'NEEDS_ATTENTION', 'LIMITED']),
    reason: z
      .enum([
        'NOT_SET_UP',
        'KEY_REJECTED',
        'ACCOUNT_OR_BILLING',
        'MODEL_UNAVAILABLE',
        'PROVIDER_UNSUPPORTED',
        'KEY_UNREADABLE',
        'RATE_LIMITED',
        'PROVIDER_BUSY',
        'PROVIDER_UNAVAILABLE',
        'SAFETY_LIMIT',
        'PAUSED',
      ])
      .nullable(),
    modelId: z.string().nullable(),
    resumesAt: IsoDateTime.nullable(),
    verified: z.boolean(),
    lastCheckedAt: IsoDateTime.nullable(),
  }),
  usageToday: z.object({
    day: z.string(),
    calls: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
  }),
  safetyLimit: z.object({ callsPerDay: z.number().int(), resetsAt: IsoDateTime }),
  waitingEmails: z.number().int(),
  consent: z
    .object({ disclosure: z.string(), consentedAt: IsoDateTime, current: z.boolean() })
    .nullable(),
});

describe('the frontend on main', () => {
  it('still reads the AI settings while a model is paused after no answer in time', async () => {
    await detailsFail(await newEmail(), noAnswer());
    const { body } = await request(app).get('/api/ai/settings').set(as).expect(200);
    expect(body.access).toMatchObject({
      state: 'LIMITED',
      reason: 'PROVIDER_BUSY',
      failure: { kind: 'NO_ANSWER_IN_TIME' },
    });
    expect(FrontendMainSettingsSchema.safeParse(body).error).toBeUndefined();
  });
});
