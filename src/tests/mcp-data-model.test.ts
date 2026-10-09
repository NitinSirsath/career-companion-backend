// MCP-01: ownership triggers and constraints of the automation submissions migration (ADR-0002).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';

const DOMAIN = '@mcp-model.test';
let alice: string;
let bob: string;

const token = (userId: string) =>
  prisma.integrationToken.create({
    data: {
      userId,
      name: 'laptop',
      tokenHash: crypto.randomBytes(32).toString('hex'),
      displayPrefix: 'ccmcp_abcdef',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
const app = (userId: string) =>
  prisma.application.create({ data: { userId, companyName: 'Acme' } });
const submission = (
  userId: string,
  ref: string,
  data: Partial<Prisma.ExternalSubmissionUncheckedCreateInput> = {},
) =>
  prisma.externalSubmission.create({
    data: {
      userId,
      source: 'AUTOMATION',
      sourceRecordRef: ref,
      platform: 'linkedin',
      company: 'Acme',
      jobTitle: 'Engineer',
      submittedAt: new Date(),
      matchState: 'NEEDS_REVIEW',
      ...data,
    },
  });
const resolved = {
  matchState: 'LINKED' as const,
  resolvedBy: 'AUTOMATIC' as const,
  resolvedAt: new Date(),
};

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  alice = (await prisma.user.create({ data: { email: `alice${DOMAIN}` } })).id;
  bob = (await prisma.user.create({ data: { email: `bob${DOMAIN}` } })).id;
});
beforeEach(async () => {
  await prisma.externalSubmission.deleteMany({ where: { userId: { in: [alice, bob] } } });
  await prisma.integrationToken.deleteMany({ where: { userId: { in: [alice, bob] } } });
  await prisma.application.deleteMany({ where: { userId: { in: [alice, bob] } } });
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
});

describe('ownership triggers', () => {
  it('rejects a submission linked to another user’s application, on insert and on update', async () => {
    const foreign = await app(bob);
    await expect(
      submission(alice, '2026-10-02/09:00:00', { ...resolved, applicationId: foreign.id }),
    ).rejects.toThrow(/ownership mismatch/);
    const own = await submission(alice, '2026-10-02/09:00:01');
    await expect(
      prisma.externalSubmission.update({
        where: { id: own.id },
        data: { ...resolved, applicationId: foreign.id },
      }),
    ).rejects.toThrow(/ownership mismatch/);
  });

  it('rejects a submission carrying another user’s token', async () => {
    const foreign = await token(bob);
    await expect(submission(alice, '2026-10-02/09:00:00', { tokenId: foreign.id })).rejects.toThrow(
      /ownership mismatch/,
    );
  });

  it('makes submission and token owners immutable', async () => {
    const own = await submission(alice, '2026-10-02/09:00:00');
    await expect(
      prisma.externalSubmission.update({ where: { id: own.id }, data: { userId: bob } }),
    ).rejects.toThrow(/immutable/);
    const t = await token(alice);
    await expect(
      prisma.integrationToken.update({ where: { id: t.id }, data: { userId: bob } }),
    ).rejects.toThrow(/immutable/);
  });

  it('rejects an event whose submission belongs to someone else', async () => {
    const own = await submission(alice, '2026-10-02/09:00:00');
    const foreign = await app(bob);
    await expect(
      prisma.applicationEvent.create({
        data: {
          applicationId: foreign.id,
          type: 'AUTOMATION_SUBMITTED',
          externalSubmissionId: own.id,
        },
      }),
    ).rejects.toThrow(/ownership mismatch/);
  });

  it('allows exactly one event per submission', async () => {
    const target = await app(alice);
    const own = await submission(alice, '2026-10-02/09:00:00', {
      ...resolved,
      applicationId: target.id,
    });
    const event = {
      applicationId: target.id,
      type: 'AUTOMATION_SUBMITTED',
      externalSubmissionId: own.id,
    };
    await prisma.applicationEvent.create({ data: event });
    await expect(prisma.applicationEvent.create({ data: event })).rejects.toMatchObject({
      code: 'P2002',
    });
  });
});

describe('constraints', () => {
  it('keeps one record per (user, source, ref) and allows the same ref for another user', async () => {
    await submission(alice, '2026-10-02/09:00:00');
    await expect(submission(alice, '2026-10-02/09:00:00')).rejects.toMatchObject({ code: 'P2002' });
    await expect(submission(bob, '2026-10-02/09:00:00')).resolves.toBeDefined();
  });

  it('ties resolvedBy and resolvedAt to a settled match state', async () => {
    await expect(
      submission(alice, '2026-10-02/09:00:00', { resolvedBy: 'USER', resolvedAt: new Date() }),
    ).rejects.toThrow();
    await expect(
      submission(alice, '2026-10-02/09:00:01', { matchState: 'IGNORED' }),
    ).rejects.toThrow();
    await expect(
      submission(alice, '2026-10-02/09:00:02', {
        matchState: 'IGNORED',
        resolvedBy: 'USER',
        resolvedAt: new Date(),
      }),
    ).resolves.toBeDefined();
  });

  it('rejects a malformed source reference and over-long confirmation text', async () => {
    await expect(submission(alice, '2026-10-02 09:00:00')).rejects.toThrow();
    await expect(
      submission(alice, '2026-10-02/09:00:00', { confirmationText: 'x'.repeat(301) }),
    ).rejects.toThrow();
  });
});

describe('deletion', () => {
  it('keeps the submission as evidence when its application or token is deleted', async () => {
    const target = await app(alice);
    const t = await token(alice);
    const own = await submission(alice, '2026-10-02/09:00:00', {
      ...resolved,
      applicationId: target.id,
      tokenId: t.id,
    });
    await prisma.applicationEvent.create({
      data: {
        applicationId: target.id,
        type: 'AUTOMATION_SUBMITTED',
        externalSubmissionId: own.id,
      },
    });
    await prisma.application.delete({ where: { id: target.id } });
    await prisma.integrationToken.delete({ where: { id: t.id } });
    const after = await prisma.externalSubmission.findUniqueOrThrow({ where: { id: own.id } });
    expect(after).toMatchObject({ applicationId: null, tokenId: null, matchState: 'LINKED' });
  });

  it('cascades a user deletion through tokens, submissions and their events', async () => {
    const temp = await prisma.user.create({ data: { email: `temp${DOMAIN}` } });
    const target = await app(temp.id);
    const t = await token(temp.id);
    const own = await submission(temp.id, '2026-10-02/09:00:00', {
      matchState: 'CREATED',
      resolvedBy: 'AUTOMATIC',
      resolvedAt: new Date(),
      applicationId: target.id,
      tokenId: t.id,
    });
    await prisma.applicationEvent.create({
      data: {
        applicationId: target.id,
        type: 'AUTOMATION_SUBMITTED',
        externalSubmissionId: own.id,
      },
    });
    await prisma.user.delete({ where: { id: temp.id } });
    expect(await prisma.externalSubmission.count({ where: { userId: temp.id } })).toBe(0);
    expect(await prisma.integrationToken.count({ where: { userId: temp.id } })).toBe(0);
    expect(await prisma.applicationEvent.count({ where: { externalSubmissionId: own.id } })).toBe(
      0,
    );
  });
});
