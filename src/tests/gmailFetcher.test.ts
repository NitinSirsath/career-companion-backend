import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { GmailFetcherService } from '../services/gmailFetcher';
import { prisma } from '../db/prisma';
import { encryptToken } from '../utils/gmailTokenEncryption';

vi.mock('googleapis', () => {
  const mockMessagesGet = vi.fn().mockImplementation((args: { id: string }) => {
    if (args.id === 'msg-401') {
      const err = Object.assign(new Error('Unauthorized'), { code: 401 });
      return Promise.reject(err);
    }
    return Promise.resolve({
      data: {
        id: args.id,
        payload: {
          mimeType: 'text/html',
          body: {
            data: Buffer.from('<script>alert("hi")</script>Hello <b>World</b>!').toString('base64')
          }
        }
      }
    });
  });

  const mockRefreshAccessToken = vi.fn().mockResolvedValue({
    credentials: {
      access_token: 'new_access_token'
    }
  });

  function MockOAuth2(this: unknown) {
    return {
      setCredentials: vi.fn(),
      refreshAccessToken: mockRefreshAccessToken,
    };
  }

  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      gmail: vi.fn().mockReturnValue({
        users: {
          messages: {
            get: mockMessagesGet,
          }
        }
      })
    }
  };
});

describe('Gmail Fetcher Service (COM-25)', () => {
  let testUser: import('@prisma/client').User;

  beforeAll(async () => {
    process.env.GMAIL_TOKEN_ENCRYPTION_KEY = 'b'.repeat(64);
    testUser = await prisma.user.create({ data: { email: 'fetcher@test.local' } });
  });

  afterAll(async () => {
    await prisma.gmailConnection.deleteMany({ where: { userId: testUser.id } });
    await prisma.user.delete({ where: { id: testUser.id } });
  });

  it('strips HTML from message body', async () => {
    await prisma.gmailConnection.create({
      data: {
        userId: testUser.id,
        gmailEmail: 'fetcher@test.local',
        status: 'CONNECTED',
        accessToken: encryptToken('test-access-token')
      }
    });

    const body = await GmailFetcherService.fetchMessageBody(testUser.id, 'msg-123');
    expect(body).toBe('Hello World !');
  });

  it('marks an unrecoverable Google 401 as revoked', async () => {
    await prisma.gmailConnection.update({
      where: { userId: testUser.id },
      data: {
        refreshToken: encryptToken('test-refresh-token')
      }
    });

    await expect(GmailFetcherService.fetchMessageBody(testUser.id, 'msg-401')).rejects.toThrow();
    expect((await prisma.gmailConnection.findUniqueOrThrow({ where: { userId: testUser.id } })).status).toBe('REVOKED');
  });
});
