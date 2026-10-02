import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../db/prisma';
import { sealApiKey } from '../services/ai/credentials';

let userId: string;

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: '@ai-schema.test' } } });
  userId = (await prisma.user.create({ data: { email: 'owner@ai-schema.test' } })).id;
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: '@ai-schema.test' } } });
});

const configuration = (overrides: object = {}) => ({
  userId,
  provider: 'gemini',
  encryptedApiKey: sealApiKey(userId, 'fixture-key'),
  consentDisclosure: 'gemini-draft-2026-10',
  consentedAt: new Date(),
  ...overrides,
});

describe('AI configuration and usage persistence', () => {
  it('allows exactly one configuration per user', async () => {
    await prisma.aIConfiguration.create({ data: configuration() });
    await expect(prisma.aIConfiguration.create({ data: configuration() })).rejects.toThrow();
    await prisma.aIConfiguration.delete({ where: { userId } });
  });

  it.each([
    ['empty provider', { provider: '' }],
    ['unsealed key', { encryptedApiKey: 'sk-plaintext' }],
    ['negative failure count', { consecutiveFailures: -1 }],
  ])('rejects %s', async (_label, overrides) => {
    await expect(prisma.aIConfiguration.create({ data: configuration(overrides) })).rejects.toThrow();
  });

  it('rejects negative counters and malformed days', async () => {
    await expect(prisma.aIUsageDay.create({ data: { userId, day: '2026-10-02', calls: -1 } })).rejects.toThrow();
    await expect(prisma.aIUsageDay.create({ data: { userId, day: 'today' } })).rejects.toThrow();
  });

  it('removes the sealed key and usage with the user', async () => {
    const other = await prisma.user.create({ data: { email: 'cascade@ai-schema.test' } });
    await prisma.aIConfiguration.create({
      data: { ...configuration(), userId: other.id, encryptedApiKey: sealApiKey(other.id, 'k') },
    });
    await prisma.aIUsageDay.create({ data: { userId: other.id, day: '2026-10-02', calls: 3 } });
    await prisma.user.delete({ where: { id: other.id } });
    expect(await prisma.aIConfiguration.count({ where: { userId: other.id } })).toBe(0);
    expect(await prisma.aIUsageDay.count({ where: { userId: other.id } })).toBe(0);
  });

  it('defaults operation provenance and approvals for new ledger rows', async () => {
    const email = await prisma.email.create({ data: { userId, gmailMessageId: 'schema-op' } });
    const op = await prisma.aIOperation.create({ data: { emailId: email.id, operation: 'classification', version: 'v' } });
    expect(op).toMatchObject({ provider: null, model: null, approvedRetries: 0 });
    await expect(
      prisma.aIOperation.update({ where: { id: op.id }, data: { approvedRetries: -1 } }),
    ).rejects.toThrow();
  });
});
