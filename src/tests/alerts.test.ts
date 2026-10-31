// Push alerts per device (owner, 30 Oct 2026): the API that turns them on and off.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { WebPushError } from 'web-push';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { AlertKeyResponseSchema, TurnOnAlertsResponseSchema } from '../contracts';

const { sendNotification } = vi.hoisted(() => ({ sendNotification: vi.fn() }));
vi.mock('web-push', async (importOriginal) => {
  const actual = await importOriginal<typeof import('web-push')>();
  return { ...actual, default: { ...actual, sendNotification }, sendNotification };
});

const DOMAIN = '@push-alerts.test';
const ALICE = `alice${DOMAIN}`;
const BOB = `bob${DOMAIN}`;
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/alice-laptop-secret-path';
const KEYS = { p256dh: 'BPdevicePublicKeyForTests', auth: 'deviceAuthSecret' };
const SERVER_KEYS = {
  VAPID_PUBLIC_KEY: 'server-public-key',
  VAPID_PRIVATE_KEY: 'server-private-key',
  VAPID_SUBJECT: 'mailto:alerts@northlist.test',
};
let alice: string;
let bob: string;

const as = (email: string) => ({ 'X-Development-User': email });
const turnOn = (
  email: string,
  body: Record<string, unknown> = { endpoint: ENDPOINT, keys: KEYS },
) => request(app).post('/api/alerts/devices').set(as(email)).send(body);
const turnOff = (email: string, endpoint = ENDPOINT) =>
  request(app).post('/api/alerts/devices/off').set(as(email)).send({ endpoint });
const devices = () =>
  prisma.pushDevice.findMany({
    where: { userId: { in: [alice, bob] } },
    orderBy: { createdAt: 'asc' },
  });

function setServerKeys(on: boolean) {
  for (const [name, value] of Object.entries(SERVER_KEYS)) process.env[name] = on ? value : '';
}

/** Captures everything written to the console while `run` executes. */
async function captureLogs(run: () => Promise<unknown>) {
  const lines: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    }),
  );
  try {
    await run();
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
  return lines.join('\n');
}

beforeAll(async () => {
  process.env.ENABLE_DEV_AUTH = 'true';
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  alice = (await prisma.user.create({ data: { email: ALICE } })).id;
  bob = (await prisma.user.create({ data: { email: BOB } })).id;
});
beforeEach(async () => {
  await prisma.pushDevice.deleteMany({ where: { userId: { in: [alice, bob] } } });
  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
  setServerKeys(true);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  setServerKeys(false);
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
});

describe('GET /api/alerts/key', () => {
  it('says alerts are not available while the server has no keys', async () => {
    setServerKeys(false);
    const res = await request(app).get('/api/alerts/key').set(as(ALICE));
    expect(res.status).toBe(200);
    expect(AlertKeyResponseSchema.parse(res.body)).toEqual({ available: false, publicKey: null });
  });

  it('gives the public key, and only that, when the server has its keys', async () => {
    const res = await request(app).get('/api/alerts/key').set(as(ALICE));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true, publicKey: 'server-public-key' });
  });
});

describe('POST /api/alerts/devices', () => {
  it('saves the device and sends it the first alert at once', async () => {
    const res = await turnOn(ALICE);
    expect(res.status).toBe(200);
    expect(TurnOnAlertsResponseSchema.parse(res.body)).toEqual({ on: true, firstAlertSent: true });
    const [device] = await devices();
    expect(device).toMatchObject({ userId: alice, endpoint: ENDPOINT, ...KEYS });
    expect(device.lastUsedAt).toBeInstanceOf(Date);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [target, payload, options] = sendNotification.mock.calls[0];
    expect(target).toEqual({ endpoint: ENDPOINT, keys: KEYS });
    expect(JSON.parse(payload)).toEqual({
      title: 'Alerts are on',
      body: "You'll get an alert here when something needs you.",
      url: '/account',
      tag: 'alerts-on',
    });
    expect(options).toMatchObject({
      TTL: 86400,
      urgency: 'high',
      vapidDetails: {
        publicKey: 'server-public-key',
        privateKey: 'server-private-key',
        subject: 'mailto:alerts@northlist.test',
      },
    });
    expect(options.topic).toBeUndefined();
  });

  it('turns on again without a second row, with the new keys', async () => {
    await turnOn(ALICE);
    const res = await turnOn(ALICE, { endpoint: ENDPOINT, keys: { p256dh: 'BPnew', auth: 'new' } });
    expect(res.status).toBe(200);
    expect(await devices()).toEqual([
      expect.objectContaining({ userId: alice, p256dh: 'BPnew', auth: 'new' }),
    ]);
  });

  it('moves a device another user turned on to the user signed in now', async () => {
    await turnOn(ALICE);
    const res = await turnOn(BOB);
    expect(res.status).toBe(200);
    expect(await devices()).toEqual([expect.objectContaining({ userId: bob, endpoint: ENDPOINT })]);
  });

  it('refuses while the server has no keys, and saves nothing', async () => {
    setServerKeys(false);
    const res = await turnOn(ALICE);
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'ALERTS_NOT_AVAILABLE',
      message: 'Alerts are not set up on this server.',
    });
    expect(await devices()).toEqual([]);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('never saves or calls an address that is not a known push service', async () => {
    for (const endpoint of [
      'https://evil.example.com/fcm/send/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://fcm.googleapis.com:8443/fcm/send/x',
      'https://user:secret@fcm.googleapis.com/fcm/send/x',
      'https://169.254.169.254/latest/meta-data',
    ]) {
      const res = await turnOn(ALICE, { endpoint, keys: KEYS });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ALERT_ENDPOINT_NOT_ALLOWED');
    }
    const plain = await turnOn(ALICE, { endpoint: 'http://fcm.googleapis.com/x', keys: KEYS });
    expect(plain.status).toBe(400);
    expect(plain.body.error.code).toBe('VALIDATION_ERROR');
    expect(await devices()).toEqual([]);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('accepts the push services of Firefox, Safari and Edge', async () => {
    for (const endpoint of [
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://web.push.apple.com/QGx',
      'https://api.push.apple.com/3/device/x',
      'https://wns2-par02p.notify.windows.com/w/?token=x',
    ]) {
      const res = await turnOn(ALICE, { endpoint, keys: KEYS });
      expect(res.status).toBe(200);
    }
    expect(await devices()).toHaveLength(4);
  });

  it('removes the device and refuses when its push service says it is gone', async () => {
    sendNotification.mockRejectedValueOnce(
      new WebPushError('Received unexpected response code', 410, {}, '', ENDPOINT),
    );
    const res = await turnOn(ALICE);
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'ALERT_DEVICE_GONE',
      message: 'This device did not accept alerts. Try again.',
    });
    expect(await devices()).toEqual([]);
  });

  it('keeps the device when the first alert could not be sent just now', async () => {
    sendNotification.mockRejectedValueOnce(
      new WebPushError('Received unexpected response code', 503, {}, '', ENDPOINT),
    );
    const res = await turnOn(ALICE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ on: true, firstAlertSent: false });
    expect(await devices()).toEqual([expect.objectContaining({ userId: alice, lastUsedAt: null })]);
  });

  it('never logs the device keys or its full address', async () => {
    sendNotification.mockRejectedValueOnce(
      new WebPushError('Received unexpected response code', 503, {}, '', ENDPOINT),
    );
    const logs = await captureLogs(async () => {
      await turnOn(ALICE);
      await turnOn(ALICE);
      await turnOff(ALICE);
    });
    expect(logs).toContain('fcm.googleapis.com');
    for (const secret of ['alice-laptop-secret-path', KEYS.p256dh, KEYS.auth, 'server-private-key'])
      expect(logs).not.toContain(secret);
  });
});

describe('POST /api/alerts/devices/off', () => {
  it("removes only the signed-in user's own device", async () => {
    await turnOn(ALICE);
    const other = await turnOff(BOB);
    expect(other.status).toBe(200);
    expect(other.body).toEqual({ on: false });
    expect(await devices()).toHaveLength(1);
    const own = await turnOff(ALICE);
    expect(own.body).toEqual({ on: false });
    expect(await devices()).toEqual([]);
    expect((await turnOff(ALICE)).body).toEqual({ on: false });
  });
});

it('refuses every alert call without a signed-in user', async () => {
  for (const call of [
    request(app).get('/api/alerts/key'),
    request(app).post('/api/alerts/devices').send({ endpoint: ENDPOINT, keys: KEYS }),
    request(app).post('/api/alerts/devices/off').send({ endpoint: ENDPOINT }),
  ])
    expect((await call).status).toBe(401);
  expect(sendNotification).not.toHaveBeenCalled();
});
