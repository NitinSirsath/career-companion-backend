import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { prisma } from '../db/prisma';
import { sandboxGmail } from '../services/sandbox/gmail';

const OWNER = 'owner@sandbox-gmail.test';
const OTHER = 'other@sandbox-gmail.test';
let owner: string;
let other: string;

const DAY = 86_400_000;
let nextId = 1;
/** Stores one sandbox message directly, so a test can choose its age and labels. */
async function store(
  userId: string,
  historyId: number,
  extra: { threadId?: string; labelIds?: string[]; ageDays?: number; body?: string } = {},
) {
  const id = (nextId++).toString(16).padStart(16, '0');
  await prisma.sandboxMessage.create({
    data: {
      id,
      userId,
      threadId: extra.threadId ?? id,
      historyId,
      labelIds: extra.labelIds ?? ['INBOX', 'CATEGORY_PERSONAL'],
      sender: 'Priya Raman <priya@northwind.example>',
      recipient: OWNER,
      subject: `Mail ${historyId}`,
      messageId: `<${id}@sandbox.mail>`,
      body: extra.body ?? `Body of mail ${historyId}`,
      internalDate: new Date(Date.now() - (extra.ageDays ?? 0) * DAY - (100 - historyId) * 1000),
    },
  });
  return id;
}
const status = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (err: { status?: number }) => err.status,
  );

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: [OWNER, OTHER] } } });
  owner = (await prisma.user.create({ data: { email: OWNER } })).id;
  other = (await prisma.user.create({ data: { email: OTHER } })).id;
});
beforeEach(async () => {
  await prisma.sandboxMessage.deleteMany({ where: { userId: { in: [owner, other] } } });
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } });
});

describe('the sandbox as a Gmail client', () => {
  it('answers every Gmail call the app makes', () => {
    const calls = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!['tests', 'sandbox', 'eval'].includes(entry.name)) walk(file);
        } else if (file.endsWith('.ts')) {
          for (const call of fs
            .readFileSync(file, 'utf8')
            .matchAll(/gmail\.users\.([A-Za-z.]+)\(/g))
            calls.add(call[1]);
        }
      }
    };
    walk(path.resolve(__dirname, '..'));
    // The scan itself must keep working: these are the calls the app is known to make.
    expect([...calls].sort()).toEqual(
      expect.arrayContaining(['getProfile', 'history.list', 'messages.get', 'messages.list']),
    );
    const client = sandboxGmail(owner) as unknown as { users: Record<string, unknown> };
    const missing = [...calls].filter((call) => {
      const target = call
        .split('.')
        .reduce<unknown>(
          (at, key) => (at as Record<string, unknown> | undefined)?.[key],
          client.users,
        );
      return typeof target !== 'function';
    });
    expect(missing).toEqual([]);
  });

  it('reports the mailbox address and its newest history number', async () => {
    const gmail = sandboxGmail(owner);
    expect((await gmail.users.getProfile({ userId: 'me' })).data).toMatchObject({
      emailAddress: OWNER,
      historyId: '0',
    });
    await store(owner, 1);
    await store(owner, 2);
    await store(other, 1);
    expect((await gmail.users.getProfile({ userId: 'me' })).data.historyId).toBe('2');
  });

  it('lists messages by label and age, newest first, in pages', async () => {
    const old = await store(owner, 1, { ageDays: 3 });
    const a = await store(owner, 2);
    const sent = await store(owner, 3, { labelIds: ['SENT'] });
    const b = await store(owner, 4);
    await store(other, 1);
    const gmail = sandboxGmail(owner);
    const list = async (params: object) =>
      (await gmail.users.messages.list({ userId: 'me', ...params })).data;

    expect((await list({ labelIds: ['INBOX'] })).messages?.map((m) => m.id)).toEqual([b, a, old]);
    expect(
      (await list({ labelIds: ['INBOX'], q: 'newer_than:1d' })).messages?.map((m) => m.id),
    ).toEqual([b, a]);
    expect((await list({ labelIds: ['SENT'], q: 'newer_than:1d' })).messages).toEqual([
      { id: sent, threadId: sent },
    ]);

    const first = await list({ labelIds: ['INBOX'], maxResults: 2 });
    expect(first.messages?.map((m) => m.id)).toEqual([b, a]);
    expect(first.nextPageToken).toBe('2');
    const second = await list({
      labelIds: ['INBOX'],
      maxResults: 2,
      pageToken: first.nextPageToken,
    });
    expect(second.messages?.map((m) => m.id)).toEqual([old]);
    expect(second.nextPageToken).toBeUndefined();
  });

  it('refuses a search it does not know, instead of ignoring it', async () => {
    const gmail = sandboxGmail(owner);
    expect(await status(gmail.users.messages.list({ userId: 'me', q: 'from:someone' }))).toBe(400);
    expect(await status(gmail.users.messages.list({ userId: 'me', pageToken: 'abc' }))).toBe(400);
  });

  it('answers 404 for a message or thread that is not in this mailbox', async () => {
    const theirs = await store(other, 1);
    const gmail = sandboxGmail(owner);
    expect(await status(gmail.users.messages.get({ userId: 'me', id: theirs }))).toBe(404);
    expect(await status(gmail.users.messages.get({ userId: 'me', id: 'ffffffffffffffff' }))).toBe(
      404,
    );
    expect(await status(gmail.users.threads.get({ userId: 'me', id: theirs }))).toBe(404);
    expect(
      await status(
        gmail.users.messages.attachments.get({ userId: 'me', messageId: theirs, id: 'x' }),
      ),
    ).toBe(404);
  });

  it('lists what was added since a history number, oldest first, in pages', async () => {
    await store(owner, 1);
    const b = await store(owner, 2, { labelIds: ['SENT'] });
    const c = await store(owner, 3);
    const d = await store(owner, 4);
    await store(other, 5);
    const gmail = sandboxGmail(owner);
    const history = async (params: object) =>
      (await gmail.users.history.list({ userId: 'me', ...params })).data;

    const all = await history({
      startHistoryId: '1',
      historyTypes: ['messageAdded', 'labelAdded'],
    });
    expect(all.history?.map((h) => h.id)).toEqual(['2', '3', '4']);
    expect(all.history?.[0].messagesAdded?.[0].message).toEqual({
      id: b,
      threadId: b,
      labelIds: ['SENT'],
    });
    expect(all.historyId).toBe('4');
    expect(all.nextPageToken).toBeUndefined();

    const first = await history({ startHistoryId: '1', maxResults: 2 });
    expect(first.history?.map((h) => h.messagesAdded?.[0].message?.id)).toEqual([b, c]);
    expect(first.nextPageToken).toBe('3');
    const second = await history({ startHistoryId: '1', maxResults: 2, pageToken: '3' });
    expect(second.history?.map((h) => h.messagesAdded?.[0].message?.id)).toEqual([d]);
    expect(second.historyId).toBe('4');

    const nothing = await history({ startHistoryId: '4' });
    expect(nothing.history).toEqual([]);
    // The checkpoint never runs ahead of what the answer covers.
    expect(nothing.historyId).toBe('4');
    expect(await status(gmail.users.history.list({ userId: 'me', startHistoryId: 'abc' }))).toBe(
      400,
    );
  });

  it('lists and reads threads as Gmail does', async () => {
    const first = await store(owner, 1, { body: 'First mail' });
    await store(owner, 2, { threadId: first, labelIds: ['SENT'], body: 'My answer' });
    const second = await store(owner, 3, { body: 'Another conversation' });
    const gmail = sandboxGmail(owner);

    const inbox = (await gmail.users.threads.list({ userId: 'me', labelIds: ['INBOX'] })).data;
    expect(inbox.threads).toEqual([
      { id: second, snippet: 'Another conversation', historyId: '3' },
      { id: first, snippet: 'My answer', historyId: '2' },
    ]);
    const paged = (
      await gmail.users.threads.list({ userId: 'me', labelIds: ['INBOX'], maxResults: 1 })
    ).data;
    expect(paged.threads?.map((t) => t.id)).toEqual([second]);
    expect(paged.nextPageToken).toBe('1');

    const thread = (await gmail.users.threads.get({ userId: 'me', id: first, format: 'full' }))
      .data;
    expect(thread.messages?.map((m) => m.labelIds)).toEqual([
      ['INBOX', 'CATEGORY_PERSONAL'],
      ['SENT'],
    ]);
    expect(thread.historyId).toBe('2');

    const labels = (await gmail.users.labels.list({ userId: 'me' })).data.labels ?? [];
    expect(labels.every((label) => label.type === 'system')).toBe(true);
  });
});
