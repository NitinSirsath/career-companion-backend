import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// The count is checked on the real sync over the dev-mode sandbox mailbox; no Google client.
vi.mock('googleapis', () => ({ google: {} }));
vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueEmailProcessingJob: vi.fn(async () => 'email-job'),
  enqueueRelevanceTriage: vi.fn(async () => 'triage-job'),
  enqueueNotificationJob: vi.fn(),
}));

import { app } from '../index';
import { prisma } from '../db/prisma';
import { syncUser } from '../services/gmailSync';
import { scanDay } from '../services/mailScanCount';
import { resetSandbox } from '../services/sandbox/mailbox';

const OWNER = 'owner@mail-scan-days.test';
const SENDER = 'Priya Raman <priya.raman@northwind.example>';
let owner: string;

const as = { 'X-Development-User': OWNER };
const send = async (subject: string) =>
  (
    await request(app)
      .post('/api/sandbox/messages')
      .set(as)
      .send({ from: SENDER, subject, body: 'Hello.' })
      .expect(201)
  ).body as { id: string };
const counts = async () =>
  (await prisma.mailScanDay.findMany({ where: { userId: owner }, orderBy: { day: 'asc' } })).map(
    ({ day, count }) => ({ day, count }),
  );
const today = () => scanDay(null);

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: OWNER } });
  owner = (await prisma.user.create({ data: { email: OWNER, name: 'Alex Tester' } })).id;
});
beforeEach(async () => {
  vi.stubEnv('ENABLE_DEV_AUTH', 'true');
  vi.stubEnv('APP_MODE', 'dev');
  const mine = { userId: owner };
  await prisma.sandboxMessage.deleteMany({ where: mine });
  await prisma.email.deleteMany({ where: mine });
  await prisma.mailScanDay.deleteMany({ where: mine });
  await prisma.blockedSender.deleteMany({ where: mine });
  await prisma.gmailConnection.deleteMany({ where: mine });
  await request(app).get('/api/gmail/connect').set(as).expect(302);
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: owner } });
});

describe('the day a mail is counted on', () => {
  it('is its date in UTC, or today when Gmail gave none', () => {
    expect(scanDay(new Date('2026-11-02T23:30:00+05:30'))).toBe('2026-11-02');
    expect(scanDay(new Date('2026-11-02T20:00:00-05:00'))).toBe('2026-11-03');
    expect(scanDay(null, new Date('2026-11-03T08:00:00Z'))).toBe('2026-11-03');
    expect(scanDay(new Date('not a date'), new Date('2026-11-03T08:00:00Z'))).toBe('2026-11-03');
  });
});

describe('counting the mails scanned', () => {
  it('counts each new inbox mail once, on its day', async () => {
    await send('One');
    await send('Two');
    expect(await syncUser(owner)).toMatchObject({ messagesIngested: 2 });
    expect(await counts()).toEqual([{ day: today(), count: 2 }]);

    await send('Three');
    expect(await syncUser(owner)).toMatchObject({ messagesIngested: 1 });
    expect(await counts()).toEqual([{ day: today(), count: 3 }]);
  });

  it('never counts a mail it already has, also when a full scan sees it again', async () => {
    await send('One');
    await syncUser(owner);
    // Forget the checkpoint: the next sync looks at every mail in the window again.
    await prisma.gmailConnection.update({
      where: { userId: owner },
      data: { lastHistoryId: null },
    });
    expect(await syncUser(owner)).toMatchObject({ messagesIngested: 0, messagesSkipped: 1 });
    expect(await counts()).toEqual([{ day: today(), count: 1 }]);
  });

  it('does not count mail it leaves out: a blocked sender, or mail older than the window', async () => {
    await prisma.blockedSender.create({
      data: { userId: owner, domain: 'northwind.example', source: 'MENU' },
    });
    await prisma.sandboxMessage.create({
      data: {
        id: '00000000000000ab',
        userId: owner,
        threadId: '00000000000000ab',
        historyId: 1,
        labelIds: ['INBOX', 'CATEGORY_PERSONAL'],
        sender: 'Old Sender <old@elsewhere.example>',
        recipient: OWNER,
        subject: 'Three days old',
        messageId: '<old@scan-days.mail>',
        body: 'Old mail.',
        internalDate: new Date(Date.now() - 3 * 86_400_000),
      },
    });
    await send('Blocked');
    expect(await syncUser(owner)).toMatchObject({ messagesIngested: 0 });
    expect(await counts()).toEqual([]);
  });

  it('goes with a sandbox reset, and with the user', async () => {
    await send('One');
    await syncUser(owner);
    expect(await counts()).toHaveLength(1);
    await resetSandbox(owner);
    expect(await counts()).toEqual([]);

    const other = await prisma.user.create({ data: { email: 'gone@mail-scan-days.test' } });
    await prisma.mailScanDay.create({ data: { userId: other.id, day: '2026-11-03', count: 4 } });
    await prisma.user.delete({ where: { id: other.id } });
    expect(await prisma.mailScanDay.count({ where: { userId: other.id } })).toBe(0);
  });
});
