import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/gmailFetcher');
vi.mock('../services/ai/providers', () => ({ createProviderClient: vi.fn() }));
vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueNotificationJob: vi.fn(),
  enqueueReplyReading: vi.fn(),
}));

import { app } from '../index';
import { prisma } from '../db/prisma';
import { ConversationDetailSchema } from '../contracts';
import { ProviderFailure } from '../services/ai/errors';
import { createProviderClient } from '../services/ai/providers';
import { enqueueReplyReading } from '../services/enqueue';
import { fetchMessageBody } from '../services/gmailFetcher';
import { noteSentForReading, ownText, readSentReply } from '../services/replyReading';
import { askId } from '../services/threadAsks';
import { configureAI } from './helpers/aiAccess';
import { fakeProviderClient } from './helpers/fakeProviderClient';

const OWNER = 'owner@reply-reading.test';
let owner: string;
let counter = 0;
const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 9, day, hour));
const REPLY = 'Hi Priya,\n\nTuesday after 3 PM works for me.\n\nNitin';
const QUOTED = `${REPLY}\n\nOn Mon, Oct 22, 2026 at 10:42 AM Priya <priya@northwind.example> wrote:\n> Could you send me your free times for next week?`;

/** A received mail that asks for the user's free times, read before the reply. */
const askingMail = (threadId: string) =>
  prisma.email.create({
    data: {
      userId: owner,
      gmailMessageId: `reply-reading-${++counter}`,
      threadId,
      subject: 'Interview',
      sender: 'Priya <priya@northwind.example>',
      receivedAt: at(1),
      relevanceState: 'RELEVANT',
      processingState: 'COMPLETED',
      aiProcessingResult: {
        create: {
          provider: 'gemini',
          model: 'test-model',
          contractVersion: 'extraction/v6',
          processingStatus: 'COMPLETED',
          relevanceDecision: 'RELEVANT',
          actionRequired: true,
          requestedAction: 'Send your free times',
          askKind: 'REPLY_BY_MAIL',
        },
      },
    },
  });
const sentReply = (threadId: string, sentAt = at(2)) =>
  prisma.outgoingEmail.create({
    data: { userId: owner, gmailMessageId: `sent-${++counter}`, threadId, sentAt },
  });
const reads = (answeredAsks: string[] | ((input: string) => unknown)) => {
  const provider = fakeProviderClient({
    extraction: typeof answeredAsks === 'function' ? answeredAsks : () => ({ answeredAsks }),
  });
  vi.mocked(createProviderClient).mockReturnValue(provider);
  return provider;
};
const conversation = async (key: string) => {
  const res = await request(app)
    .get(`/api/conversations/${key}`)
    .set({ 'X-Development-User': OWNER });
  expect(res.status).toBe(200);
  return ConversationDetailSchema.parse(res.body).conversation;
};

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: OWNER } });
  owner = (await prisma.user.create({ data: { email: OWNER } })).id;
});
beforeEach(async () => {
  process.env.AI_USER_DAILY_CALL_LIMIT = '100';
  await configureAI(owner);
  await prisma.email.deleteMany({ where: { userId: owner } });
  await prisma.outgoingEmail.deleteMany({ where: { userId: owner } });
  await prisma.aIModelPause.deleteMany({ where: { userId: owner } });
  vi.mocked(enqueueReplyReading).mockReset();
  vi.mocked(fetchMessageBody).mockResolvedValue(QUOTED);
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: OWNER } });
});

describe("the user's own new text", () => {
  it('drops the quoted earlier mail and quoted lines', () => {
    expect(ownText(QUOTED)).toBe(REPLY);
    expect(ownText('Done, thanks!\n> old line\n-----Original Message-----\nFrom: x')).toBe(
      'Done, thanks!',
    );
    expect(ownText('> only quoted')).toBe('');
  });
});

describe('a sent reply is read only when something is open (COM-180)', () => {
  it('queues the read for a conversation with an open ask, and nothing otherwise', async () => {
    await askingMail('t-open');
    const open = await sentReply('t-open');
    await noteSentForReading(owner, open.id);
    expect(
      (await prisma.outgoingEmail.findUniqueOrThrow({ where: { id: open.id } })).replyReadState,
    ).toBe('WAITING');
    expect(enqueueReplyReading).toHaveBeenCalledWith(owner, open.id);
    expect((await conversation('t-open')).request).toMatchObject({
      state: 'REPLIED',
      replyRead: 'WAITING',
    });

    const quiet = await sentReply('t-nothing');
    await noteSentForReading(owner, quiet.id);
    expect(
      (await prisma.outgoingEmail.findUniqueOrThrow({ where: { id: quiet.id } })).replyReadState,
    ).toBeNull();
    expect(enqueueReplyReading).toHaveBeenCalledTimes(1);
  });

  it('closes the ask the reply answers, sending only the new text and the open asks', async () => {
    const ask = await askingMail('t-answer');
    const sent = await sentReply('t-answer');
    await noteSentForReading(owner, sent.id);
    const provider = reads([askId(ask.id), 'ask-madeup1']);
    const logs = vi.spyOn(console, 'log');
    expect(await readSentReply(owner, sent.id)).toBeNull();
    const [[call]] = provider.generateStructured.mock.calls;
    expect(call.contract.version).toBe('reply-read/v1');
    expect(JSON.parse(call.input)).toEqual({
      openAsks: [
        {
          id: askId(ask.id),
          ask: 'Send your free times',
          kind: 'REPLY_BY_MAIL',
          askedAt: at(1).toISOString(),
        },
      ],
      reply: REPLY,
    });
    expect(logs.mock.calls.flat().join('\n')).not.toContain('Tuesday after 3 PM');
    logs.mockRestore();
    expect(await prisma.email.findUniqueOrThrow({ where: { id: ask.id } })).toMatchObject({
      requestClosedReason: 'YOUR_REPLY',
      requestClosedByMessageId: sent.gmailMessageId,
    });
    expect(await prisma.outgoingEmail.findUniqueOrThrow({ where: { id: sent.id } })).toMatchObject({
      replyReadState: 'READ',
    });
    expect((await conversation('t-answer')).request).toMatchObject({
      state: 'DONE',
      closedReason: 'YOUR_REPLY',
      closedByMessageId: sent.gmailMessageId,
    });
    // The read is one call toward the daily safety limit.
    expect((await prisma.aIUsageDay.findFirstOrThrow({ where: { userId: owner } })).calls).toBe(1);
  });

  it('keeps the ask open when the reply does not answer it, and says so', async () => {
    await askingMail('t-later');
    const sent = await sentReply('t-later');
    await noteSentForReading(owner, sent.id);
    vi.mocked(fetchMessageBody).mockResolvedValue('I will send my times tomorrow.');
    reads([]);
    await readSentReply(owner, sent.id);
    expect((await conversation('t-later')).request).toMatchObject({
      state: 'OPEN',
      replyRead: 'NOT_ANSWERED',
      repliedAt: at(2).toISOString(),
    });
  });

  it('keeps "Replied" from the send time when the AI cannot read it', async () => {
    await askingMail('t-unread');
    const sent = await sentReply('t-unread');
    await noteSentForReading(owner, sent.id);
    await prisma.aIConfiguration.deleteMany({ where: { userId: owner } });
    expect(await readSentReply(owner, sent.id)).toBeNull();
    expect(
      (await prisma.outgoingEmail.findUniqueOrThrow({ where: { id: sent.id } })).replyReadState,
    ).toBe('NOT_READ');
    expect((await conversation('t-unread')).request).toMatchObject({
      state: 'REPLIED',
      replyRead: 'NOT_READ',
    });
  });

  it('tries a busy read again later, three times at most', async () => {
    await askingMail('t-busy');
    const sent = await sentReply('t-busy');
    await noteSentForReading(owner, sent.id);
    vi.mocked(createProviderClient).mockReturnValue({
      generateStructured: vi.fn().mockRejectedValue(new ProviderFailure('PROVIDER_BUSY')),
      verifyModels: vi.fn(),
    });
    const next = await readSentReply(owner, sent.id);
    expect(next).toBeInstanceOf(Date);
    expect(await prisma.outgoingEmail.findUniqueOrThrow({ where: { id: sent.id } })).toMatchObject({
      replyReadState: 'WAITING',
      replyReadTries: 1,
    });
    await prisma.aIModelPause.deleteMany({ where: { userId: owner } });
    await readSentReply(owner, sent.id);
    await prisma.aIModelPause.deleteMany({ where: { userId: owner } });
    expect(await readSentReply(owner, sent.id)).toBeNull();
    expect(await prisma.outgoingEmail.findUniqueOrThrow({ where: { id: sent.id } })).toMatchObject({
      replyReadState: 'NOT_READ',
      replyReadTries: 3,
    });
  });

  it('reads nothing when something else closed the ask meanwhile', async () => {
    const ask = await askingMail('t-closed');
    const sent = await sentReply('t-closed');
    await noteSentForReading(owner, sent.id);
    await prisma.email.update({
      where: { id: ask.id },
      data: { requestClosedReason: 'REPLACED_BY_MAIL', requestClosedAt: new Date() },
    });
    const provider = reads([]);
    expect(await readSentReply(owner, sent.id)).toBeNull();
    expect(provider.generateStructured).not.toHaveBeenCalled();
    expect(
      (await prisma.outgoingEmail.findUniqueOrThrow({ where: { id: sent.id } })).replyReadState,
    ).toBeNull();
  });
});
