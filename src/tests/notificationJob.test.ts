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
        email: 'test-notify@example.com'
      }
    });

    app = await prisma.application.create({
      data: {
        userId: user.id,
        companyName: 'Test Notify Co',
        jobTitle: 'Engineer'
      }
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

  it('delivers notification for ACTION_REQUIRED and records delivery', async () => {
    const action = await prisma.action.create({
      data: {
        applicationId: app.id,
        type: 'ACTION_REQUIRED',
        description: 'Complete Assessment',
        deadline: new Date()
      }
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
          provider: 'DISCORD'
        }
      }
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
        description: 'Blah'
      }
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
          provider: 'DISCORD'
        }
      }
    });
    
    expect(delivery).toBeNull();
  });

  it('does not resend if already delivered', async () => {
    const action = await prisma.action.create({
      data: {
        applicationId: app.id,
        type: 'FOLLOW_UP_REQUIRED',
        description: 'Follow up'
      }
    });

    await prisma.notificationDelivery.create({
      data: {
        actionId: action.id,
        provider: 'DISCORD',
        status: 'DELIVERED',
        attemptCount: 1
      }
    });

    const sendMock = vi.fn();
    DiscordProvider.prototype.send = sendMock;

    await startNotificationWorker();
    await workHandler([{ data: { actionId: action.id } }]);

    // Should not call send because it was already delivered
    expect(sendMock).not.toHaveBeenCalled();
  });
});
