/**
 * What the app did with each sandbox mail, read from the app's own tables. The sandbox only
 * reports it: sending a sandbox mail never writes to those tables, a sync does.
 */
import type { SandboxMessage } from '@prisma/client';
import type { SandboxMailResult } from '../../contracts/sandbox';
import { prisma } from '../../db/prisma';
import { UserAccess, getAccessState } from '../ai/access';
import { STATUS_STEP_SELECT, aiStatusOf } from '../ai/mailStatus';
import { SENT_LABELS } from './message';
import { FAKE_OFFER_NEXT_STEP } from '../emailRequest';

type Mail = Pick<SandboxMessage, 'id' | 'labelIds'>;

export const sentByUser = (message: Pick<SandboxMessage, 'labelIds'>) =>
  SENT_LABELS.every((label) => message.labelIds.includes(label));

const result = (
  state: SandboxMailResult['state'],
  extra: Partial<SandboxMailResult> = {},
): SandboxMailResult => ({ state, failure: null, aiStatus: null, job: null, ...extra });

const synced = (userId: string, ids: string[]) =>
  prisma.email.findMany({
    where: { userId, gmailMessageId: { in: ids } },
    select: {
      id: true,
      gmailMessageId: true,
      threadId: true,
      relevanceState: true,
      processingState: true,
      processingErrorCategory: true,
      application: { select: { id: true, companyName: true, jobTitle: true } },
      aiProcessingResult: {
        select: {
          category: true,
          companyName: true,
          jobTitle: true,
          requestedAction: true,
          fakeOfferWarning: true,
          processingStatus: true,
        },
      },
      aiOperations: { select: STATUS_STEP_SELECT },
    },
  });
type SyncedMail = Awaited<ReturnType<typeof synced>>[number];

function receivedResult(mail: SyncedMail | undefined, access: UserAccess): SandboxMailResult {
  if (!mail) return result('NOT_SYNCED');
  // Why it is not read yet, as on the Gmail Sync row.
  const aiStatus = aiStatusOf(mail, access, new Date());
  if (mail.processingState === 'FAILED')
    return result('AI_FAILED', { failure: mail.processingErrorCategory, aiStatus });
  if (mail.processingState !== 'COMPLETED')
    return result(access.state === 'NOT_SET_UP' ? 'AI_KEY_MISSING' : 'WAITING_FOR_AI', {
      aiStatus,
    });
  if (mail.relevanceState !== 'RELEVANT') return result('NOT_JOB_MAIL');
  return result('JOB_MAIL', { job: jobOf(mail) });
}

/** What the AI read from a job mail, and where the mail went. */
function jobOf(mail: SyncedMail): SandboxMailResult['job'] {
  const read = mail.aiProcessingResult;
  const fakeOfferWarning = read?.fakeOfferWarning ?? null;
  return {
    category: read?.category ?? null,
    company: read?.companyName ?? null,
    role: read?.jobTitle ?? null,
    // A mail that asks for money never shows its own request.
    requestedAction: fakeOfferWarning ? FAKE_OFFER_NEXT_STEP : (read?.requestedAction ?? null),
    fakeOfferWarning,
    conversationKey: mail.threadId ?? mail.gmailMessageId,
    application: mail.application,
  };
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
  return new Map(
    messages.map((message) => {
      if (!sentByUser(message)) return [message.id, receivedResult(mails.get(message.id), access)];
      return [message.id, result(recorded.has(message.id) ? 'REPLY_RECORDED' : 'NOT_SYNCED')];
    }),
  );
}
