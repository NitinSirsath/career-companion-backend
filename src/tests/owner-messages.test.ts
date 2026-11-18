// Messages from the Admin page (owner, 18 Nov 2026): to everyone or one account, shown until closed,
// removable, with an optional push alert; only the admin can send.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/notifications/webPush', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/notifications/webPush')>()),
  sendToDevice: vi.fn(),
}));

import { app } from '../index';
import { prisma } from '../db/prisma';
import { AdminMessagesResponseSchema, MyMessagesResponseSchema } from '../contracts/messages';
import { sendToDevice } from '../services/notifications/webPush';

const DOMAIN = 'owner-messages.test';
const ADMIN = `owner@${DOMAIN}`;
const OLD = `old@${DOMAIN}`;
const LATE = `late@${DOMAIN}`;
const as = (email: string) => ({ 'X-Development-User': email });
const ids: Record<string, string> = {};

const send = (body: Record<string, unknown>) =>
  request(app).post('/api/admin/messages').set(as(ADMIN)).send(body);
const mine = async (email: string) =>
  MyMessagesResponseSchema.parse((await request(app).get('/api/messages').set(as(email))).body)
    .messages;

beforeEach(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
  // Messages to everyone belong to no account; this file is the only one that sends them.
  await prisma.ownerMessage.deleteMany({});
  vi.stubEnv('ADMIN_EMAILS', ADMIN);
  vi.mocked(sendToDevice).mockReset().mockResolvedValue('sent');
  const before = new Date(Date.now() - 60_000);
  for (const email of [ADMIN, OLD])
    ids[email] = (await prisma.user.create({ data: { email, createdAt: before } })).id;
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
});

describe('sending', () => {
  it('only the admin may send or list; anyone else gets 404', async () => {
    const res = await request(app)
      .post('/api/admin/messages')
      .set(as(OLD))
      .send({ text: 'Hi', to: 'EVERYONE', alsoAlert: false });
    expect(res.status).toBe(404);
    expect((await request(app).get('/api/admin/messages').set(as(OLD))).status).toBe(404);
  });

  it('needs text up to 500 characters and a known account', async () => {
    expect((await send({ text: '  ', to: 'EVERYONE', alsoAlert: false })).status).toBe(400);
    expect((await send({ text: 'x'.repeat(501), to: 'EVERYONE', alsoAlert: false })).status).toBe(
      400,
    );
    const unknown = await send({
      text: 'Hi',
      to: '99999999-9999-4999-8999-999999999999',
      alsoAlert: false,
    });
    expect(unknown.status).toBe(404);
  });

  it('shows a message to everyone to accounts that existed when it was sent, not to later ones', async () => {
    const res = await send({
      text: '  Down tonight at 11 PM.  ',
      to: 'EVERYONE',
      alsoAlert: false,
    });
    expect(res.status).toBe(201);
    expect(res.body.message).toMatchObject({
      text: 'Down tonight at 11 PM.',
      toEmail: null,
      alertsSent: null,
    });
    ids[LATE] = (await prisma.user.create({ data: { email: LATE } })).id;
    expect((await mine(OLD)).map((m) => m.text)).toEqual(['Down tonight at 11 PM.']);
    expect(await mine(LATE)).toEqual([]);
  });

  it('shows a message to one account only to that account', async () => {
    await send({ text: 'Please connect Gmail again.', to: ids[OLD], alsoAlert: false });
    expect((await mine(OLD)).map((m) => m.text)).toEqual(['Please connect Gmail again.']);
    expect(await mine(ADMIN)).toEqual([]);
    const listed = AdminMessagesResponseSchema.parse(
      (await request(app).get('/api/admin/messages').set(as(ADMIN))).body,
    );
    expect(listed.messages[0]).toMatchObject({ toEmail: OLD, removedAt: null });
  });
});

describe('closing and removing', () => {
  it('stays closed once the user closes it, and Remove hides it for everyone', async () => {
    const first = (await send({ text: 'First', to: 'EVERYONE', alsoAlert: false })).body.message;
    await send({ text: 'Second', to: 'EVERYONE', alsoAlert: false });
    expect((await mine(OLD)).map((m) => m.text)).toEqual(['Second', 'First']);

    const closed = await request(app).post(`/api/messages/${first.id}/dismiss`).set(as(OLD));
    expect(closed.status).toBe(200);
    await request(app).post(`/api/messages/${first.id}/dismiss`).set(as(OLD));
    expect((await mine(OLD)).map((m) => m.text)).toEqual(['Second']);
    expect((await mine(ADMIN)).map((m) => m.text)).toEqual(['Second', 'First']);

    const second = (await mine(OLD))[0];
    const removed = await request(app)
      .post(`/api/admin/messages/${second.id}/remove`)
      .set(as(ADMIN));
    expect(removed.body.message.removedAt).not.toBeNull();
    expect(await mine(OLD)).toEqual([]);
  });

  it('refuses to close a message the user cannot see', async () => {
    const other = (await send({ text: 'Only the admin', to: ids[ADMIN], alsoAlert: false })).body
      .message;
    const res = await request(app).post(`/api/messages/${other.id}/dismiss`).set(as(OLD));
    expect(res.status).toBe(404);
  });
});

describe('the alert', () => {
  beforeEach(async () => {
    await prisma.pushDevice.createMany({
      data: [
        {
          userId: ids[OLD],
          endpoint: `https://fcm.googleapis.com/fcm/send/${DOMAIN}-1`,
          p256dh: 'a',
          auth: 'a',
        },
        {
          userId: ids[ADMIN],
          endpoint: `https://fcm.googleapis.com/fcm/send/${DOMAIN}-2`,
          p256dh: 'b',
          auth: 'b',
        },
      ],
    });
  });

  it('goes to the devices with alerts on, cut to 120 characters, and says how many took it', async () => {
    vi.mocked(sendToDevice).mockResolvedValueOnce('sent').mockResolvedValueOnce('gone');
    const text = `Update tonight. ${'x'.repeat(200)}`;
    const res = await send({ text, to: 'EVERYONE', alsoAlert: true });
    expect(sendToDevice).toHaveBeenCalledTimes(2);
    const alert = vi.mocked(sendToDevice).mock.calls[0][1];
    expect(alert).toMatchObject({ title: 'NorthList', url: '/' });
    expect(alert.body.length).toBeLessThanOrEqual(120);
    expect(res.body.message.alertsSent).toBe(1);
  });

  it('sends no alert unless asked, and none to a suspended account', async () => {
    await send({ text: 'Quiet', to: 'EVERYONE', alsoAlert: false });
    expect(sendToDevice).not.toHaveBeenCalled();
    await prisma.user.update({ where: { id: ids[OLD] }, data: { suspendedAt: new Date() } });
    await send({ text: 'Loud', to: 'EVERYONE', alsoAlert: true });
    expect(sendToDevice).toHaveBeenCalledTimes(1);
    const listed = AdminMessagesResponseSchema.parse(
      (await request(app).get('/api/admin/messages').set(as(ADMIN))).body,
    );
    expect(listed.alertDevices).toEqual({ [ids[ADMIN]]: 1 });
  });
});
