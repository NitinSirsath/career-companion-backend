import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/ai/providers', () => ({ createProviderClient: vi.fn() }));
vi.mock('../services/mailbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/mailbox')>()),
  readMailThread: vi.fn(),
}));

import { app } from '../index';
import { prisma } from '../db/prisma';
import { ConversationDetailSchema, ReplyDraftResponseSchema } from '../contracts';
import type { MailMessage } from '../contracts/mailbox';
import { ProviderFailure } from '../services/ai/errors';
import { createProviderClient } from '../services/ai/providers';
import { readMailThread } from '../services/mailbox';
import { draftMessages } from '../services/replyDraft';
import { configureAI } from './helpers/aiAccess';
import { fakeProviderClient } from './helpers/fakeProviderClient';

const OWNER = 'owner@reply-draft.test';
let owner: string;
const as = () => ({ 'X-Development-User': OWNER });
const message = (fields: Partial<MailMessage>): MailMessage => ({
  id: 'm',
  from: 'Priya Nair <priya@northwind.example>',
  to: 'me@nitin.example',
  cc: null,
  date: '2026-10-22T10:42:00.000Z',
  subject: 'Interview',
  labels: [],
  sentByUser: false,
  text: null,
  html: null,
  truncated: false,
  attachments: [],
  ...fields,
});
const THREAD = [
  message({ id: 'a', text: 'Could you send me your free times for next week?' }),
  message({
    id: 'b',
    from: 'me@nitin.example',
    sentByUser: true,
    date: '2026-10-22T12:00:00.000Z',
    text: 'I will check and get back to you.\n\nOn Oct 22 Priya wrote:\n> Could you send me your free times',
  }),
  message({
    id: 'c',
    date: '2026-10-23T09:00:00.000Z',
    html: '<p>Any news on <b>your times</b>?</p>',
  }),
];
const draftFor = (body: object = {}) =>
  request(app).post('/api/conversations/t-draft/reply-draft').set(as()).send(body);

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: OWNER } });
  owner = (await prisma.user.create({ data: { email: OWNER, name: 'Nitin Sirsath' } })).id;
  await prisma.email.create({
    data: {
      userId: owner,
      gmailMessageId: 'draft-1',
      threadId: 't-draft',
      sender: 'Priya Nair <priya@northwind.example>',
      receivedAt: new Date('2026-10-23T09:00:00Z'),
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
          replyChoices: ['Send my free times', 'Decline politely'],
        },
      },
    },
  });
});
beforeEach(async () => {
  process.env.AI_USER_DAILY_CALL_LIMIT = '100';
  await configureAI(owner);
  await prisma.aIUsageDay.deleteMany({ where: { userId: owner } });
  await prisma.aIModelPause.deleteMany({ where: { userId: owner } });
  vi.mocked(readMailThread).mockResolvedValue({
    threadId: 't-draft',
    subject: 'Interview',
    messages: THREAD,
    replyTo: 'Priya Nair <priya@northwind.example>',
    replyCc: [],
  });
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: OWNER } });
});

describe('reply choices and "Write with AI" (COM-197)', () => {
  it("gives the newest job mail's reply choices with the conversation", async () => {
    const res = await request(app).get('/api/conversations/t-draft').set(as());
    expect(ConversationDetailSchema.parse(res.body).replyChoices).toEqual([
      'Send my free times',
      'Decline politely',
    ]);
  });

  it('sends the whole conversation, both sides, without quoted copies', () => {
    expect(draftMessages(THREAD)).toEqual([
      {
        from: 'them',
        name: 'Priya Nair',
        sentAt: '2026-10-22T10:42:00.000Z',
        text: 'Could you send me your free times for next week?',
      },
      {
        from: 'you',
        name: 'me@nitin.example',
        sentAt: '2026-10-22T12:00:00.000Z',
        text: 'I will check and get back to you.',
      },
      {
        from: 'them',
        name: 'Priya Nair',
        sentAt: '2026-10-23T09:00:00.000Z',
        text: 'Any news on your times ?',
      },
    ]);
    const long = Array.from({ length: 30 }, (_, i) =>
      message({ id: `${i}`, text: 'x'.repeat(2000) }),
    );
    const sent = draftMessages(long);
    expect(sent.at(-1)!.text).toHaveLength(2000);
    expect(sent.slice(0, -1).every((m) => m.text.length === 1000)).toBe(true);
    expect(sent.reduce((sum, m) => sum + m.text.length, 0)).toBeLessThanOrEqual(12_000);
  });

  it('writes a draft from a choice and a hint: plain text and its structure, never stored', async () => {
    const provider = fakeProviderClient({
      extraction: () => ({
        draft: 'Hi Priya,\n\nI am free:\n- **Tuesday** after 3 PM\n\nBest,\nNitin',
      }),
    });
    vi.mocked(createProviderClient).mockReturnValue(provider);
    const res = await draftFor({ choice: 'Send my free times', hint: "I'm free Tue after 3" });
    expect(res.status).toBe(200);
    const body = ReplyDraftResponseSchema.parse(res.body);
    expect(body.text).toBe('Hi Priya,\n\nI am free:\n\n- Tuesday after 3 PM\n\nBest,\nNitin');
    expect(body.doc.content.map((block) => block.type)).toEqual([
      'paragraph',
      'paragraph',
      'bulletList',
      'paragraph',
    ]);
    const [[call]] = provider.generateStructured.mock.calls;
    expect(call.contract.version).toBe('reply-draft/v1');
    expect(call.model.id).toBe('gemini-3.8-flash');
    expect(JSON.parse(call.input)).toMatchObject({
      choice: 'Send my free times',
      hint: "I'm free Tue after 3",
      userName: 'Nitin',
    });
    // Only what AI_DATA_SENT_SUMMARY and the privacy policy name. A new field needs both changed.
    expect(Object.keys(JSON.parse(call.input)).sort()).toEqual([
      'choice',
      'hint',
      'messages',
      'userName',
    ]);
    expect((await prisma.aIUsageDay.findFirstOrThrow({ where: { userId: owner } })).calls).toBe(1);
  });

  it('says why when the AI cannot write now, and when its answer is unusable', async () => {
    vi.mocked(createProviderClient).mockReturnValue({
      generateStructured: vi.fn().mockRejectedValue(new ProviderFailure('PROVIDER_BUSY')),
      verifyModels: vi.fn(),
    });
    const busy = await draftFor();
    expect(busy.status).toBe(409);
    expect(busy.body.error).toMatchObject({
      code: 'AI_ACCESS_UNAVAILABLE',
      details: { reason: 'PROVIDER_BUSY' },
    });

    process.env.AI_USER_DAILY_CALL_LIMIT = '0';
    await prisma.aIModelPause.deleteMany({ where: { userId: owner } });
    expect((await draftFor()).body.error.details.reason).toBe('PAUSED');
    process.env.AI_USER_DAILY_CALL_LIMIT = '100';

    vi.mocked(createProviderClient).mockReturnValue(
      fakeProviderClient({ extraction: { draft: '   ' } }),
    );
    const empty = await draftFor();
    expect(empty.status).toBe(502);
    expect(empty.body.error.code).toBe('AI_DRAFT_FAILED');

    await prisma.aIConfiguration.deleteMany({ where: { userId: owner } });
    const none = await draftFor();
    expect(none.body.error.details).toMatchObject({ reason: 'NOT_SET_UP' });
  });

  it('refuses a draft when nobody else wrote in the conversation', async () => {
    vi.mocked(readMailThread).mockResolvedValue({
      threadId: 't-draft',
      subject: 'Interview',
      messages: [THREAD[1]],
      replyTo: null,
      replyCc: [],
    });
    const res = await draftFor();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MAIL_REPLY_NO_RECIPIENT');
  });
});
