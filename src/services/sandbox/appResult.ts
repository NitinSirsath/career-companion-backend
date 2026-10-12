/**
 * What the app did with each sandbox mail, read from the app's own tables. The sandbox only
 * reports it: sending a sandbox mail never writes to those tables, a sync does.
 */
import type { SandboxMessage } from '@prisma/client';
import type { SandboxMailResult } from '../../contracts/sandbox';
import { prisma } from '../../db/prisma';
import { getAccessState } from '../ai/access';
import { SENT_LABELS } from './message';

type Mail = Pick<SandboxMessage, 'id' | 'labelIds'>;

export const sentByUser = (message: Pick<SandboxMessage, 'labelIds'>) =>
  SENT_LABELS.every((label) => message.labelIds.includes(label));

const result = (
  state: SandboxMailResult['state'],
  extra: Partial<SandboxMailResult> = {},
): SandboxMailResult => ({ state, failure: null, job: null, ...extra });

const synced = (userId: string, ids: string[]) =>
  prisma.email.findMany({
    where: { userId, gmailMessageId: { in: ids } },
    select: {
      gmailMessageId: true,
      threadId: true,
      relevanceState: true,
      processingState: true,
      processingErrorCategory: true,
      application: { select: { id: true, companyName: true, jobTitle: true } },
      aiProcessingResult: {
        select: { category: true, companyName: true, jobTitle: true, requestedAction: true },
      },
    },
  });
type SyncedMail = Awaited<ReturnType<typeof synced>>[number];

function receivedResult(mail: SyncedMail | undefined, aiKeyMissing: boolean): SandboxMailResult {
  if (!mail) return result('NOT_SYNCED');
  if (mail.processingState === 'FAILED')
    return result('AI_FAILED', { failure: mail.processingErrorCategory });
  if (mail.processingState !== 'COMPLETED')
    return result(aiKeyMissing ? 'AI_KEY_MISSING' : 'WAITING_FOR_AI');
  if (mail.relevanceState !== 'RELEVANT') return result('NOT_JOB_MAIL');
  return result('JOB_MAIL', {
    job: {
      category: mail.aiProcessingResult?.category ?? null,
      company: mail.aiProcessingResult?.companyName ?? null,
      role: mail.aiProcessingResult?.jobTitle ?? null,
      requestedAction: mail.aiProcessingResult?.requestedAction ?? null,
      conversationKey: mail.threadId ?? mail.gmailMessageId,
      application: mail.application,
    },
  });
}

/** The result for every given mail, by message ID. */
export async function sandboxMailResults(
  userId: string,
  messages: Mail[],
): Promise<Map<string, SandboxMailResult>> {
  const ids = messages.map((message) => message.id);
  const [received, replies, access] = await Promise.all([
    synced(userId, ids),
    prisma.outgoingEmail.findMany({
      where: { userId, gmailMessageId: { in: ids } },
      select: { gmailMessageId: true },
    }),
    getAccessState(userId),
  ]);
  const mails = new Map(received.map((mail) => [mail.gmailMessageId, mail]));
  const recorded = new Set(replies.map((reply) => reply.gmailMessageId));
  const aiKeyMissing = access.state === 'NOT_SET_UP';
  return new Map(
    messages.map((message) => {
      if (!sentByUser(message))
        return [message.id, receivedResult(mails.get(message.id), aiKeyMissing)];
      return [message.id, result(recorded.has(message.id) ? 'REPLY_RECORDED' : 'NOT_SYNCED')];
    }),
  );
}
