// MCP-03: automation submission intake (ADR-0002 decisions 5–8), domain only.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import {
  SubmissionIntakeError,
  canonicalJobUrl,
  companyKey,
  decideMatch,
  parseSubmissionInput,
  recordSubmission,
  titleKey,
} from '../services/externalSubmission';

const DOMAIN = '@mcp-intake.test';
let owner: string;
let other: string;
let tokenId: string;

const base = {
  sourceRecordRef: '2026-10-02/09:15:00',
  platform: 'linkedin',
  company: 'Acme',
  jobTitle: 'Backend Engineer',
  submittedAt: '2026-10-01T09:15:00+05:30',
};
const submit = (overrides: Record<string, unknown> = {}, userId = owner) =>
  recordSubmission(userId, userId === owner ? tokenId : null, { ...base, ...overrides });
const application = (data: Partial<Prisma.ApplicationUncheckedCreateInput> & { companyName: string }, userId = owner) =>
  prisma.application.create({ data: { userId, ...data } });
async function intakeError(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (err) {
    if (err instanceof SubmissionIntakeError) return err;
    throw err;
  }
  throw new Error('expected a SubmissionIntakeError');
}

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  owner = (await prisma.user.create({ data: { email: `owner${DOMAIN}` } })).id;
  other = (await prisma.user.create({ data: { email: `other${DOMAIN}` } })).id;
  tokenId = (
    await prisma.integrationToken.create({
      data: {
        userId: owner,
        name: 'laptop',
        tokenHash: 'a'.repeat(64),
        displayPrefix: 'ccmcp_aaaaaa',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    })
  ).id;
});
beforeEach(async () => {
  await prisma.externalSubmission.deleteMany({ where: { userId: { in: [owner, other] } } });
  await prisma.application.deleteMany({ where: { userId: { in: [owner, other] } } });
});
afterEach(() => {
  delete process.env.MCP_DAILY_SUBMISSION_LIMIT;
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
});

describe('keys', () => {
  it.each([
    ['Acme', 'acme'],
    ['Acme Inc.', 'acme'],
    ['ACME, Inc', 'acme'],
    ['Acme Pvt. Ltd.', 'acme'],
    ['Acme Private Limited', 'acme'],
    ['Acme Corporation', 'acme'],
    ['Acme Corp Co', 'acme'],
    ['Acme GmbH', 'acme'],
    ['Acme PLC', 'acme'],
    ['Acme LLC', 'acme'],
    ['Acme LLP', 'acme'],
    ['Acme Incorporated', 'acme'],
    ['Co', 'co'],
    ['Inc', 'inc'],
    ['Ltd Co', 'ltd'],
    ['Acme Co Labs', 'acmecolabs'], // only trailing suffix words are dropped
    ['Acme-Labs Ltd', 'acmelabs'],
    ['株式会社', ''],
    ['  ', ''],
  ])('companyKey(%j) = %j', (name, key) => expect(companyKey(name)).toBe(key));

  it('uses the existing title normalization', () => {
    expect(titleKey('Sr. Backend-Engineer (Remote)')).toBe('srbackendengineerremote');
    expect(titleKey('エンジニア')).toBe('');
  });
});

describe('decideMatch (ADR-0002 §7 matrix)', () => {
  const sub = { company: 'Acme Inc.', jobTitle: 'Backend Engineer' };
  const app = (id: string, companyName: string, jobTitle: string | null) => ({ id, companyName, jobTitle });

  it('0 candidates → CREATED', () => {
    expect(decideMatch(sub, [])).toEqual({ state: 'CREATED' });
    expect(decideMatch(sub, [app('x', 'Globex', 'Backend Engineer')])).toEqual({ state: 'CREATED' });
  });
  it('one with the same title and none untitled → LINKED, whatever other titles exist', () => {
    expect(decideMatch(sub, [app('a', 'acme', 'backend engineer')])).toEqual({ state: 'LINKED', applicationId: 'a' });
    expect(decideMatch(sub, [app('a', 'ACME Ltd', 'Backend Engineer'), app('b', 'Acme', 'Designer')])).toEqual({
      state: 'LINKED',
      applicationId: 'a',
    });
  });
  it('a different title only → NEEDS_REVIEW', () => {
    expect(decideMatch(sub, [app('a', 'Acme', 'Designer')])).toEqual({ state: 'NEEDS_REVIEW' });
  });
  it('several with the same title → NEEDS_REVIEW', () => {
    expect(decideMatch(sub, [app('a', 'Acme', 'Backend Engineer'), app('b', 'Acme Inc', 'Backend Engineer')])).toEqual({
      state: 'NEEDS_REVIEW',
    });
  });
  it('any untitled application at the company → NEEDS_REVIEW', () => {
    expect(decideMatch(sub, [app('a', 'Acme', 'Backend Engineer'), app('b', 'Acme', null)])).toEqual({ state: 'NEEDS_REVIEW' });
    expect(decideMatch(sub, [app('a', 'Acme', 'Backend Engineer'), app('b', 'Acme', '—')])).toEqual({ state: 'NEEDS_REVIEW' });
    expect(decideMatch(sub, [app('b', 'Acme', null)])).toEqual({ state: 'NEEDS_REVIEW' });
  });
  it('suffix-only and suffix variants compare by key', () => {
    expect(decideMatch({ company: 'Inc', jobTitle: 'Dev' }, [app('a', 'Inc.', 'Dev')])).toEqual({ state: 'LINKED', applicationId: 'a' });
    expect(decideMatch({ company: 'Acme Pvt Ltd', jobTitle: 'Dev' }, [app('a', 'Acme', 'Dev')])).toEqual({
      state: 'LINKED',
      applicationId: 'a',
    });
  });
  it('an empty company or title key → NEEDS_REVIEW, never CREATED or LINKED', () => {
    expect(decideMatch({ company: '株式会社', jobTitle: 'Dev' }, [])).toEqual({ state: 'NEEDS_REVIEW' });
    expect(decideMatch({ company: 'Acme', jobTitle: 'エンジニア' }, [])).toEqual({ state: 'NEEDS_REVIEW' });
    expect(decideMatch({ company: '株式会社', jobTitle: 'Dev' }, [app('a', '有限会社', 'Dev')])).toEqual({ state: 'NEEDS_REVIEW' });
  });
});

describe('validation', () => {
  it.each([
    [{ salaryAnswer: '50k' }, ['salaryAnswer']],
    [{ resume: 'cv.pdf', credentials: 'x' }, ['resume', 'credentials']],
    [{ platform: 'we_work_remotely' }, ['platform']],
    [{ sourceRecordRef: '2026-10-02 09:15:00' }, ['sourceRecordRef']],
    [{ company: '   ' }, ['company']],
    [{ jobTitle: 'x'.repeat(201) }, ['jobTitle']],
    [{ submittedAt: '2026-10-02T09:15:00' }, ['submittedAt']],
    [{ jobUrl: 'javascript:alert(1)' }, ['jobUrl']],
    [{ jobUrl: `https://x.com/${'a'.repeat(2048)}` }, ['jobUrl']],
    [{ destinationHost: 'not a host' }, ['destinationHost']],
    [{ workMode: 'office' }, ['workMode']],
    [{ discoverySource: 'x'.repeat(101) }, ['discoverySource']],
  ])('rejects %j as invalid_input naming %j, never the value', async (overrides, fields) => {
    const err = await intakeError(() => submit(overrides));
    expect(err.code).toBe('invalid_input');
    expect(err.fields).toEqual(fields);
    for (const value of Object.values(overrides)) expect(`${err.message} ${err.fields.join(' ')}`).not.toContain(String(value));
    expect(await prisma.externalSubmission.count({ where: { userId: owner } })).toBe(0);
  });

  it('rejects a missing required field', async () => {
    const rest: Record<string, unknown> = { ...base };
    delete rest.jobTitle;
    const err = await intakeError(() => recordSubmission(owner, tokenId, rest));
    expect(err.fields).toEqual(['jobTitle']);
  });

  it('rejects submittedAt more than 5 minutes in the future and accepts up to 5 minutes', async () => {
    const now = new Date('2026-10-02T04:00:00Z');
    expect(() => parseSubmissionInput({ ...base, submittedAt: '2026-10-02T04:05:01Z' }, now)).toThrow(SubmissionIntakeError);
    expect(parseSubmissionInput({ ...base, submittedAt: '2026-10-02T04:05:00Z' }, now).submittedAt.toISOString()).toBe(
      '2026-10-02T04:05:00.000Z',
    );
  });

  it('accepts null or omitted optional fields as not reported, and trims required strings', () => {
    const parsed = parseSubmissionInput({ ...base, company: '  Acme  ', location: null, portalJobId: '  ', workMode: null });
    expect(parsed).toMatchObject({ company: 'Acme', location: null, portalJobId: null, workMode: null, jobUrl: null });
  });

  it('truncates confirmationText over 300 characters instead of rejecting it', async () => {
    const long = `${'😀'.repeat(299)}ab${'z'.repeat(500)}`;
    const outcome = await submit({ confirmationText: long });
    const row = await prisma.externalSubmission.findUniqueOrThrow({ where: { id: outcome.recordId } });
    expect(Array.from(row.confirmationText!)).toHaveLength(300);
    expect(row.confirmationText).toBe(`${'😀'.repeat(299)}a`);
  });
});

describe('canonical job URL', () => {
  it('drops the fragment and credentials and keeps only job-ID parameters', () => {
    expect(canonicalJobUrl('https://user:pw@www.indeed.com/viewjob?jk=abc&utm_source=x&from=serp#top')).toBe(
      'https://www.indeed.com/viewjob?jk=abc',
    );
    expect(canonicalJobUrl('https://www.linkedin.com/jobs/search/?currentJobId=42&keywords=dev')).toBe(
      'https://www.linkedin.com/jobs/search/?currentJobId=42',
    );
    expect(canonicalJobUrl('https://boards.greenhouse.io/acme/jobs/1?gh_jid=1&jobId=2&ref=x')).toBe(
      'https://boards.greenhouse.io/acme/jobs/1?gh_jid=1&jobId=2',
    );
    expect(canonicalJobUrl('http://acme.com/careers/1?session=secret')).toBe('http://acme.com/careers/1');
  });
});

describe('recordSubmission', () => {
  it('CREATED: a new application with the submitted fields, appliedAt = submittedAt, no status written', async () => {
    const outcome = await submit({ company: '  Acme Labs ', jobTitle: ' Backend Engineer ', location: 'Pune', jobUrl: 'https://acme.com/j/1?x=1#y' });
    expect(outcome.result).toBe('created');
    const record = await prisma.externalSubmission.findUniqueOrThrow({ where: { id: outcome.recordId } });
    expect(record).toMatchObject({
      matchState: 'CREATED',
      resolvedBy: 'AUTOMATIC',
      tokenId,
      company: 'Acme Labs',
      jobUrl: 'https://acme.com/j/1',
      submittedAt: new Date('2026-10-01T03:45:00Z'),
    });
    expect(record.resolvedAt).not.toBeNull();
    const app = await prisma.application.findUniqueOrThrow({ where: { id: record.applicationId! } });
    expect(app).toMatchObject({
      userId: owner,
      companyName: 'Acme Labs',
      jobTitle: 'Backend Engineer',
      location: 'Pune',
      appliedAt: new Date('2026-10-01T03:45:00Z'),
      aiStatus: null,
      userStatus: null,
    });
    const events = await prisma.applicationEvent.findMany({ where: { applicationId: app.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'AUTOMATION_SUBMITTED',
      externalSubmissionId: record.id,
      emailId: null,
      oldState: null,
      newState: null,
      description: null,
      provenance: null,
    });
  });

  it('LINKED: sets appliedAt only when empty and never changes aiStatus or userStatus', async () => {
    const empty = await application({ companyName: 'Acme Inc', jobTitle: 'Backend Engineer', aiStatus: 'INTERVIEW', userStatus: 'OFFER', userStatusRevision: 3 });
    const first = await submit();
    expect(first.result).toBe('linked');
    const linked = await prisma.application.findUniqueOrThrow({ where: { id: empty.id } });
    expect(linked).toMatchObject({ appliedAt: new Date('2026-10-01T03:45:00Z'), aiStatus: 'INTERVIEW', userStatus: 'OFFER', userStatusRevision: 3 });

    await prisma.application.update({ where: { id: empty.id }, data: { appliedAt: new Date('2026-09-01T00:00:00Z') } });
    const second = await submit({ sourceRecordRef: '2026-10-02/09:20:00', submittedAt: '2026-10-01T09:20:00+05:30' });
    expect(second.result).toBe('linked');
    expect((await prisma.application.findUniqueOrThrow({ where: { id: empty.id } })).appliedAt).toEqual(new Date('2026-09-01T00:00:00Z'));
    expect(await prisma.applicationEvent.count({ where: { applicationId: empty.id, type: 'AUTOMATION_SUBMITTED' } })).toBe(2);
    expect(await prisma.application.count({ where: { userId: owner } })).toBe(1);
  });

  it('NEEDS_REVIEW: keeps the record unresolved and touches no application', async () => {
    const a = await application({ companyName: 'Acme', jobTitle: 'Designer' });
    const outcome = await submit();
    expect(outcome.result).toBe('needs_review');
    const record = await prisma.externalSubmission.findUniqueOrThrow({ where: { id: outcome.recordId } });
    expect(record).toMatchObject({ matchState: 'NEEDS_REVIEW', resolvedBy: null, resolvedAt: null, applicationId: null });
    expect(await prisma.applicationEvent.count({ where: { externalSubmissionId: record.id } })).toBe(0);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: a.id } })).appliedAt).toBeNull();
  });

  it('ignores other users’ applications', async () => {
    await application({ companyName: 'Acme', jobTitle: 'Backend Engineer' }, other);
    expect((await submit()).result).toBe('created');
    expect(await prisma.application.count({ where: { userId: other } })).toBe(1);
  });

  it('allows the same ref for different users', async () => {
    expect((await submit()).result).toBe('created');
    expect((await submit({}, other)).result).toBe('created');
  });
});

describe('idempotency', () => {
  it('a replay of the same ref returns already_recorded with the same record and no new event', async () => {
    const first = await submit();
    const replay = await submit();
    expect(replay).toEqual({ result: 'already_recorded', recordId: first.recordId, payloadDiffered: false });
    expect(await prisma.externalSubmission.count({ where: { userId: owner } })).toBe(1);
    expect(await prisma.applicationEvent.count({ where: { externalSubmissionId: first.recordId } })).toBe(1);
  });

  it('a replay with a changed payload is reported as differing and never updates the record', async () => {
    const first = await submit({ location: 'Pune' });
    const before = await prisma.externalSubmission.findUniqueOrThrow({ where: { id: first.recordId } });
    const replay = await submit({ location: 'Mumbai', jobTitle: 'Frontend Engineer' });
    expect(replay).toEqual({ result: 'already_recorded', recordId: first.recordId, payloadDiffered: true });
    expect(await prisma.externalSubmission.findUniqueOrThrow({ where: { id: first.recordId } })).toEqual(before);
  });

  it('two concurrent calls with the same ref give exactly one record and one event', async () => {
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => submit()));
    expect(outcomes.filter((o) => o.result === 'created')).toHaveLength(1);
    expect(outcomes.filter((o) => o.result === 'already_recorded')).toHaveLength(5);
    expect(new Set(outcomes.map((o) => o.recordId)).size).toBe(1);
    expect(await prisma.externalSubmission.count({ where: { userId: owner } })).toBe(1);
    expect(await prisma.applicationEvent.count({ where: { type: 'AUTOMATION_SUBMITTED', application: { userId: owner } } })).toBe(1);
    expect(await prisma.application.count({ where: { userId: owner } })).toBe(1);
  });

  it('concurrent calls with different refs for a new company create exactly one application', async () => {
    const outcomes = await Promise.all(
      ['09:00:01', '09:00:02', '09:00:03', '09:00:04'].map((t, i) =>
        submit({ sourceRecordRef: `2026-10-02/${t}`, company: i % 2 ? 'NewCo Ltd' : 'NewCo', jobTitle: i < 2 ? 'Dev' : 'QA' }),
      ),
    );
    expect(await prisma.application.count({ where: { userId: owner } })).toBe(1);
    expect(outcomes.filter((o) => o.result === 'created')).toHaveLength(1);
    expect(await prisma.externalSubmission.count({ where: { userId: owner } })).toBe(4);
  });
});

describe('daily cap', () => {
  it('rejects new records past MCP_DAILY_SUBMISSION_LIMIT but still answers replays', async () => {
    process.env.MCP_DAILY_SUBMISSION_LIMIT = '2';
    await submit({ sourceRecordRef: '2026-10-02/10:00:01' });
    await submit({ sourceRecordRef: '2026-10-02/10:00:02' });
    const err = await intakeError(() => submit({ sourceRecordRef: '2026-10-02/10:00:03' }));
    expect(err.code).toBe('rate_limited');
    expect((await submit({ sourceRecordRef: '2026-10-02/10:00:01' })).result).toBe('already_recorded');
    expect((await submit({}, other)).result).toBe('created'); // per user
  });

  it('counts only today’s records (UTC)', async () => {
    process.env.MCP_DAILY_SUBMISSION_LIMIT = '1';
    const yesterday = new Date(Date.now() - 86_400_000);
    await recordSubmission(owner, tokenId, { ...base, sourceRecordRef: '2026-10-01/10:00:00', submittedAt: yesterday.toISOString() }, yesterday);
    expect((await submit()).result).toBe('linked'); // accepted: yesterday's record does not count
  });

  it('0 stops all new submissions', async () => {
    process.env.MCP_DAILY_SUBMISSION_LIMIT = '0';
    expect((await intakeError(() => submit())).code).toBe('rate_limited');
  });

  it('an invalid limit fails the call', async () => {
    process.env.MCP_DAILY_SUBMISSION_LIMIT = '5001';
    await expect(submit()).rejects.toThrow('Invalid MCP_DAILY_SUBMISSION_LIMIT');
  });
});
