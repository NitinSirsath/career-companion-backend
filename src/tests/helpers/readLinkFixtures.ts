/**
 * Made-up job mails for the reading and linking tests: a new mail that goes through the real mail
 * job with a fake AI's answers, and what NorthList Apply reports. Every name here is made up.
 */
import type { JobWithMetadata } from 'pg-boss';
import { vi } from 'vitest';
import { prisma } from '../../db/prisma';
import { processEmailJob } from '../../jobs/emailProcessingJob';
import { JobExtractionV6Schema } from '../../services/ai/contracts';
import { createProviderClient } from '../../services/ai/providers';
import type { EmailProcessingJobData } from '../../services/enqueue';
import { fakeProviderClient } from './fakeProviderClient';

/** A moment in November 2026 (UTC). */
export const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 10, day, hour));

export const mailJob = (userId: string, emailId: string) =>
  ({
    id: `job-${emailId}`,
    data: { userId, emailId },
    retryCount: 0,
    retryLimit: 3,
  }) as JobWithMetadata<EmailProcessingJobData>;

/** Every field the reader answers, empty, plus the given ones. */
export const read = (fields: Record<string, unknown> = {}) =>
  JobExtractionV6Schema.parse({
    ...Object.fromEntries(Object.keys(JobExtractionV6Schema.shape).map((key) => [key, null])),
    ...fields,
  });

export const sortedAs = (category: string) => ({
  decision: 'RELEVANT',
  category,
  confidence: 0.95,
  reasoning: 'fixture',
});

export type NewMail = { subject: string; sender: string; thread?: string; receivedAt?: Date };

let counter = 0;
export const newMail = (userId: string, mail: NewMail) =>
  prisma.email.create({
    data: {
      userId,
      gmailMessageId: `readlink-${++counter}`,
      threadId: mail.thread ?? `t-readlink-${counter}`,
      subject: mail.subject,
      sender: mail.sender,
      receivedAt: mail.receivedAt ?? at(20),
    },
  });

/**
 * Sorts and reads one new mail with the fake AI's answers, as the mail job does. The test file
 * mocks `services/ai/providers` and `services/gmailFetcher`.
 */
export async function readNewMail(
  userId: string,
  mail: NewMail,
  category: string,
  answer: Record<string, unknown> = {},
) {
  const provider = fakeProviderClient({
    classification: sortedAs(category),
    extraction: read(answer),
  });
  vi.mocked(createProviderClient).mockReturnValue(provider);
  const row = await newMail(userId, mail);
  await processEmailJob(mailJob(userId, row.id));
  const saved = await prisma.email.findUniqueOrThrow({
    where: { id: row.id },
    include: { aiProcessingResult: true, actions: true },
  });
  return { provider, saved, result: saved.aiProcessingResult! };
}

/** A job mail read before, with its AI read saved as it stands. */
export const storedMail = (
  userId: string,
  mail: NewMail & { thread: string },
  result: Record<string, unknown>,
) =>
  prisma.email.create({
    data: {
      userId,
      gmailMessageId: `readlink-${++counter}`,
      threadId: mail.thread,
      subject: mail.subject,
      sender: mail.sender,
      receivedAt: mail.receivedAt ?? at(20),
      relevanceState: 'RELEVANT',
      processingState: 'COMPLETED',
      aiProcessingResult: {
        create: {
          provider: 'fixture',
          model: 'fixture',
          contractVersion: 'extraction/v10',
          processingStatus: 'COMPLETED',
          relevanceDecision: 'RELEVANT',
          ...result,
        },
      },
    },
  });

export const mailOf = (id: string) =>
  prisma.email.findUniqueOrThrow({ where: { id }, include: { aiProcessingResult: true } });

let ref = 0;
/** One job as NorthList Apply reports it. */
export const submission = (company: string, jobTitle: string) => ({
  sourceRecordRef: `2026-11-20/10:00:${String(++ref).padStart(2, '0')}`,
  platform: 'linkedin',
  company,
  jobTitle,
  submittedAt: '2026-11-20T10:00:00+05:30',
});
