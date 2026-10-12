import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  threadsList: vi.fn(),
  threadsGet: vi.fn(),
  labelsList: vi.fn(),
  messagesGet: vi.fn(),
  attachmentsGet: vi.fn(),
  credentials: {} as { access_token?: string; refresh_token?: string },
}));
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        get credentials() {
          return mocks.credentials;
        }
        setCredentials(credentials: typeof mocks.credentials) {
          mocks.credentials = { ...credentials };
        }
      },
    },
    gmail: () => ({
      users: {
        threads: { list: mocks.threadsList, get: mocks.threadsGet },
        labels: { list: mocks.labelsList },
        messages: { get: mocks.messagesGet, attachments: { get: mocks.attachmentsGet } },
      },
    }),
  },
}));

import { app } from '../index';
import { prisma } from '../db/prisma';
import { ListMailboxThreadsResponseSchema, MailThreadSchema } from '../contracts';
import { encryptToken } from '../utils/gmailTokenEncryption';

const OWNER = 'owner@mailbox.test';
const OTHER = 'other@mailbox.test';
let owner: string;
let other: string;

const as = (user: string) => ({ 'X-Development-User': user });
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
const headers = (values: Record<string, string>) =>
  Object.entries(values).map(([name, value]) => ({ name, value }));
const connect = (userId: string) =>
  prisma.gmailConnection.create({
    data: {
      userId,
      gmailEmail: 'owner@mailbox.test',
      status: 'CONNECTED',
      accessToken: encryptToken('access'),
      refreshToken: encryptToken('refresh'),
    },
  });
const inbox = (query = '', user = OWNER) =>
  request(app).get(`/api/mailbox/threads${query}`).set(as(user));
const thread = (id: string, user = OWNER) =>
  request(app).get(`/api/mailbox/threads/${id}`).set(as(user));
const attachment = (messageId: string, partId: string) =>
  request(app)
    .get(`/api/mailbox/messages/${messageId}/attachments/${partId}`)
    .set(as(OWNER))
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });

const FULL_THREAD = {
  id: 'thread-1',
  messages: [
    {
      id: 'msg-1',
      internalDate: String(Date.UTC(2026, 9, 1, 9)),
      labelIds: ['INBOX', 'UNREAD', 'Label_7', 'CATEGORY_PERSONAL'],
      payload: {
        partId: '',
        mimeType: 'multipart/mixed',
        headers: headers({
          From: 'Recruiter <recruiter@example.com>',
          To: 'owner@mailbox.test',
          Cc: 'hr@example.com',
          Subject: 'Interview: first round',
        }),
        parts: [
          {
            partId: '0',
            mimeType: 'multipart/alternative',
            parts: [
              { partId: '0.0', mimeType: 'text/plain', body: { data: b64('Please send dates.') } },
              {
                partId: '0.1',
                mimeType: 'text/html',
                body: { data: b64('<p>Please send <b>dates</b>.</p>') },
              },
            ],
          },
          {
            partId: '1',
            filename: 'job description.pdf',
            mimeType: 'application/pdf',
            body: { attachmentId: 'att-1', size: 1234 },
          },
        ],
      },
    },
    {
      id: 'msg-2',
      internalDate: String(Date.UTC(2026, 9, 2, 9)),
      labelIds: ['SENT'],
      payload: {
        mimeType: 'text/plain',
        headers: headers({ From: 'owner@mailbox.test', Subject: 'Re: Interview: first round' }),
        body: { data: b64('Tuesday works.') },
      },
    },
    { id: 'msg-3', labelIds: ['DRAFT'], payload: { mimeType: 'text/plain', body: {} } },
  ],
};

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: [OWNER, OTHER] } } });
  owner = (await prisma.user.create({ data: { email: OWNER } })).id;
  other = (await prisma.user.create({ data: { email: OTHER } })).id;
});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('GMAIL_TOKEN_ENCRYPTION_KEY', 'b'.repeat(64));
  await prisma.email.deleteMany({ where: { userId: { in: [owner, other] } } });
  await prisma.outgoingEmail.deleteMany({ where: { userId: { in: [owner, other] } } });
  await prisma.gmailConnection.deleteMany({ where: { userId: { in: [owner, other] } } });
  await connect(owner);
  mocks.labelsList.mockResolvedValue({
    data: {
      labels: [
        { id: 'INBOX', name: 'INBOX', type: 'system' },
        { id: 'Label_7', name: 'Job search', type: 'user' },
      ],
    },
  });
  mocks.threadsGet.mockResolvedValue({ data: FULL_THREAD });
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } });
});

describe('inbox list', () => {
  beforeEach(() => {
    mocks.threadsList.mockResolvedValue({
      data: {
        threads: [
          { id: 'thread-1', snippet: 'Please send dates.' },
          { id: 'thread-2', snippet: 'Lunch?' },
        ],
        nextPageToken: 'next-token',
      },
    });
    mocks.threadsGet.mockImplementation(async ({ id }: { id: string }) => ({
      data: {
        messages: [
          {
            internalDate: String(Date.UTC(2026, 9, 1, 9)),
            labelIds: ['INBOX'],
            payload: { headers: headers({ Subject: `Subject ${id}`, From: 'first@example.com' }) },
          },
          {
            internalDate: String(Date.UTC(2026, 9, 3, 9)),
            labelIds: ['INBOX', 'UNREAD'],
            payload: { headers: headers({ Subject: 'Re', From: 'newest@example.com' }) },
          },
        ],
      },
    }));
  });

  it('lists the inbox as Gmail orders it and marks the job conversations', async () => {
    await prisma.email.create({
      data: {
        userId: owner,
        gmailMessageId: 'tracked',
        threadId: 'thread-1',
        relevanceState: 'RELEVANT',
      },
    });
    const res = await inbox('?pageToken=page-2');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = ListMailboxThreadsResponseSchema.parse(res.body);
    expect(body.nextPageToken).toBe('next-token');
    expect(body.items).toEqual([
      {
        threadId: 'thread-1',
        subject: 'Subject thread-1',
        from: 'newest@example.com',
        date: '2026-10-03T09:00:00.000Z',
        snippet: 'Please send dates.',
        messageCount: 2,
        unread: true,
        conversationKey: 'thread-1',
      },
      expect.objectContaining({ threadId: 'thread-2', conversationKey: null }),
    ]);
    expect(mocks.threadsList).toHaveBeenCalledWith(
      { userId: 'me', labelIds: ['INBOX'], maxResults: 20, pageToken: 'page-2' },
      expect.anything(),
    );
  });

  it('stores nothing it reads', async () => {
    await inbox();
    await thread('thread-1');
    expect(await prisma.email.count({ where: { userId: owner } })).toBe(0);
    expect(await prisma.outgoingEmail.count({ where: { userId: owner } })).toBe(0);
  });

  it('needs a session and a connected Gmail', async () => {
    expect((await request(app).get('/api/mailbox/threads')).status).toBe(401);
    const res = await inbox('', OTHER);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GMAIL_NOT_CONNECTED');
    expect(mocks.threadsList).not.toHaveBeenCalled();
  });

  it('turns Gmail failures into answers the user can act on', async () => {
    mocks.threadsList.mockRejectedValueOnce({ status: 503 });
    expect((await inbox()).body.error.code).toBe('GMAIL_UNAVAILABLE');
    mocks.threadsList.mockRejectedValueOnce({ status: 400 });
    expect((await inbox('?pageToken=stale')).status).toBe(400);
    mocks.threadsList.mockRejectedValueOnce({ status: 401 });
    const revoked = await inbox();
    expect(revoked.status).toBe(409);
    expect(revoked.body.error.code).toBe('GMAIL_NOT_CONNECTED');
    expect(
      (await prisma.gmailConnection.findUniqueOrThrow({ where: { userId: owner } })).status,
    ).toBe('REVOKED');
  });
});

describe('reading a thread', () => {
  it('returns every message with its text, labels and attachments, without drafts', async () => {
    const res = await thread('thread-1');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = MailThreadSchema.parse(res.body);
    expect(body.subject).toBe('Interview: first round');
    expect(body.messages.map((message) => message.id)).toEqual(['msg-1', 'msg-2']);
    expect(body.messages[0]).toEqual({
      id: 'msg-1',
      from: 'Recruiter <recruiter@example.com>',
      to: 'owner@mailbox.test',
      cc: 'hr@example.com',
      date: '2026-10-01T09:00:00.000Z',
      subject: 'Interview: first round',
      labels: ['Inbox', 'Unread', 'Job search'],
      sentByUser: false,
      text: 'Please send dates.',
      html: '<p>Please send <b>dates</b>.</p>',
      truncated: false,
      attachments: [
        { partId: '1', filename: 'job description.pdf', mimeType: 'application/pdf', size: 1234 },
      ],
    });
    expect(body.messages[1]).toMatchObject({
      sentByUser: true,
      labels: ['Sent'],
      text: 'Tuesday works.',
      html: null,
      attachments: [],
    });
  });

  it('cuts an oversized text and says so', async () => {
    mocks.threadsGet.mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'big',
            payload: { mimeType: 'text/plain', body: { data: b64('x'.repeat(500_001)) } },
          },
        ],
      },
    });
    const [message] = (await thread('thread-big')).body.messages;
    expect(message.text).toHaveLength(500_000);
    expect(message.truncated).toBe(true);
  });

  it('answers 404 when Gmail no longer has the thread, and rejects a malformed ID', async () => {
    mocks.threadsGet.mockRejectedValueOnce({ status: 404 });
    expect((await thread('gone')).status).toBe(404);
    expect((await thread('bad%20id')).status).toBe(400);
  });
});

describe('downloading an attachment', () => {
  beforeEach(() => {
    mocks.messagesGet.mockResolvedValue({ data: FULL_THREAD.messages[0] });
    mocks.attachmentsGet.mockResolvedValue({ data: { data: b64('PDF BYTES') } });
  });

  it('sends the file as a download named by Gmail, never as a page', async () => {
    const res = await attachment('msg-1', '1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe('attachment; filename="job description.pdf"');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect((res.body as Buffer).toString('utf8')).toBe('PDF BYTES');
    expect(mocks.attachmentsGet).toHaveBeenCalledWith(
      { userId: 'me', messageId: 'msg-1', id: 'att-1' },
      expect.anything(),
    );
  });

  it('answers 404 for a part that is not a file, and 400 for a malformed part ID', async () => {
    expect((await attachment('msg-1', '0.0')).status).toBe(404);
    expect((await attachment('msg-1', '9')).status).toBe(404);
    expect((await attachment('msg-1', 'x')).status).toBe(400);
    expect(mocks.attachmentsGet).not.toHaveBeenCalled();
  });

  it('refuses a file above the size limit without downloading it', async () => {
    const message = structuredClone(FULL_THREAD.messages[0]);
    message.payload.parts![1].body = { attachmentId: 'att-1', size: 26 * 1024 * 1024 };
    mocks.messagesGet.mockResolvedValueOnce({ data: message });
    const res = await attachment('msg-1', '1');
    expect(res.status).toBe(413);
    expect(mocks.attachmentsGet).not.toHaveBeenCalled();
  });
});
