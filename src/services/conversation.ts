/**
 * Job-mail conversations: what the Mails page lists and opens. Reads only stored metadata and AI
 * results; the email text itself is read live from Gmail by `mailbox.ts`.
 */
import { Prisma, type AIProcessingResult } from '@prisma/client';
import { prisma } from '../db/prisma';
import {
  deriveStatus,
  type ApplicationStatus,
  type Conversation,
  type ConversationDetail,
  type ConversationFilters,
  type ConversationMail,
  type ConversationRequest,
  type MailCategory,
  type SetRequestState,
} from '../contracts';
import { AppError, CHANGE_REJECTED } from '../errors';
import { lockUser, LOCK_NAMESPACE } from '../utils/advisoryLock';
import { updateActionStatus } from './action';
import {
  conversationRows,
  conversationsWhere,
  conversationWhere,
  isEmailId,
  type ConversationRow,
} from './conversationQuery';
import { canReplyTo, FAKE_OFFER_NEXT_STEP, requestOf } from './emailRequest';
import { CLOSES_BY_ITSELF, mayCloseByHand, OPEN_AGAIN } from './threadAsks';

type Db = Prisma.TransactionClient | typeof prisma;
type Mail = Prisma.EmailGetPayload<{ include: { aiProcessingResult: true } }>;

const applicationSummary = {
  id: true,
  companyName: true,
  jobTitle: true,
  aiStatus: true,
  userStatus: true,
  archivedAt: true,
} satisfies Prisma.ApplicationSelect;
type ApplicationSummary = Prisma.ApplicationGetPayload<{ select: typeof applicationSummary }>;

const NOT_FOUND = 'Conversation not found.';
const newestFirst = [
  { receivedAt: { sort: 'desc', nulls: 'last' } },
  { id: 'desc' },
] satisfies Prisma.EmailOrderByWithRelationInput[];

/** One page of conversations, plus one extra so the caller can tell if more exist. */
export async function listConversations(
  userId: string,
  filters: ConversationFilters,
  limit: number,
  offset: number,
): Promise<Conversation[]> {
  const rows = await conversationRows(prisma, userId, filters, { limit: limit + 1, offset });
  return describe(prisma, userId, rows);
}

/** A conversation can be opened by the ID of any of its emails, as an application timeline does. */
export async function threadKey(userId: string, key: string) {
  if (!isEmailId(key)) return key;
  const email = await prisma.email.findFirst({
    where: { id: key, userId },
    select: { id: true, threadId: true },
  });
  return email?.threadId ?? key;
}

export async function getConversation(userId: string, anyKey: string): Promise<ConversationDetail> {
  const key = await threadKey(userId, anyKey);
  const rows = await conversationRows(prisma, userId, { key });
  if (!rows.length) throw new AppError(404, 'NOT_FOUND', NOT_FOUND);
  const [conversation] = await describe(prisma, userId, rows);
  const mails = await prisma.email.findMany({
    where: { userId, relevanceState: 'RELEVANT', ...conversationWhere(key) },
    include: { aiProcessingResult: true },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
  });
  const sent = await prisma.outgoingEmail.findMany({
    where: { userId, threadId: key },
    orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
    select: { sentAt: true },
  });
  return {
    conversation,
    mails: mails.map(toMail),
    sentAt: sent.map((message) => message.sentAt.toISOString()),
    // The newest job mail is the one a reply answers.
    replyChoices: mails.at(-1)?.aiProcessingResult?.replyChoices ?? [],
  };
}

/** Opening a conversation ends its "new" mark. Safe to repeat. */
export async function markConversationSeen(userId: string, key: string) {
  await prisma.email.updateMany({
    where: { userId, seenAt: null, ...conversationWhere(key) },
    data: { seenAt: new Date() },
  });
  return { seen: true as const };
}

/**
 * The user's own answer to the newest request: "I did this", or open again. Only a request done
 * outside mail closes by hand (owner, 24 Oct 2026); reopening clears why it closed. Where the
 * request already has an application action, that action is finished or reopened too, so every
 * view agrees.
 */
export async function setRequestState(
  userId: string,
  key: string,
  request: SetRequestState,
): Promise<Conversation> {
  const actions = await prisma.$transaction(async (tx) => {
    await lockUser(tx, LOCK_NAMESPACE.emailMatches, userId);
    const [row] = await conversationRows(tx, userId, { key });
    if (!row) throw new AppError(404, 'NOT_FOUND', NOT_FOUND);
    // A newer email may have replaced the request the user answered.
    if (row.requestEmailId !== request.emailId)
      throw new AppError(409, 'REQUEST_CHANGED', CHANGE_REJECTED);
    const now = new Date();
    if (request.state === 'DONE') {
      const read = await tx.aIProcessingResult.findUnique({
        where: { emailId: request.emailId },
        select: { askKind: true },
      });
      if (!mayCloseByHand(read?.askKind))
        throw new AppError(409, 'CLOSES_BY_ITSELF', CLOSES_BY_ITSELF);
    }
    await tx.email.update({
      where: { id: request.emailId },
      data:
        request.state === 'DONE'
          ? {
              requestUserState: 'DONE',
              requestUserStateAt: now,
              requestClosedReason: 'YOU_SAID_DONE',
              requestClosedAt: now,
              requestClosedByMessageId: null,
            }
          : { requestUserState: 'OPEN', requestUserStateAt: now, ...OPEN_AGAIN },
    });
    return tx.action.findMany({
      where: {
        emailId: request.emailId,
        retiredAt: null,
        application: { userId, archivedAt: null },
      },
      select: { id: true },
    });
  });
  for (const action of actions)
    await updateActionStatus(userId, action.id, request.state === 'DONE' ? 'COMPLETED' : 'PENDING');
  return (await getConversation(userId, key)).conversation;
}

/** Adds to each row what the list shows: newest email, AI reading, request and application. */
async function describe(db: Db, userId: string, rows: ConversationRow[]): Promise<Conversation[]> {
  if (!rows.length) return [];
  const mails = await db.email.findMany({
    where: {
      userId,
      relevanceState: 'RELEVANT',
      ...conversationsWhere(rows.map((row) => row.key)),
    },
    include: { aiProcessingResult: true },
    orderBy: newestFirst,
  });
  const byKey = new Map<string, Mail[]>();
  for (const mail of mails) {
    const key = mail.threadId ?? mail.id;
    byKey.set(key, [...(byKey.get(key) ?? []), mail]);
  }
  const applicationIds = rows.flatMap((row) => (row.applicationId ? [row.applicationId] : []));
  const applications = applicationIds.length
    ? await db.application.findMany({
        where: { userId, id: { in: applicationIds } },
        select: applicationSummary,
      })
    : [];
  const applicationById = new Map(applications.map((app) => [app.id, app]));
  return rows.flatMap((row) => {
    const thread = byKey.get(row.key);
    if (!thread) return []; // deleted between the two reads
    const application = row.applicationId ? applicationById.get(row.applicationId) : undefined;
    return [toConversation(row, thread, application ?? null)];
  });
}

/** `thread` holds the conversation's job emails, newest first. */
function toConversation(
  row: ConversationRow,
  thread: Mail[],
  application: ApplicationSummary | null,
): Conversation {
  const latest = thread.find((mail) => mail.id === row.latestEmailId) ?? thread[0];
  const results = thread.flatMap((mail) =>
    mail.aiProcessingResult ? [mail.aiProcessingResult] : [],
  );
  const scheduled = results.find((result) => result.interviewDate || result.interviewTime);
  const provenance = latest.aiProcessingResult ?? results[0];
  return {
    key: row.key,
    threadId: latest.threadId,
    subject: latest.subject,
    sender: latest.sender,
    lastReceivedAt: row.lastReceivedAt?.toISOString() ?? null,
    mailCount: row.mailCount,
    sentCount: row.sentCount,
    isNew: row.isNew,
    category: row.category as MailCategory | null,
    company: newestOf(results, 'companyName'),
    role: newestOf(results, 'jobTitle'),
    interview: scheduled ? { date: scheduled.interviewDate, time: scheduled.interviewTime } : null,
    assessmentDeadline: newestOf(results, 'assessmentDeadline'),
    request: toRequest(row, thread),
    fakeOfferWarning: newestOf(results, 'fakeOfferWarning'),
    link: linkOf(latest, application),
    application: application && {
      id: application.id,
      companyName: application.companyName,
      jobTitle: application.jobTitle,
      effectiveStatus: deriveStatus(
        application.aiStatus as ApplicationStatus | null,
        application.userStatus as ApplicationStatus | null,
      ).effectiveStatus,
      archived: application.archivedAt !== null,
    },
    analyzedBy: provenance ? { provider: provenance.provider, model: provenance.model } : null,
  };
}

/** The newest value the AI read for one field; `results` are newest first. */
function newestOf(
  results: AIProcessingResult[],
  field: 'companyName' | 'jobTitle' | 'assessmentDeadline' | 'fakeOfferWarning',
) {
  return results.find((result) => result[field])?.[field] ?? null;
}

function toRequest(row: ConversationRow, thread: Mail[]): ConversationRequest | null {
  const mail = thread.find((candidate) => candidate.id === row.requestEmailId);
  const request =
    mail?.aiProcessingResult && requestOf(mail.aiProcessingResult, mail.receivedAt, mail.sender);
  if (!mail || !request || row.requestState === 'NONE') return null;
  return {
    emailId: mail.id,
    state: row.requestState,
    kind: request.kind,
    text: request.text?.trim() || null,
    deadline: request.deadline.deadline?.toISOString() ?? null,
    deadlinePrecision: request.deadline.precision,
    repliedAt: repliedAfter(row, mail)?.toISOString() ?? null,
    askKind: mail.aiProcessingResult?.askKind ?? null,
    canReply: canReplyTo(mail.sender),
    ...closureOf(row, mail),
    replyRead: replyReadOf(row, repliedAfter(row, mail) !== null),
  };
}

/** What the AI made of the user's reply after the request, as the screens show it. */
function replyReadOf(row: ConversationRow, replied: boolean): ConversationRequest['replyRead'] {
  if (!replied) return null;
  if (row.requestState === 'REPLIED')
    return row.lastReadState === 'WAITING' || row.lastReadState === 'NOT_READ'
      ? row.lastReadState
      : null;
  return row.requestState === 'OPEN' && row.lastReadState === 'READ' ? 'NOT_ANSWERED' : null;
}

/** The user's newest message after the request arrived, if any. */
const repliedAfter = (row: ConversationRow, mail: Mail) =>
  row.lastSentAt && mail.receivedAt && row.lastSentAt > mail.receivedAt ? row.lastSentAt : null;

/** Why and when a DONE request closed, and the mail that closed it, when the app knows. */
function closureOf(row: ConversationRow, mail: Mail) {
  const closed = row.requestState === 'DONE' && mail.requestClosedReason !== null;
  return {
    closedReason: closed ? mail.requestClosedReason : null,
    closedAt: closed ? (mail.requestClosedAt?.toISOString() ?? null) : null,
    closedByMessageId: closed ? mail.requestClosedByMessageId : null,
  };
}

function linkOf(latest: Mail, application: ApplicationSummary | null): Conversation['link'] {
  if (application) return 'LINKED';
  if (latest.matchState === 'AMBIGUOUS') return 'NEEDS_REVIEW';
  return latest.matchState === 'IGNORED' ? 'IGNORED' : 'UNLINKED';
}

/** What the AI read from one email, passed on as it stands, except a fake offer's request. */
const READ_FIELDS = [
  'recruiterName',
  'recruiterEmail',
  'interviewStage',
  'interviewType',
  'interviewDate',
  'interviewTime',
  'assessmentInfo',
  'assessmentDeadline',
  'offerInfo',
  'rejectionInfo',
  'requestedAction',
  'actionDeadline',
  'followUpDate',
  'fakeOfferWarning',
] as const;
type ReadFields = Record<(typeof READ_FIELDS)[number], string | null>;

function toMail(mail: Mail): ConversationMail {
  const result = mail.aiProcessingResult;
  const read = Object.fromEntries(
    READ_FIELDS.map((field) => [field, result?.[field] ?? null]),
  ) as ReadFields;
  // A mail that asks for money never shows its own request: the safe next step replaces it.
  if (read.fakeOfferWarning)
    Object.assign(read, { requestedAction: FAKE_OFFER_NEXT_STEP, actionDeadline: null });
  return {
    id: mail.id,
    gmailMessageId: mail.gmailMessageId,
    subject: mail.subject,
    sender: mail.sender,
    receivedAt: mail.receivedAt?.toISOString() ?? null,
    category: result?.category ?? null,
    company: result?.companyName ?? null,
    role: result?.jobTitle ?? null,
    ...read,
    askKind: result?.askKind ?? null,
    analyzedBy: result ? { provider: result.provider, model: result.model } : null,
  };
}
