// COM-278: full automation details (ADR-0002 amendment, 21 Oct 2026), through the real /mcp
// endpoint with the official SDK client and the session-authenticated routes.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import { AddressInfo } from 'net';
import { Server } from 'http';
import request from 'supertest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { createIntegrationToken } from '../services/integrationTokens';
import {
  ListApplicationSubmissionsResponseSchema,
  ListApplicationsResponseSchema,
  ListNotSubmittedJobsResponseSchema,
  McpConnectionResponseSchema,
} from '../contracts';

const DOMAIN = '@automation-details.test';
let owner: string;
let foreign: string;
let token: string;
let ownCookie: string;
let otherCookie: string;
let server: Server;
let baseUrl: string;
let client: Client;

const answers = [
  { question: 'What is your notice period?', answer: '30 days' },
  { question: 'Expected CTC (LPA)?', answer: '15' },
];
const submission = {
  sourceRecordRef: '2026-10-20/14:14:05',
  platform: 'linkedin',
  company: 'Details Co',
  jobTitle: 'Frontend Engineer',
  submittedAt: '2026-10-20T14:14:05+05:30',
  jobUrl: 'https://www.linkedin.com/jobs/view/123/?trk=feed&currentJobId=123',
  location: 'Bengaluru',
};
const full = {
  ...submission,
  applyUrl: 'https://user:pw@jobs.example.com/apply/123?step=2&src=wwr#review',
  resumeFilename: 'Resume.pdf',
  submittedAnswers: answers,
};
const notSubmitted = {
  sourceRecordRef: '2026-10-20/15:00:00',
  outcome: 'needs_user',
  platform: 'workday',
  company: 'Skipped Labs',
  jobTitle: 'React Developer',
  loggedAt: '2026-10-20T15:00:00+05:30',
  reason: 'Required question with no saved answer: "Night shifts?"',
};

const signSid = (sid: string, secret: string) =>
  `${sid}.${crypto.createHmac('sha256', secret).update(sid).digest('base64').replace(/=+$/, '')}`;
async function sessionCookie(userId: string) {
  const sid = crypto.randomUUID();
  await prisma.session.create({
    data: {
      sid,
      sess: { cookie: { originalMaxAge: 86_400_000, httpOnly: true, path: '/' }, userId },
      expire: new Date(Date.now() + 2 * 86_400_000),
    },
  });
  return `cc_session=${encodeURIComponent(`s:${signSid(sid, process.env.SESSION_SECRET!)}`)}`;
}
const read = (path: string, cookie = ownCookie) => request(app).get(path).set('Cookie', cookie);
const record = (args: Record<string, unknown>) =>
  client.callTool({ name: 'record_application_submission', arguments: args });
const recordNotSubmitted = (args: Record<string, unknown>) =>
  client.callTool({ name: 'record_not_submitted_job', arguments: args });
const errorOf = (result: Awaited<ReturnType<typeof record>>) =>
  JSON.parse((result.content as { text: string }[])[0].text);

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  owner = (await prisma.user.create({ data: { email: `owner${DOMAIN}` } })).id;
  foreign = (await prisma.user.create({ data: { email: `foreign${DOMAIN}` } })).id;
  ownCookie = await sessionCookie(owner);
  otherCookie = await sessionCookie(foreign);
  token = (await createIntegrationToken(owner, { name: 'laptop' })).plaintextToken;
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  client = new Client({ name: 'cc-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
});
beforeEach(async () => {
  delete process.env.MCP_DAILY_SUBMISSION_LIMIT;
  delete process.env.MCP_ALLOWED_HOSTS;
  await prisma.externalSubmission.deleteMany({ where: { userId: { in: [owner, foreign] } } });
  await prisma.notSubmittedJob.deleteMany({ where: { userId: { in: [owner, foreign] } } });
  await prisma.application.deleteMany({ where: { userId: { in: [owner, foreign] } } });
});
afterAll(async () => {
  await client.close();
  await new Promise((r) => server.close(r));
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
});

describe('new submission fields', () => {
  it('stores the apply page link, resume file name and answers', async () => {
    expect((await record(full)).structuredContent).toMatchObject({ result: 'created' });
    const stored = await prisma.externalSubmission.findFirstOrThrow({ where: { userId: owner } });
    // Full link with its query; the fragment and credentials are dropped.
    expect(stored.applyUrl).toBe('https://jobs.example.com/apply/123?step=2&src=wwr');
    expect(stored.resumeFilename).toBe('Resume.pdf');
    expect(stored.submittedAnswers).toEqual(answers);
  });

  it.each([
    ['submittedAnswers', { submittedAnswers: Array(51).fill(answers[0]) }],
    ['submittedAnswers', { submittedAnswers: [{ question: 'q'.repeat(501), answer: 'a' }] }],
    ['submittedAnswers', { submittedAnswers: [{ question: 'q', answer: 'a'.repeat(2001) }] }],
    ['submittedAnswers', { submittedAnswers: [{ question: '', answer: 'a' }] }],
    ['submittedAnswers', { submittedAnswers: [{ question: 'q', answer: 'a', note: 'x' }] }],
    ['resumeFilename', { resumeFilename: 'r'.repeat(256) }],
    ['applyUrl', { applyUrl: 'ftp://jobs.example.com/apply' }],
  ])('refuses %s over its limit or in a wrong shape', async (field, extra) => {
    const result = await record({ ...submission, ...extra });
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({ code: 'invalid_input', fields: [field] });
    expect(await prisma.externalSubmission.count({ where: { userId: owner } })).toBe(0);
  });

  it('accepts no answers at all and stores none', async () => {
    await record({ ...submission, submittedAnswers: [] });
    const stored = await prisma.externalSubmission.findFirstOrThrow({ where: { userId: owner } });
    expect(stored.submittedAnswers).toBeNull();
  });
});

describe('a repeat of the same entry', () => {
  it('is logged as unchanged when it is the same entry', async () => {
    await record(full);
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      expect((await record(full)).structuredContent).toMatchObject({ result: 'already_recorded' });
    } finally {
      spy.mockRestore();
    }
    const line = lines.find((l) => l.includes('mcp_request') && l.includes('already_recorded'));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/payloadDiffered"?[=:]\s*true/);
  });

  it('fills only empty fields and never changes saved ones', async () => {
    await record({ ...submission, jobUrl: undefined });
    const repeat = await record({
      ...full,
      location: 'Pune',
      company: 'Other Co',
      submittedAnswers: [{ question: 'Changed?', answer: 'yes' }],
    });
    expect(repeat.structuredContent).toMatchObject({ result: 'already_recorded' });
    const stored = await prisma.externalSubmission.findFirstOrThrow({ where: { userId: owner } });
    expect(stored).toMatchObject({
      location: 'Bengaluru',
      company: 'Details Co',
      jobUrl: 'https://www.linkedin.com/jobs/view/123/?currentJobId=123',
      resumeFilename: 'Resume.pdf',
      submittedAnswers: [{ question: 'Changed?', answer: 'yes' }],
    });
    const again = await record({ ...full, submittedAnswers: answers, resumeFilename: 'New.pdf' });
    expect(again.structuredContent).toMatchObject({ result: 'already_recorded' });
    expect(
      await prisma.externalSubmission.findFirstOrThrow({ where: { userId: owner } }),
    ).toMatchObject({
      resumeFilename: 'Resume.pdf',
      submittedAnswers: [{ question: 'Changed?', answer: 'yes' }],
    });
    expect(await prisma.application.count({ where: { userId: owner } })).toBe(1);
  });
});

describe('application responses', () => {
  it('carry platform, job link and time for automation rows only', async () => {
    await prisma.application.create({ data: { userId: owner, companyName: 'Manual Co' } });
    await record(full);
    const list = ListApplicationsResponseSchema.parse((await read('/api/applications')).body);
    const byName = Object.fromEntries(list.items.map((a) => [a.companyName, a]));
    expect(byName['Manual Co'].automation).toBeNull();
    expect(byName['Details Co'].automation).toEqual({
      platform: 'linkedin',
      jobUrl: 'https://www.linkedin.com/jobs/view/123/?currentJobId=123',
      submittedAt: '2026-10-20T08:44:05.000Z',
    });
    const detail = await read(`/api/applications/${byName['Details Co'].id}`);
    expect(detail.body.automation).toEqual(byName['Details Co'].automation);
  });

  it('use the newest linked submission and never one still under review', async () => {
    await record(full);
    const application = await prisma.application.findFirstOrThrow({ where: { userId: owner } });
    await record({
      ...submission,
      sourceRecordRef: '2026-10-21/09:00:00',
      submittedAt: '2026-10-21T09:00:00+05:30',
      platform: 'naukri',
    });
    const linked = await read(`/api/applications/${application.id}`);
    expect(linked.body.automation).toMatchObject({ platform: 'naukri' });
    await prisma.application.create({
      data: { userId: owner, companyName: 'Details Co', jobTitle: null },
    });
    await record({
      ...submission,
      sourceRecordRef: '2026-10-22/09:00:00',
      submittedAt: '2026-10-22T09:00:00+05:30',
      platform: 'indeed',
    });
    expect((await read(`/api/applications/${application.id}`)).body.automation).toMatchObject({
      platform: 'naukri',
    });
  });

  it('list every detail of the submissions behind one application, owner only', async () => {
    await record(full);
    const application = await prisma.application.findFirstOrThrow({ where: { userId: owner } });
    const res = await read(`/api/applications/${application.id}/submissions`);
    expect(res.status).toBe(200);
    const body = ListApplicationSubmissionsResponseSchema.parse(res.body);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      matchState: 'CREATED',
      platform: 'linkedin',
      location: 'Bengaluru',
      applyUrl: 'https://jobs.example.com/apply/123?step=2&src=wwr',
      resumeFilename: 'Resume.pdf',
      submittedAnswers: answers,
      submittedAt: '2026-10-20T08:44:05.000Z',
    });
    expect(
      (await read(`/api/applications/${application.id}/submissions`, otherCookie)).status,
    ).toBe(403);
    const manual = await prisma.application.create({ data: { userId: owner, companyName: 'M' } });
    expect((await read(`/api/applications/${manual.id}/submissions`)).body).toEqual({ items: [] });
    expect((await request(app).get(`/api/applications/${application.id}/submissions`)).status).toBe(
      401,
    );
  });
});

describe('jobs not submitted', () => {
  it('are recorded apart from applications, once per entry', async () => {
    const first = await recordNotSubmitted(notSubmitted);
    expect(first.structuredContent).toEqual({ result: 'recorded', recordId: expect.any(String) });
    const repeat = await recordNotSubmitted({
      ...notSubmitted,
      reason: 'changed',
      jobUrl: 'https://jobs.example.com/9#x',
    });
    expect(repeat.structuredContent).toEqual({
      result: 'already_recorded',
      recordId: (first.structuredContent as { recordId: string }).recordId,
    });
    const stored = await prisma.notSubmittedJob.findFirstOrThrow({ where: { userId: owner } });
    expect(stored).toMatchObject({
      outcome: 'NEEDS_USER',
      reason: notSubmitted.reason,
      jobUrl: 'https://jobs.example.com/9',
    });
    expect(await prisma.application.count({ where: { userId: owner } })).toBe(0);
    expect(await prisma.externalSubmission.count({ where: { userId: owner } })).toBe(0);
  });

  it.each([
    ['outcome', { outcome: 'applied' }],
    ['reason', { reason: '' }],
    ['reason', { reason: 'r'.repeat(1001) }],
    ['loggedAt', { loggedAt: '2099-01-01T00:00:00Z' }],
    ['submittedAnswers', { submittedAnswers: answers }],
  ])('refuses a wrong %s', async (field, extra) => {
    const result = await recordNotSubmitted({ ...notSubmitted, ...extra });
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({ code: 'invalid_input', fields: [field] });
  });

  it('keep their own daily limit', async () => {
    process.env.MCP_DAILY_SUBMISSION_LIMIT = '1';
    await recordNotSubmitted(notSubmitted);
    const over = await recordNotSubmitted({
      ...notSubmitted,
      sourceRecordRef: '2026-10-20/15:01:00',
    });
    expect(errorOf(over)).toMatchObject({ code: 'rate_limited' });
    expect((await record(full)).structuredContent).toMatchObject({ result: 'created' });
  });

  it('are listed newest entry first, owner only', async () => {
    await recordNotSubmitted(notSubmitted);
    await recordNotSubmitted({
      ...notSubmitted,
      sourceRecordRef: '2026-10-20/16:00:00',
      loggedAt: '2026-10-20T16:00:00+05:30',
      outcome: 'skipped',
      reason: 'Not a fit',
    });
    const body = ListNotSubmittedJobsResponseSchema.parse(
      (await read('/api/submissions/not-submitted')).body,
    );
    expect(body.items.map((job) => [job.outcome, job.reason])).toEqual([
      ['SKIPPED', 'Not a fit'],
      ['NEEDS_USER', notSubmitted.reason],
    ]);
    expect(body.items[1].loggedAt).toBe('2026-10-20T09:30:00.000Z');
    expect((await read('/api/submissions/not-submitted', otherCookie)).body.items).toEqual([]);
  });
});

describe('connection address', () => {
  it('names the first allowed MCP host, or nothing when none is set', async () => {
    expect(
      McpConnectionResponseSchema.parse((await read('/api/integration-tokens/connection')).body),
    ).toEqual({ serverAddress: null });
    process.env.MCP_ALLOWED_HOSTS = 'cc-api.example.com,other.example.com';
    expect((await read('/api/integration-tokens/connection')).body).toEqual({
      serverAddress: 'https://cc-api.example.com',
    });
    expect((await request(app).get('/api/integration-tokens/connection')).status).toBe(401);
  });
});
