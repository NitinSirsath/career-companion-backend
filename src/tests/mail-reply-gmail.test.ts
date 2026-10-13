/**
 * A reply sent from the mail details page, in prod mode: through the real `withGmail`, against a
 * faked Google client. Covers the permission, what is handed to Gmail, and that a reply is never
 * sent twice whatever Gmail answers.
 */
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  threadsGet: vi.fn(),
  labelsList: vi.fn(),
  send: vi.fn(),
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
        threads: { get: mocks.threadsGet },
        labels: { list: mocks.labelsList },
        messages: { send: mocks.send },
      },
    }),
  },
}));

import { app } from '../index';
import { MailThreadSchema } from '../contracts';
import { prisma } from '../db/prisma';
import { buildReplyMail, recipientHeader, replySubject } from '../services/mailReply';
import { replyTarget } from '../services/mailbox';
import { fromRawMail } from '../services/sandbox/message';
import { encryptToken } from '../utils/gmailTokenEncryption';

const OWNER = 'owner@mail-reply-gmail.test';
const THREAD = '18c2f0a1b2c3d4e5';
const TEXT = 'REPLYSENTINEL Thursday at 3 pm works for me.';
let owner: string;

const as = { 'X-Development-User': OWNER };
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
const headers = (values: Record<string, string>) =>
  Object.entries(values).map(([name, value]) => ({ name, value }));
const message = (
  id: string,
  labelIds: string[],
  values: Record<string, string>,
  text: string | null = 'Please send dates.',
) => ({
  id,
  threadId: THREAD,
  labelIds,
  internalDate: String(Date.UTC(2026, 9, 12, 10, 2)),
  payload: {
    mimeType: 'multipart/alternative',
    headers: headers(values),
    parts:
      text === null ? [] : [{ partId: '0', mimeType: 'text/plain', body: { data: b64(text) } }],
  },
});
const FROM_RECRUITER = {
  From: 'Priya Raman <priya@northwind.example>',
  To: OWNER,
  Subject: 'Interview: first round',
  'Message-ID': '<m1@northwind.example>',
};
const recruiterMail = message('m1', ['INBOX'], FROM_RECRUITER);
const thread = (...messages: object[]) => ({ id: THREAD, messages });
/** A failure shaped like Google's own client's. */
const googleError = (status: number, reason?: string) =>
  Object.assign(new Error(`Google says ${status} REPLYSENTINEL`), {
    response: { status, data: { error: { errors: reason ? [{ reason }] : [] } } },
  });

const connect = (canSend: boolean) =>
  prisma.gmailConnection.create({
    data: {
      userId: owner,
      gmailEmail: OWNER,
      status: 'CONNECTED',
      canSend,
      accessToken: encryptToken('access'),
      refreshToken: encryptToken('refresh'),
    },
  });
const reply = (replyId = randomUUID(), text = TEXT) =>
  request(app).post(`/api/mailbox/threads/${THREAD}/replies`).set(as).send({ replyId, text });
const connection = () => prisma.gmailConnection.findUniqueOrThrow({ where: { userId: owner } });
const claims = () => prisma.mailReply.findMany({ where: { userId: owner } });
/** The mail handed to Gmail's send call, read back. */
const handedToGmail = () => {
  const { requestBody } = mocks.send.mock.calls[0][0] as {
    requestBody: { raw: string; threadId: string };
  };
  return {
    threadId: requestBody.threadId,
    text: Buffer.from(requestBody.raw, 'base64url').toString('utf8'),
    mail: fromRawMail(requestBody.raw),
  };
};

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: OWNER } });
  owner = (await prisma.user.create({ data: { email: OWNER } })).id;
});
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.credentials = {};
  await prisma.mailReply.deleteMany({ where: { userId: owner } });
  await prisma.outgoingEmail.deleteMany({ where: { userId: owner } });
  await prisma.email.deleteMany({ where: { userId: owner } });
  await prisma.gmailConnection.deleteMany({ where: { userId: owner } });
  mocks.threadsGet.mockResolvedValue({ data: thread(recruiterMail) });
  mocks.labelsList.mockResolvedValue({ data: { labels: [] } });
  mocks.send.mockResolvedValue({ data: { id: 'sent-1', threadId: THREAD, labelIds: ['SENT'] } });
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: owner } });
});

describe('who a reply goes to', () => {
  it('answers the newest mail from someone else, never the user’s own mail or a draft', () => {
    const target = replyTarget(
      thread(
        recruiterMail,
        message('m2', ['SENT'], { From: OWNER, To: 'priya@northwind.example' }),
        message('m3', ['INBOX'], {
          From: 'Dana Lee <dana@northwind.example>',
          Subject: 'Re: Interview: first round',
          'Message-ID': '<m3@northwind.example>',
          References: '<m1@northwind.example> <m2@mail.gmail.com>',
        }),
        message('m4', ['SENT'], { From: OWNER }),
        message('m5', ['DRAFT'], { From: 'draft@nowhere.example' }),
      ),
    );
    expect(target).toMatchObject({
      to: 'Dana Lee <dana@northwind.example>',
      messageId: '<m3@northwind.example>',
      references: '<m1@northwind.example> <m2@mail.gmail.com>',
    });
  });

  it('uses Reply-To when the mail has one', () => {
    const target = replyTarget(
      thread(
        message('m1', ['INBOX'], {
          ...FROM_RECRUITER,
          From: 'Northwind Careers <no-reply@ats.example>',
          'Reply-To': 'priya@northwind.example',
        }),
      ),
    );
    expect(target?.to).toBe('priya@northwind.example');
  });

  it('has nobody to reply to when only the user wrote, or the sender has no address', () => {
    expect(replyTarget(thread(message('m1', ['SENT'], { From: OWNER })))).toBeNull();
    expect(replyTarget(thread(message('m1', ['INBOX'], { From: 'undisclosed' })))).toBeNull();
    expect(replyTarget(thread())).toBeNull();
  });
});

describe('the mail the app builds', () => {
  const target = replyTarget(thread(recruiterMail))!;

  it('is a plain-text mail in the same thread, with the answered mail quoted', () => {
    const mail = buildReplyMail('Thursday works.\nAlex', target)!;
    const [head, body] = mail.split('\r\n\r\n');
    expect(head.split('\r\n')).toEqual([
      'To: Priya Raman <priya@northwind.example>',
      'Subject: Re: Interview: first round',
      'In-Reply-To: <m1@northwind.example>',
      'References: <m1@northwind.example>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
    ]);
    expect(body.split('\r\n').every((line) => line.length <= 76)).toBe(true);
    expect(Buffer.from(body, 'base64').toString('utf8')).toBe(
      'Thursday works.\nAlex\n\nOn Mon, 12 Oct 2026 10:02:00 GMT, Priya Raman <priya@northwind.example> wrote:\n> Please send dates.',
    );
  });

  it('does not stack "Re:" and keeps earlier references', () => {
    expect(replySubject('RE: Interview')).toBe('RE: Interview');
    expect(replySubject(null)).toBe('Re:');
    const mail = buildReplyMail('Ok', {
      ...target,
      references: '<m0@northwind.example>',
    })!;
    expect(mail).toContain('References: <m0@northwind.example> <m1@northwind.example>');
  });

  it('writes text outside ASCII in a way every mail server reads, and the sandbox reads it back', () => {
    const subject =
      'Intervju – første runde hos Blåbærsyltetøy AS, velkommen til samtale på mandag';
    const mail = buildReplyMail('Hei Søren, mandag passer. 👍', {
      ...target,
      to: 'Søren Ærø <soren@blabar.example>',
      subject,
    })!;
    const head = mail.split('\r\n\r\n')[0];
    expect(/^[\x20-\x7e\r\n]*$/.test(head)).toBe(true);
    // The name cannot be written in ASCII, so only the address is kept.
    expect(head).toContain('To: soren@blabar.example\r\n');
    const back = fromRawMail(b64(mail))!;
    expect(back.subject).toBe(`Re: ${subject}`);
    expect(back.body.startsWith('Hei Søren, mandag passer. 👍\n\nOn ')).toBe(true);
  });

  it('never lets a header of the answered mail start a new header line', () => {
    const mail = buildReplyMail('Ok', {
      ...target,
      to: 'Priya <priya@northwind.example>\r\nBcc: attacker@evil.example',
      subject: 'Hello\r\nBcc: attacker@evil.example',
      messageId: '<m1@northwind.example>\r\nBcc: attacker@evil.example',
      from: 'Priya\r\nBcc: attacker@evil.example',
    })!;
    const head = mail.split('\r\n\r\n')[0];
    expect(head.split('\r\n').filter((line) => /^bcc:/i.test(line))).toEqual([]);
    expect(head.split('\r\n')).toHaveLength(7);
  });

  it('sends without a quote when the answered mail has no plain text, and not at all without an address', () => {
    const noText = replyTarget(thread(message('m1', ['INBOX'], FROM_RECRUITER, null)))!;
    expect(fromRawMail(b64(buildReplyMail('Ok', noText)!))?.body).toBe('Ok');
    expect(recipientHeader('Søren <søren@blåbær.example>')).toBeNull();
    expect(buildReplyMail('Ok', { ...target, to: 'Søren <søren@blåbær.example>' })).toBeNull();
  });
});

describe('the send permission', () => {
  it('refuses a connection that may only read, before anything is asked of Gmail', async () => {
    await connect(false);
    const res = await reply();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('GMAIL_SEND_NOT_ALLOWED');
    expect(mocks.threadsGet).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(await claims()).toEqual([]);
  });

  it('refuses a user with no Gmail connection', async () => {
    const res = await reply();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GMAIL_NOT_CONNECTED');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('learns from Gmail that sending is not allowed after all, and lets the same reply go later', async () => {
    await connect(true);
    mocks.send.mockRejectedValueOnce(googleError(403, 'insufficientPermissions'));
    const replyId = randomUUID();
    const refused = await reply(replyId);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('GMAIL_SEND_NOT_ALLOWED');
    expect(JSON.stringify(refused.body)).not.toContain('REPLYSENTINEL');
    expect((await connection()).canSend).toBe(false);
    expect(await claims()).toEqual([]);

    // After "Allow sending" the same reply, with the same ID, goes out.
    await prisma.gmailConnection.update({ where: { userId: owner }, data: { canSend: true } });
    expect((await reply(replyId)).status).toBe(200);
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });
});

describe('sending through Gmail', () => {
  beforeEach(async () => {
    await connect(true);
  });

  it('says who the reply goes to when the conversation is read', async () => {
    const read = MailThreadSchema.parse(
      (await request(app).get(`/api/mailbox/threads/${THREAD}`).set(as)).body,
    );
    expect(read.replyTo).toBe('Priya Raman <priya@northwind.example>');
  });

  it('hands Gmail one mail for the thread, to the sender, and answers with its ID', async () => {
    const res = await reply();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'sent-1', threadId: THREAD });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const handed = handedToGmail();
    expect(handed.threadId).toBe(THREAD);
    expect(handed.mail).toMatchObject({
      to: 'Priya Raman <priya@northwind.example>',
      subject: 'Re: Interview: first round',
      inReplyTo: '<m1@northwind.example>',
      references: '<m1@northwind.example>',
    });
    expect(handed.mail?.body.startsWith(`${TEXT}\n\nOn `)).toBe(true);
    // No hidden retry by Google's client either.
    expect(mocks.send.mock.calls[0][1]).toMatchObject({ retryConfig: { retry: 0 } });
  });

  it('notes the reply at once in a conversation the app holds, and only there', async () => {
    expect((await reply()).status).toBe(200);
    expect(await prisma.outgoingEmail.count({ where: { userId: owner } })).toBe(0);

    await prisma.email.create({ data: { userId: owner, gmailMessageId: 'm1', threadId: THREAD } });
    mocks.send.mockResolvedValueOnce({ data: { id: 'sent-2', threadId: THREAD } });
    expect((await reply()).status).toBe(200);
    expect(await prisma.outgoingEmail.findMany({ where: { userId: owner } })).toMatchObject([
      { gmailMessageId: 'sent-2', threadId: THREAD },
    ]);
  });

  it('answers a repeated request from its note and sends nothing again', async () => {
    const replyId = randomUUID();
    const first = await reply(replyId);
    const again = await reply(replyId);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a server error', () => googleError(500)],
    ['a gateway timeout', () => googleError(504)],
    ['no answer at all', () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
  ])(
    'after %s it cannot confirm the send, and never sends that reply again',
    async (_label, fail) => {
      mocks.send.mockRejectedValueOnce(fail());
      const replyId = randomUUID();
      const first = await reply(replyId);
      expect(first.status).toBe(502);
      expect(first.body.error.code).toBe('MAIL_REPLY_UNCONFIRMED');
      expect(JSON.stringify(first.body)).not.toContain('REPLYSENTINEL');

      const again = await reply(replyId);
      expect(again.status).toBe(502);
      expect(again.body.error.code).toBe('MAIL_REPLY_UNCONFIRMED');
      expect(mocks.send).toHaveBeenCalledTimes(1);
      expect(await claims()).toMatchObject([{ id: replyId, gmailMessageId: null }]);
      // Sending again is the user's own decision: a new reply ID.
      expect((await reply()).status).toBe(200);
      expect(mocks.send).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['Gmail limits requests (429)', () => googleError(429), 502, 'GMAIL_UNAVAILABLE'],
    [
      'Gmail limits requests (403)',
      () => googleError(403, 'userRateLimitExceeded'),
      502,
      'GMAIL_UNAVAILABLE',
    ],
    ['Gmail refuses the mail', () => googleError(400), 400, 'BAD_REQUEST'],
    ['the thread is gone', () => googleError(404), 404, 'NOT_FOUND'],
  ])(
    'when %s nothing was sent, and the same reply can be sent again',
    async (_label, fail, status, code) => {
      mocks.send.mockRejectedValueOnce(fail());
      const replyId = randomUUID();
      const refused = await reply(replyId);
      expect(refused.status).toBe(status);
      expect(refused.body.error.code).toBe(code);
      expect((await connection()).canSend).toBe(true);
      expect(await claims()).toEqual([]);
      expect((await reply(replyId)).status).toBe(200);
    },
  );

  it('sends nothing when the conversation cannot be read or has nobody to reply to', async () => {
    mocks.threadsGet.mockRejectedValueOnce(googleError(404));
    expect((await reply()).status).toBe(404);
    mocks.threadsGet.mockResolvedValueOnce({
      data: thread(message('m1', ['SENT'], { From: OWNER })),
    });
    const res = await reply();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MAIL_REPLY_NO_RECIPIENT');
    expect(mocks.send).not.toHaveBeenCalled();
    expect(await claims()).toEqual([]);
  });

  it('marks the connection as ended when Google rejects the grant, and sends nothing twice', async () => {
    mocks.send.mockRejectedValueOnce(googleError(401));
    const res = await reply();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GMAIL_NOT_CONNECTED');
    expect((await connection()).status).toBe('REVOKED');
    expect(await claims()).toEqual([]);
  });

  it('writes no text of the reply into any table or log line', async () => {
    const logs: string[] = [];
    for (const method of ['log', 'warn', 'error'] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });
    await prisma.email.create({ data: { userId: owner, gmailMessageId: 'm1', threadId: THREAD } });
    await reply();
    mocks.send.mockRejectedValueOnce(googleError(500));
    await reply();
    vi.restoreAllMocks();
    expect(logs.join('\n')).not.toContain('REPLYSENTINEL');
    const tables = await prisma.$queryRaw<{ name: string }[]>`
      SELECT tablename AS name FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    for (const { name } of tables) {
      const rows = await prisma.$queryRawUnsafe<{ row: string }[]>(
        `SELECT row_to_json(t)::text AS row FROM "${name}" t`,
      );
      expect(JSON.stringify(rows), name).not.toContain('REPLYSENTINEL');
    }
  });
});
