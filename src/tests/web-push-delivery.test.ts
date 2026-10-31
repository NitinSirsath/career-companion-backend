// Push alerts per device (owner, 30 Oct 2026): a new step that needs the user goes to each of
// their devices once, with the same checks as the Discord notification.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebPushError } from 'web-push';
import { prisma } from '../db/prisma';
import { startWebPushNotificationWorker } from '../jobs/notificationJob';
import { enqueueNotificationJob } from '../services/enqueue';
import { suppressNotifications } from '../services/notificationSuppression';

const { sendNotification, queue } = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  queue: {
    send: vi.fn(),
    handlers: new Map<string, (jobs: { data: { actionId: string } }[]) => Promise<void>>(),
  },
}));
vi.mock('web-push', async (importOriginal) => {
  const actual = await importOriginal<typeof import('web-push')>();
  return { ...actual, default: { ...actual, sendNotification }, sendNotification };
});
vi.mock('../services/queue', () => ({
  getQueue: vi.fn(async () => ({
    send: queue.send,
    work: async (
      name: string,
      handler: (jobs: { data: { actionId: string } }[]) => Promise<void>,
    ) => {
      queue.handlers.set(name, handler);
    },
  })),
  stopQueue: vi.fn(),
}));

const DOMAIN = '@push-delivery.test';
const SERVER_KEYS = {
  VAPID_PUBLIC_KEY: 'server-public-key',
  VAPID_PRIVATE_KEY: 'server-private-key',
  VAPID_SUBJECT: 'mailto:alerts@northlist.test',
};
const PHONE = 'https://fcm.googleapis.com/fcm/send/phone';
const LAPTOP = 'https://updates.push.services.mozilla.com/wpush/v2/laptop';
const OTHER = 'https://web.push.apple.com/other-user';
let userId: string;
let otherId: string;
let appId: string;

function setServerKeys(on: boolean) {
  for (const [name, value] of Object.entries(SERVER_KEYS)) process.env[name] = on ? value : '';
}

async function deliver(actionId: string) {
  await startWebPushNotificationWorker();
  await queue.handlers.get('web-push-notification-job')!([{ data: { actionId } }]);
}

const step = (data: Record<string, unknown> = {}) =>
  prisma.action.create({ data: { applicationId: appId, type: 'ACTION_REQUIRED', ...data } });

const delivery = (actionId: string) =>
  prisma.notificationDelivery.findUnique({
    where: { actionId_provider: { actionId, provider: 'WEB_PUSH' } },
  });

const sentTo = () => sendNotification.mock.calls.map(([target]) => target.endpoint).sort();
const goneError = () => new WebPushError('Received unexpected response code', 410, {}, '', PHONE);
const busyError = () => new WebPushError('Received unexpected response code', 503, {}, '', PHONE);

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  userId = (await prisma.user.create({ data: { email: `owner${DOMAIN}` } })).id;
  otherId = (await prisma.user.create({ data: { email: `other${DOMAIN}` } })).id;
  appId = (
    await prisma.application.create({
      data: { userId, companyName: 'Acme', jobTitle: 'Frontend Developer' },
    })
  ).id;
});
beforeEach(async () => {
  await prisma.action.deleteMany({ where: { applicationId: appId } });
  await prisma.application.update({ where: { id: appId }, data: { archivedAt: null } });
  await prisma.pushDevice.deleteMany({ where: { userId: { in: [userId, otherId] } } });
  await prisma.pushDevice.createMany({
    data: [
      { userId, endpoint: PHONE, p256dh: 'BPphone', auth: 'phone' },
      { userId, endpoint: LAPTOP, p256dh: 'BPlaptop', auth: 'laptop' },
      { userId: otherId, endpoint: OTHER, p256dh: 'BPother', auth: 'other' },
    ],
  });
  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
  queue.send.mockReset();
  setServerKeys(true);
});
afterAll(async () => {
  setServerKeys(false);
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
});

describe('push alert for a new step', () => {
  it("sends the company and the step to each of the user's devices, once", async () => {
    const action = await step({ description: 'Reply with your availability' });
    await deliver(action.id);
    expect(sentTo()).toEqual([PHONE, LAPTOP].sort());
    for (const [, payload, options] of sendNotification.mock.calls) {
      expect(JSON.parse(payload)).toEqual({
        title: 'Acme',
        body: 'Reply with your availability',
        url: `/applications/${appId}`,
        tag: action.id,
      });
      expect(options).toMatchObject({
        TTL: 86400,
        urgency: 'high',
        topic: action.id.replace(/-/g, ''),
      });
    }
    expect(await delivery(action.id)).toMatchObject({ status: 'DELIVERED', attemptCount: 1 });
    const used = await prisma.pushDevice.findMany({ where: { userId } });
    expect(used.every((device) => device.lastUsedAt instanceof Date)).toBe(true);

    await deliver(action.id);
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it('names a step with no text by its kind, and cuts long text', async () => {
    const followUp = await step({ type: 'FOLLOW_UP_REQUIRED' });
    await deliver(followUp.id);
    expect(JSON.parse(sendNotification.mock.calls[0][1]).body).toBe('Follow up required');

    sendNotification.mockClear();
    const long = await step({ description: 'x'.repeat(300) });
    await deliver(long.id);
    const body: string = JSON.parse(sendNotification.mock.calls[0][1]).body;
    expect(body).toHaveLength(180);
    expect(body.endsWith('…')).toBe(true);
  });

  it('sends nothing for a snoozed or archived step, and suppresses it for good', async () => {
    const snoozed = await step({ snoozedUntil: new Date(Date.now() + 3_600_000) });
    await deliver(snoozed.id);
    await prisma.action.update({ where: { id: snoozed.id }, data: { snoozedUntil: null } });
    await deliver(snoozed.id);

    const archived = await step({});
    await prisma.application.update({ where: { id: appId }, data: { archivedAt: new Date() } });
    await deliver(archived.id);

    expect(sendNotification).not.toHaveBeenCalled();
    for (const id of [snoozed.id, archived.id])
      expect(await delivery(id)).toMatchObject({
        status: 'FAILED_PERMANENT',
        errorDetails: 'USER_SUPPRESSED',
      });
  });

  it('sends nothing for a done or retired step, or a step of another kind', async () => {
    const steps = [
      await step({ status: 'COMPLETED' }),
      await step({ retiredAt: new Date(), retiredReason: 'EMAIL_MOVED' }),
      await step({ type: 'INTERVIEW_SCHEDULED' }),
    ];
    for (const { id } of steps) await deliver(id);
    expect(sendNotification).not.toHaveBeenCalled();
    for (const { id } of steps) expect(await delivery(id)).toBeNull();
  });

  it('never pushes a step whose notifications were suppressed', async () => {
    const action = await step({});
    await suppressNotifications(prisma, [action.id]);
    await deliver(action.id);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(await delivery(action.id)).toMatchObject({ status: 'FAILED_PERMANENT' });
  });

  it('sends and claims nothing without devices, or while the server has no keys', async () => {
    await prisma.pushDevice.deleteMany({ where: { userId } });
    const noDevices = await step({});
    await deliver(noDevices.id);
    expect(await delivery(noDevices.id)).toBeNull();

    await prisma.pushDevice.create({
      data: { userId, endpoint: PHONE, p256dh: 'BPphone', auth: 'phone' },
    });
    setServerKeys(false);
    const noKeys = await step({ description: 'Second step' });
    await deliver(noKeys.id);
    expect(await delivery(noKeys.id)).toBeNull();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('removes a gone device and counts the alert as delivered when another device took it', async () => {
    sendNotification.mockImplementation(async ({ endpoint }: { endpoint: string }) => {
      if (endpoint === PHONE) throw goneError();
      return { statusCode: 201, body: '', headers: {} };
    });
    const action = await step({});
    await deliver(action.id);
    expect(await delivery(action.id)).toMatchObject({ status: 'DELIVERED' });
    expect(
      (await prisma.pushDevice.findMany({ where: { userId } })).map((d) => d.endpoint),
    ).toEqual([LAPTOP]);
  });

  it('tries again only when no device took it and the push service may recover', async () => {
    sendNotification.mockRejectedValue(busyError());
    const action = await step({});
    await expect(deliver(action.id)).rejects.toThrow('Will retry');
    expect(await delivery(action.id)).toMatchObject({
      status: 'FAILED_RETRYABLE',
      claimedAt: null,
      attemptCount: 1,
    });

    sendNotification.mockReset();
    sendNotification.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    await deliver(action.id);
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(await delivery(action.id)).toMatchObject({ status: 'DELIVERED', attemptCount: 2 });
    expect(await prisma.pushDevice.count({ where: { userId } })).toBe(2);
  });

  it('records a refusal for good, without retrying', async () => {
    sendNotification.mockRejectedValue(
      new WebPushError('Received unexpected response code', 400, {}, '', PHONE),
    );
    const action = await step({});
    await deliver(action.id);
    expect(await delivery(action.id)).toMatchObject({ status: 'FAILED_PERMANENT' });
    await deliver(action.id);
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it('treats a network failure as worth another try', async () => {
    sendNotification.mockRejectedValue(
      Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' }),
    );
    const action = await step({});
    await expect(deliver(action.id)).rejects.toThrow('Will retry');
    expect(await delivery(action.id)).toMatchObject({ status: 'FAILED_RETRYABLE' });
  });
});

it('queues the Discord notification and the push alert for a new step', async () => {
  await enqueueNotificationJob('step-1');
  expect(queue.send).toHaveBeenCalledWith(
    'discord-notification-job',
    { actionId: 'step-1' },
    expect.objectContaining({ singletonKey: 'notify-discord-step-1', retryLimit: 3 }),
  );
  expect(queue.send).toHaveBeenCalledWith(
    'web-push-notification-job',
    { actionId: 'step-1' },
    expect.objectContaining({ singletonKey: 'notify-push-step-1', retryLimit: 3 }),
  );
});
