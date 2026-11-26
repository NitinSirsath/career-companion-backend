/**
 * How job mails find their application (owner, 26 Nov 2026): company names are compared with one
 * rule, and a mail that waited is matched again when NorthList Apply reports its job. Every
 * company, person and address here is made up.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/gmailFetcher');
vi.mock('../services/ai/providers', () => ({ createProviderClient: vi.fn() }));
vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueNotificationJob: vi.fn(),
}));

import { prisma } from '../db/prisma';
import { createProviderClient } from '../services/ai/providers';
import { companyKey, sameCompany } from '../services/companyName';
import { linkConversation } from '../services/conversationApplication';
import { recordSubmission, resolveSubmission } from '../services/externalSubmission';
import { fetchMessageBody, fetchMessageMetadata } from '../services/gmailFetcher';
import * as waitingMails from '../services/waitingMails';
import { matchAllWaitingMails } from '../services/waitingMails';
import { configureAI } from './helpers/aiAccess';
import {
  at,
  mailOf,
  readNewMail,
  storedMail,
  submission,
  type NewMail,
} from './helpers/readLinkFixtures';

const OWNER = 'owner@waiting-mails.test';
const OTHER = 'other@waiting-mails.test';
let owner: string;
let other: string;

const readNew = (mail: NewMail, category: string, answer: Record<string, unknown> = {}) =>
  readNewMail(owner, mail, category, answer);
const application = (companyName: string, jobTitle: string | null = null) =>
  prisma.application.create({ data: { userId: owner, companyName, jobTitle } });
const applications = () => prisma.application.findMany({ where: { userId: owner } });

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: [OWNER, OTHER] } } });
  owner = (await prisma.user.create({ data: { email: OWNER } })).id;
  other = (await prisma.user.create({ data: { email: OTHER } })).id;
  await configureAI(owner);
});
beforeEach(async () => {
  process.env.AI_USER_DAILY_CALL_LIMIT = '100';
  await prisma.email.deleteMany({ where: { userId: { in: [owner, other] } } });
  await prisma.externalSubmission.deleteMany({ where: { userId: owner } });
  await prisma.application.deleteMany({ where: { userId: { in: [owner, other] } } });
  vi.mocked(createProviderClient).mockReset();
  vi.mocked(fetchMessageMetadata).mockReset();
  vi.mocked(fetchMessageBody).mockReset();
  vi.mocked(fetchMessageMetadata).mockResolvedValue({ labelIds: ['INBOX'], snippet: 'Hi' });
  vi.mocked(fetchMessageBody).mockResolvedValue('Synthetic mail body');
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } });
});

describe('one rule for a company name', () => {
  it.each([
    ['Zenith Labs', 'ZENITH LABS LIMITED'],
    ['Zenith Labs', 'Zenith Labs Pvt. Ltd.'],
    ['Zenith Labs plc', 'Zenith-Labs'],
    ['Zenith Labs Ltd', 'Zenith Labs Limited'],
  ])('%s and %s are one company', (a, b) => {
    expect(sameCompany(a, b)).toBe(true);
    expect(companyKey(a)).toBe(companyKey(b));
  });

  it('keeps different companies apart, and a name with no letters matches nothing', () => {
    expect(sameCompany('Zenith Labs', 'Zenith Motors')).toBe(false);
    expect(sameCompany('Zenith', 'Zenith Labs')).toBe(false);
    expect(sameCompany('', '')).toBe(false);
    expect(sameCompany('!!', '??')).toBe(false);
  });

  it('links a confirmation that adds "Limited" to the job NorthList Apply saved', async () => {
    const outcome = await recordSubmission(owner, null, submission('Zenith Labs', 'Data Analyst'));
    expect(outcome.result).toBe('created');
    const { saved } = await readNew(
      { subject: 'Thank you for applying', sender: 'Careers <careers@zenith-labs.example>' },
      'FOLLOW_UP',
      { companyName: 'ZENITH LABS LIMITED', jobTitle: 'Data Analyst' },
    );
    expect(saved.matchState).toBe('MATCHED');
    expect(await applications()).toHaveLength(1);
  });

  it('"Create application" on such a mail joins the saved job instead of making a second', async () => {
    const app = await application('Zenith Labs', 'Data Analyst');
    const row = await storedMail(
      owner,
      {
        thread: 't-by-hand',
        subject: 'Thank you for applying',
        sender: 'Careers <careers@zenith-labs.example>',
      },
      { category: 'FOLLOW_UP', companyName: 'Zenith Labs Private Limited' },
    );
    const linked = await linkConversation(owner, 't-by-hand', {});
    expect(linked).toMatchObject({ created: false, application: { id: app.id } });
    expect((await mailOf(row.id)).applicationId).toBe(app.id);
    expect(await applications()).toHaveLength(1);
  });
});

describe('a mail that waited is matched again when NorthList Apply reports its job', () => {
  const CONFIRMATION = {
    subject: 'We received your application',
    sender: 'Zenith Labs Careers <careers@zenith-labs.example>',
    receivedAt: at(20, 13),
  };
  const READ = { companyName: 'Zenith Labs Limited', jobTitle: 'Data Analyst' };

  it('links the confirmation read before the job was reported', async () => {
    const { saved } = await readNew(CONFIRMATION, 'FOLLOW_UP', READ);
    expect(saved).toMatchObject({ matchState: 'UNMATCHED', applicationId: null });

    // NorthList Apply reports the job later: minutes or hours after the mail was read.
    const outcome = await recordSubmission(owner, null, submission('Zenith Labs', 'Data Analyst'));
    expect(outcome.result).toBe('created');
    const [app] = await applications();
    expect(await mailOf(saved.id)).toMatchObject({
      matchState: 'MATCHED',
      applicationId: app.id,
      matchConfirmedBy: 'AI_AUTO',
    });
    // The mail moves the job on, as it would have when it arrived.
    expect((await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).aiStatus).toBe(
      'APPLIED',
    );
    expect(await applications()).toHaveLength(1);
  });

  it('does the same when the submission joins a job the user already has', async () => {
    const app = await application('Zenith Labs', 'Data Analyst');
    const waiting = await storedMail(
      owner,
      { thread: 't-waiting', ...CONFIRMATION },
      { category: 'FOLLOW_UP', ...READ },
    );
    const outcome = await recordSubmission(owner, null, submission('Zenith Labs', 'Data Analyst'));
    expect(outcome.result).toBe('linked');
    expect((await mailOf(waiting.id)).applicationId).toBe(app.id);
  });

  it('and when the user settles a submission that waited for review', async () => {
    // An archived job at the company makes the report unclear: a person decides.
    const old = await application('Zenith Labs', 'Data Analyst');
    await prisma.application.update({ where: { id: old.id }, data: { archivedAt: at(1) } });
    const { saved } = await readNew(CONFIRMATION, 'FOLLOW_UP', READ);
    const outcome = await recordSubmission(owner, null, submission('Zenith Labs', 'Data Analyst'));
    expect(outcome.result).toBe('needs_review');
    expect((await mailOf(saved.id)).applicationId).toBeNull();

    const resolved = await resolveSubmission(owner, outcome.recordId, { action: 'create' });
    expect(resolved).toEqual({
      id: outcome.recordId,
      matchState: 'CREATED',
      applicationId: expect.any(String),
    });
    expect((await mailOf(saved.id)).applicationId).toBe(resolved.applicationId);
  });

  it('leaves mails of other companies, mails the user decided on, and mass outreach alone', async () => {
    const other = await readNew(
      { ...CONFIRMATION, sender: 'Careers <careers@lumen-works.example>' },
      'FOLLOW_UP',
      { companyName: 'Lumen Works' },
    );
    vi.mocked(fetchMessageMetadata).mockResolvedValue({
      labelIds: ['INBOX'],
      snippet: 'Hi',
      bulk: true,
    });
    const blast = await readNew(
      { subject: 'We are hiring at Zenith Labs', sender: 'Talent <team@hiring-crowd.example>' },
      'RECRUITER',
      { companyName: 'Zenith Labs' },
    );
    await recordSubmission(owner, null, submission('Zenith Labs', 'Data Analyst'));
    expect((await mailOf(other.saved.id)).applicationId).toBeNull();
    expect((await mailOf(blast.saved.id)).applicationId).toBeNull();
  });

  it('never refuses the submission when the second look fails', async () => {
    const sweep = vi
      .spyOn(waitingMails, 'matchWaitingMails')
      .mockRejectedValueOnce(new Error('database busy'));
    const outcome = await recordSubmission(owner, null, submission('Zenith Labs', 'Data Analyst'));
    expect(outcome.result).toBe('created');
    expect(await applications()).toHaveLength(1);
    sweep.mockRestore();
  });
});

describe('the hourly second look at mails that still wait', () => {
  const mail = (thread: string, sender = 'Careers <careers@zenith-labs.example>') => ({
    thread,
    subject: 'We received your application',
    sender,
  });
  const CONFIRMATION = { category: 'FOLLOW_UP', companyName: 'Zenith Labs Limited' };

  it('links a mail read before a matching rule got better, and says how many', async () => {
    const app = await application('Zenith Labs', 'Data Analyst');
    // Read when the company had to be written the same and the title had no extra words.
    const waiting = await storedMail(owner, mail('t-old'), {
      ...CONFIRMATION,
      jobTitle: 'Data Analyst (only for 2026 graduates)',
    });
    expect((await mailOf(waiting.id)).applicationId).toBeNull();

    expect(await matchAllWaitingMails()).toEqual({ tried: 1, linked: 1 });
    expect(await mailOf(waiting.id)).toMatchObject({
      matchState: 'MATCHED',
      applicationId: app.id,
      matchConfirmedBy: 'AI_AUTO',
    });
    expect((await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).aiStatus).toBe(
      'APPLIED',
    );
    // Nothing waits any more: the next hour does nothing.
    expect(await matchAllWaitingMails()).toEqual({ tried: 0, linked: 0 });
  });

  it('never links mass outreach, and never touches what the user decided', async () => {
    const app = await application('Zenith Labs');
    const blast = await storedMail(owner, mail('t-blast', 'Talent <team@hiring-crowd.example>'), {
      category: 'RECRUITER',
      companyName: 'Zenith Labs',
      bulkMail: true,
    });
    const unlinked = await storedMail(owner, mail('t-unlinked'), CONFIRMATION);
    await prisma.email.update({
      where: { id: unlinked.id },
      data: { matchState: 'IGNORED', matchConfirmedBy: 'USER_CONFIRMED' },
    });
    const elsewhere = await application('Lumen Works');
    const byHand = await storedMail(owner, mail('t-by-hand'), CONFIRMATION);
    await prisma.email.update({
      where: { id: byHand.id },
      data: {
        matchState: 'MATCHED',
        matchConfirmedBy: 'USER_CONFIRMED',
        applicationId: elsewhere.id,
      },
    });

    expect(await matchAllWaitingMails()).toEqual({ tried: 1, linked: 0 });
    expect(await mailOf(blast.id)).toMatchObject({ matchState: 'UNMATCHED', applicationId: null });
    expect(await mailOf(unlinked.id)).toMatchObject({ matchState: 'IGNORED', applicationId: null });
    expect((await mailOf(byHand.id)).applicationId).toBe(elsewhere.id);
    expect(await prisma.applicationEvent.count({ where: { applicationId: app.id } })).toBe(0);
  });

  it('does not link when two applications fit: the mail waits for the user to choose', async () => {
    await application('Zenith Labs', 'Data Analyst');
    await application('Zenith Labs', 'Support Lead');
    const waiting = await storedMail(owner, mail('t-two'), CONFIRMATION);
    expect(await matchAllWaitingMails()).toEqual({ tried: 1, linked: 0 });
    expect(await mailOf(waiting.id)).toMatchObject({
      matchState: 'AMBIGUOUS',
      applicationId: null,
    });
  });

  it('leaves alone a company with no application, an archived one, and other users', async () => {
    await application('Lumen Works');
    const archived = await application('Zenith Labs');
    await prisma.application.update({ where: { id: archived.id }, data: { archivedAt: at(1) } });
    const noJob = await storedMail(owner, mail('t-none'), CONFIRMATION);
    const theirs = await storedMail(other, mail('t-theirs'), CONFIRMATION);

    expect(await matchAllWaitingMails()).toEqual({ tried: 0, linked: 0 });
    for (const row of [noJob, theirs])
      expect(await mailOf(row.id)).toMatchObject({ matchState: 'UNMATCHED', applicationId: null });

    // Their own job links their own mail, and only theirs.
    await prisma.application.create({ data: { userId: other, companyName: 'Zenith Labs' } });
    expect(await matchAllWaitingMails()).toEqual({ tried: 1, linked: 1 });
    expect((await mailOf(noJob.id)).applicationId).toBeNull();
    expect((await mailOf(theirs.id)).applicationId).not.toBeNull();
  });
});
