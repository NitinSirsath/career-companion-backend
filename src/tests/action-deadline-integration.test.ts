import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '../db/prisma';
import { app } from '../index';
import { matchEmailToApplication } from '../services/matcher';
import { DiscordProvider } from '../services/notifications/DiscordProvider';
vi.mock('../jobs/notificationJob', () => ({ enqueueNotificationJob: vi.fn() }));
let owner: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (owner) await prisma.user.delete({ where: { id: owner } });
  owner = undefined;
});
describe('deadline persistence and API/notification boundaries', () => {
  it.each([
    ['Nov 20', false],
    ['Nov 20', true],
    ['by Friday', false],
  ])(
    'stores %s (follow-up=%s) once and exposes precision on every action route',
    async (text, followUp) => {
      const user = await prisma.user.create({ data: { email: 'deadline@fixture.test' } });
      owner = user.id;
      const application = await prisma.application.create({
        data: { userId: owner, companyName: 'Deadline Co' },
      });
      const email = await prisma.email.create({
        data: {
          userId: owner,
          gmailMessageId: 'deadline',
          receivedAt: new Date('2026-11-12T10:00:00Z'),
          aiProcessingResult: {
            create: {
              provider: 'fixture',
              model: 'fixture',
              contractVersion: 'extraction/v2',
              companyName: 'Deadline Co',
              actionRequired: !followUp,
              followUpRequired: followUp,
              actionDeadline: text,
              followUpDate: text,
            },
          },
        },
      });
      const logs = vi.spyOn(console, 'log');
      await matchEmailToApplication(email.id);
      const action = await prisma.action.findFirstOrThrow({ where: { emailId: email.id } });
      const valid = text === 'Nov 20';
      expect(action.deadline?.toISOString() ?? null).toBe(
        valid ? '2026-11-20T00:00:00.000Z' : null,
      );
      expect(action.deadlinePrecision).toBe(valid ? 'DATE' : null);
      if (!valid) {
        const line = logs.mock.calls
          .flat()
          .find((v) => String(v).includes('action_deadline_unclear'));
        expect(line).toBeDefined();
        expect(String(line)).not.toContain(text);
      }
      await matchEmailToApplication(email.id);
      expect(await prisma.action.findMany({ where: { emailId: email.id } })).toEqual([action]);
      for (const path of ['/api/actions', `/api/applications/${application.id}/actions`]) {
        const response = await request(app).get(path).set('X-Development-User', user.email);
        expect(response.status).toBe(200);
        expect(
          response.body.items.find((item: { id: string }) => item.id === action.id)
            .deadlinePrecision,
        ).toBe(valid ? 'DATE' : null);
      }
      const response = await request(app)
        .patch(`/api/actions/${action.id}`)
        .set('X-Development-User', user.email)
        .send({ status: 'COMPLETED' });
      expect(response.status).toBe(200);
      expect(response.body.deadlinePrecision).toBe(valid ? 'DATE' : null);
    },
  );
  it('formats a DATE for Discord without a local time or calendar-day shift', async () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.test/fixture';
    const send = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', send);
    await new DiscordProvider().send({
      actionId: 'fixture',
      companyName: 'Fixture',
      actionRequested: 'Reply',
      actionType: 'ACTION_REQUIRED',
      deadline: '2026-11-20T00:00:00Z',
      deadlinePrecision: 'DATE',
    });
    const body = JSON.parse(send.mock.calls[0][1].body);
    expect(body.embeds[0].fields.find((f: { name: string }) => f.name === 'Deadline').value).toBe(
      'Nov 20, 2026',
    );
  });
});
