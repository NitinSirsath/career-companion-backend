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
