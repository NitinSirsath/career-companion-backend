/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { prisma } from '../db/prisma';
import { startNotificationWorker } from '../jobs/notificationJob';
import { DiscordProvider } from '../services/notifications/DiscordProvider';
import * as queueService from '../services/queue';

vi.mock('../services/notifications/DiscordProvider');

let workHandler: any;
vi.mock('../services/queue', () => {
  return {
    getQueue: vi.fn().mockResolvedValue({
      send: vi.fn(),
      work: vi.fn().mockImplementation((name, handler) => {
        if (name === 'discord-notification-job') {
          workHandler = handler;
        }
      }),
      start: vi.fn(),
      clearStorage: vi.fn(),
      stop: vi.fn(),
    }),
    stopQueue: vi.fn(),
  };
});

describe('Notification Job', () => {
  let user: any;
  let app: any;

  beforeAll(async () => {
    user = await prisma.user.create({
      data: {
        email: 'test-notify@example.com',
      },
    });

    process.env.DISCORD_USER_ID = user.id;
    app = await prisma.application.create({
      data: {
        userId: user.id,
        companyName: 'Test Notify Co',
        jobTitle: 'Engineer',
      },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: user.id } });
    await queueService.stopQueue();
  });

  afterEach(async () => {
    await prisma.notificationDelivery.deleteMany();
    await prisma.action.deleteMany();
    vi.restoreAllMocks();
  });

  it('skips a retired pending action without creating a delivery', async () => {
    const action = await prisma.action.create({
      data: {
        applicationId: app.id,
        type: 'ACTION_REQUIRED',
        retiredAt: new Date(),
        retiredReason: 'EMAIL_MOVED',
      },
    });
    const send = vi.fn();
    DiscordProvider.prototype.send = send;
    await startNotificationWorker();
    await workHandler([{ data: { actionId: action.id } }]);
    expect(send).not.toHaveBeenCalled();
    expect(await prisma.notificationDelivery.count({ where: { actionId: action.id } })).toBe(0);
  });

  it('suppresses archived/snoozed work permanently and never replays it on wake or restore', async () => {
    for (const archived of [true, false]) {
      await prisma.application.update({
        where: { id: app.id },
        data: { archivedAt: archived ? new Date() : null },
      });
      const action = await prisma.action.create({
        data: {
          applicationId: app.id,
          type: 'ACTION_REQUIRED',
          snoozedUntil: archived ? null : new Date(Date.now() + 3600000),
        },
      });
      const send = vi.fn();
      DiscordProvider.prototype.send = send;
      await startNotificationWorker();
      await workHandler([{ data: { actionId: action.id } }]);
      await prisma.application.update({ where: { id: app.id }, data: { archivedAt: null } });
      await prisma.action.update({ where: { id: action.id }, data: { snoozedUntil: null } });
      await workHandler([{ data: { actionId: action.id } }]);
      expect(send).not.toHaveBeenCalled();
      expect(
        await prisma.notificationDelivery.findFirst({ where: { actionId: action.id } }),
      ).toMatchObject({ status: 'FAILED_PERMANENT', errorDetails: 'USER_SUPPRESSED' });
    }
  });

  it('rechecks archive after claiming and before the external send', async () => {
    const action = await prisma.action.create({
      data: { applicationId: app.id, type: 'ACTION_REQUIRED' },
    });
    const original = prisma.notificationDelivery.updateMany.bind(prisma.notificationDelivery);
    vi.spyOn(prisma.notificationDelivery, 'updateMany').mockImplementation((async (
      args: unknown,
    ) => {
      const result = await original(args as never);
      await prisma.application.update({ where: { id: app.id }, data: { archivedAt: new Date() } });
      return result;
    }) as never);
    const send = vi.fn();
    DiscordProvider.prototype.send = send;
    await startNotificationWorker();
    try {
      await workHandler([{ data: { actionId: action.id } }]);
      expect(send).not.toHaveBeenCalled();
    } finally {
      await prisma.application.update({ where: { id: app.id }, data: { archivedAt: null } });
    }
  });

  it('delivers notification for ACTION_REQUIRED and records delivery', async () => {
    const action = await prisma.action.create({
      data: {
        applicationId: app.id,
        type: 'ACTION_REQUIRED',
        description: 'Complete Assessment',
        deadline: new Date(),
      },
    });

    const sendMock = vi.fn().mockResolvedValue({ success: true, retryable: false });
    DiscordProvider.prototype.send = sendMock;

    await startNotificationWorker();
    await workHandler([{ data: { actionId: action.id } }]);

    expect(sendMock).toHaveBeenCalledTimes(1);

    const delivery = await prisma.notificationDelivery.findUnique({
      where: {
        actionId_provider: {
          actionId: action.id,
          provider: 'DISCORD',
        },
      },
    });

    expect(delivery).toBeDefined();
    expect(delivery?.status).toBe('DELIVERED');
    expect(delivery?.attemptCount).toBe(1);
  });

  it('skips ineligible action types (e.g. unknown)', async () => {
    const action = await prisma.action.create({
      data: {
        applicationId: app.id,
        type: 'UNKNOWN_TYPE',
        description: 'Blah',
      },
    });

    const sendMock = vi.fn();
    DiscordProvider.prototype.send = sendMock;

    await startNotificationWorker();
    await workHandler([{ data: { actionId: action.id } }]);

    expect(sendMock).not.toHaveBeenCalled();

    const delivery = await prisma.notificationDelivery.findUnique({
      where: {
        actionId_provider: {
          actionId: action.id,
          provider: 'DISCORD',
        },
      },
    });

    expect(delivery).toBeNull();
  });

  it('does not resend if already delivered', async () => {
    const action = await prisma.action.create({
      data: {
        applicationId: app.id,
        type: 'FOLLOW_UP_REQUIRED',
        description: 'Follow up',
      },
    });

    await prisma.notificationDelivery.create({
      data: {
        actionId: action.id,
        provider: 'DISCORD',
        status: 'DELIVERED',
        attemptCount: 1,
      },
    });

    const sendMock = vi.fn();
    DiscordProvider.prototype.send = sendMock;

    await startNotificationWorker();
    await workHandler([{ data: { actionId: action.id } }]);

    // Should not call send because it was already delivered
    expect(sendMock).not.toHaveBeenCalled();
  });
  it('does not disclose another user action to the configured webhook', async () => {
    const action = await prisma.action.create({
      data: { applicationId: app.id, type: 'ACTION_REQUIRED' },
    });
    const configured = process.env.DISCORD_USER_ID;
    process.env.DISCORD_USER_ID = 'another-user';
    const send = vi.fn();
    DiscordProvider.prototype.send = send;
    try {
      await startNotificationWorker();
      await workHandler([{ data: { actionId: action.id } }]);
    } finally {
      process.env.DISCORD_USER_ID = configured;
    }
    expect(send).not.toHaveBeenCalled();
  });
  it('delivers once under concurrent duplicate execution', async () => {
    const action = await prisma.action.create({
      data: { applicationId: app.id, type: 'ACTION_REQUIRED' },
    });
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => {
      started();
      await blocked;
      return { success: true, retryable: false };
    });
    DiscordProvider.prototype.send = send;
    await startNotificationWorker();
    const first = workHandler([{ data: { actionId: action.id } }]);
    await ready;
    await workHandler([{ data: { actionId: action.id } }]);
    release();
    await first;
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('does not resend after successful delivery followed by persistence failure', async () => {
    const action = await prisma.action.create({
      data: { applicationId: app.id, type: 'ACTION_REQUIRED' },
    });
    const send = vi.fn().mockResolvedValue({ success: true, retryable: false });
    DiscordProvider.prototype.send = send;
    vi.spyOn(prisma.notificationDelivery, 'update').mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    await startNotificationWorker();
    await expect(workHandler([{ data: { actionId: action.id } }])).rejects.toThrow();
    await workHandler([{ data: { actionId: action.id } }]);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
