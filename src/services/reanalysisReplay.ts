/**
 * Reanalyze's replay (owner, 19 Nov 2026): the conversation's job mails and the user's replies are
 * read again with today's rules, oldest first, as if each one arrived today. Each read gets the
 * steps that are open at its point of the replay, not today's. Nothing is written here:
 * `reanalysisSave.ts` saves the outcome once, and only when every read worked. Mail text is read
 * from Gmail for the calls and dropped: never stored, never logged.
 */
import type {
  AIProcessingResult,
  Application,
  EmailCategory,
  OutgoingEmail,
  Prisma,
  RequestClosedReason,
} from '@prisma/client';
import { prisma } from '../db/prisma';
import {
  AI_CONTRACT_VERSIONS,
  EXTRACTION_VERSIONS,
  THREAD_EXTRACTION_VERSIONS,
  classificationContractFor,
} from './ai/contracts';
import { extractionContractFor } from './ai/extractionVersions';
import {
  extractionCall,
  extractionFields,
  newMailExtractionVersion,
  relevanceInput,
} from './ai/pipeline';
import { REPLY_READ_V2_CONTRACT } from './ai/replyRead';
import { ThreadReadSchema } from './ai/threadRead';
import { runUserCall } from './ai/userCall';
import { conversationWhere } from './conversationQuery';
import { googleStatus } from './gmailClient';
import { fetchMessageBody, fetchMessageMetadata } from './gmailFetcher';
import { noReplySenders, saysNoReply as mailSaysNoReply } from './mailSender';
import { ReanalysisStop } from './reanalysisRuns';
import { CLOSES_AS, NOTHING_READ, ownText, readReply } from './replyReading';
import { canReplyTo, openAsksAmong, type AskSource, type OpenAsk } from './threadAsks';

type Db = Prisma.TransactionClient | typeof prisma;

/** The types a job mail can have; today's check may give another, and then the old type stays. */
const JOB_TYPES: readonly EmailCategory[] = [
  'RECRUITER',
  'INTERVIEW',
  'ASSESSMENT',
  'OFFER',
  'REJECTION',
  'FOLLOW_UP',
  'CAREER_CONTACT',
];

/** How a mail or a reply closes a step: these the replay works out again. */
export const MESSAGE_CLOSURES: readonly RequestClosedReason[] = [
  'REPLACED_BY_MAIL',
  'CONFIRMED_BY_MAIL',
  'YOUR_REPLY',
  'YOU_DECLINED',
];

const mailInclude = {
  aiProcessingResult: true,
  actions: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  agendaItems: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  aiOperations: { where: { operation: 'extraction' } },
} satisfies Prisma.EmailInclude;
export type SnapMail = Prisma.EmailGetPayload<{ include: typeof mailInclude }>;

/** The conversation as the run found it. */
export interface Snapshot {
  key: string;
  /** Every mail of the thread, job mail or not, oldest first. */
  mails: SnapMail[];
  replies: OutgoingEmail[];
  /** The applications its job mails are linked to. */
  applications: Application[];
  suspended: boolean;
  /** Everything that must still be the same when the run saves. */
  fingerprint: string;
}

const time = (date: Date | null | undefined) => date?.getTime() ?? null;

/** Loads the conversation and what must not change before the save. */
export async function loadConversation(db: Db, userId: string, key: string): Promise<Snapshot> {
  const mails = await db.email.findMany({
    where: { userId, ...conversationWhere(key) },
    include: mailInclude,
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
  });
  const replies = await db.outgoingEmail.findMany({
    where: { userId, threadId: key },
    orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
  });
  const applicationIds = [
    ...new Set(mails.flatMap((mail) => (mail.applicationId ? [mail.applicationId] : []))),
  ];
  const applications = await db.application.findMany({
    where: { userId, id: { in: applicationIds } },
    orderBy: { id: 'asc' },
  });
  const user = await db.user.findUnique({ where: { id: userId }, select: { suspendedAt: true } });
  const fingerprint = JSON.stringify({
    mails: mails.map((mail) => [
      mail.id,
      mail.relevanceState,
      mail.processingState,
      mail.matchState,
      mail.applicationId,
      mail.matchConfirmedBy,
      mail.requestUserState,
      time(mail.requestUserStateAt),
      mail.requestClosedReason,
      mail.requestClosedByMessageId,
      time(mail.aiProcessingResult?.updatedAt),
      mail.actions.map((a) => [a.id, a.status, a.actionRevision, time(a.retiredAt)]),
      mail.agendaItems.map((i) => [i.id, i.state, i.revision, time(i.retiredAt)]),
    ]),
    replies: replies.map((reply) => [reply.id, reply.replyReadState]),
    applications: applications.map((app) => [
      app.id,
      app.userStatusRevision,
      time(app.archivedAt),
      time(app.declinedAt),
      app.declineAnswer,
    ]),
    suspended: !!user?.suspendedAt,
  });
  return { key, mails, replies, applications, suspended: !!user?.suspendedAt, fingerprint };
}

/** A job mail the AI finished reading: the only ones Reanalyze reads again. */
export const isFinished = (
  mail: SnapMail,
): mail is SnapMail & { aiProcessingResult: AIProcessingResult } =>
  mail.relevanceState === 'RELEVANT' &&
  mail.processingState === 'COMPLETED' &&
  mail.aiProcessingResult?.processingStatus === 'COMPLETED' &&
  EXTRACTION_VERSIONS.includes(mail.aiProcessingResult.contractVersion);

/** A mail or a reply still being read by the normal reader: Reanalyze waits for it. */
export const stillReading = (snap: Pick<Snapshot, 'mails' | 'replies'>) =>
  snap.mails.some(
    (mail) =>
      mail.relevanceState !== 'IRRELEVANT' &&
      (mail.processingState === 'PENDING' || mail.processingState === 'PROCESSING'),
  ) || snap.replies.some((reply) => reply.replyReadState === 'WAITING');

/** The step's closing: why, by which message, and when. */
export interface Closure {
  reason: RequestClosedReason;
  byMessageId: string | null;
  at: Date | null;
}

/** A mail's new read, ready to save. */
export interface MailRead {
  version: string;
  /** The AI's answer as the ledger keeps it. */
  data: unknown;
  fields: ReturnType<typeof extractionFields>;
  /** Today's mail type; null keeps the old one. */
  category: EmailCategory | null;
  provider: string;
  model: string;
}

/** A reply's new read. `state` null: nothing was open before it, so it is not read. */
export interface ReplyRead {
  version: string | null;
  state: 'READ' | 'ASKED_BACK' | null;
  leavesJob: boolean;
}

export interface Replay {
  /** By email id: the mails read again. */
  mails: Map<string, MailRead>;
  /** By sent message id: the replies read again. */
  replies: Map<string, ReplyRead>;
  /** By email id: how each job mail's step stands when the replay ends. Not for user-closed ones. */
  closures: Map<string, Closure | null>;
  /** Email ids whose step the user closed or answered: the save never touches them. */
  userClosed: Set<string>;
  /** Mails and replies Gmail no longer has: they kept their old read. */
  gone: number;
}

/** A job mail's step during the replay. */
interface StepState {
  mail: SnapMail;
  result: AIProcessingResult;
  closure: Closure | null;
  userClosed: boolean;
  /** When the user reopened it: only messages after that may close it. */
  reopenedAt: Date | null;
}

/** Closed or answered by the user: "I did this", the application closed, a dismissed to-do. */
function closedByUser(mail: SnapMail): boolean {
  const reason = mail.requestClosedReason;
  if (mail.requestUserState === 'DONE') return true;
  if (reason && !MESSAGE_CLOSURES.includes(reason)) return true;
  // A to-do a message's closing finished is not the user's; any other finished one is.
  return mail.actions.some(
    (action) =>
      !action.retiredAt &&
      action.status !== 'PENDING' &&
      !(reason && action.status === 'COMPLETED'),
  );
}

const asSource = (step: StepState): AskSource => ({
  id: step.mail.id,
  receivedAt: step.mail.receivedAt,
  sender: step.mail.sender,
  requestClosedReason: step.closure?.reason ?? null,
  requestUserState: step.userClosed ? 'DONE' : null,
  actions: [],
  result: step.result,
});

/** Closes a step in the replay, unless the user holds it (closed it, or reopened it later). */
function close(step: StepState | undefined, closure: Closure) {
  if (!step || step.userClosed || step.closure) return;
  if (step.reopenedAt && (!closure.at || closure.at < step.reopenedAt)) return;
  step.closure = closure;
}

interface MailText {
  body: string;
  labelIds: string[] | null;
  snippet: string | null;
  /** Set for a mail sent as a mailing (`fetchMessageMetadata`). */
  bulk?: true;
}

/** Reads from Gmail; null when Gmail no longer has the message. */
async function fromGmail<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    const status = googleStatus(err);
    if (status === 404) return null;
    if (status === 401 || (err instanceof Error && err.message === 'Gmail is not connected'))
      throw new ReanalysisStop('GMAIL_DISCONNECTED');
    throw new ReanalysisStop('GMAIL_FAILED');
  }
}

/** Stops the run when it has taken too long, before any more work. */
const inTime = (deadline: number) => {
  if (Date.now() > deadline) throw new ReanalysisStop('TOO_SLOW');
};

/** Replays the conversation with today's rules. Throws when any read fails: nothing is saved. */
export async function replayConversation(
  userId: string,
  snap: Snapshot,
  { deadline }: { deadline: number },
): Promise<Replay> {
  const finished = snap.mails.filter(isFinished);
  const texts = await readGmail(userId, snap, deadline);
  const steps = startingSteps(snap, texts);
  const replay: Replay = {
    mails: new Map(),
    replies: new Map(),
    closures: new Map(),
    userClosed: new Set([...steps.values()].filter((s) => s.userClosed).map((s) => s.mail.id)),
    gone: [...texts.values()].filter((text) => text === null).length,
  };
  const events = [
    ...finished
      .filter((mail) => texts.get(mail.id))
      .map((mail) => ({ at: (mail.receivedAt ?? mail.createdAt).getTime(), order: 0, mail })),
    ...snap.replies
      .filter((reply) => texts.get(reply.id))
      .map((reply) => ({ at: reply.sentAt.getTime(), order: 1, reply })),
  ].sort((a, b) => a.at - b.at || a.order - b.order);
  for (const event of events) {
    inTime(deadline);
    if ('mail' in event && event.mail)
      await replayMail(userId, event.mail, { steps, texts, replay });
    if ('reply' in event && event.reply)
      await replayReply(userId, event.reply, { steps, texts, replay });
  }
  closeAsApplicationDid(steps, snap.applications);
  for (const step of steps.values())
    if (!step.userClosed) replay.closures.set(step.mail.id, step.closure);
  return replay;
}

/** What the replay keeps while it reads: the steps, the texts from Gmail, and the reads so far. */
interface ReplayState {
  steps: Map<string, StepState>;
  /** By email id or sent message id; null when Gmail no longer has it. */
  texts: Map<string, MailText | null>;
  replay: Replay;
}

/** Gmail first, before any AI call: a failure then costs no AI read. */
async function readGmail(userId: string, snap: Snapshot, deadline: number) {
  const texts = new Map<string, MailText | null>();
  for (const mail of snap.mails.filter(isFinished)) {
    inTime(deadline);
    const meta = await fromGmail(() => fetchMessageMetadata(userId, mail.gmailMessageId));
    const body = meta && (await fromGmail(() => fetchMessageBody(userId, mail.gmailMessageId)));
    texts.set(mail.id, meta && body !== null ? { body, ...meta } : null);
  }
  for (const reply of snap.replies) {
    inTime(deadline);
    const body = await fromGmail(() => fetchMessageBody(userId, reply.gmailMessageId));
    texts.set(reply.id, body === null ? null : { body, labelIds: null, snippet: null });
  }
  return texts;
}

/**
 * The steps as the replay starts: a closing by a message read again is worked out again; any other
 * stays (the user's, the application's, or by a message Gmail no longer has, which keeps its read).
 */
function startingSteps(snap: Snapshot, texts: Map<string, MailText | null>) {
  const reread = new Set([
    ...snap.mails.filter((mail) => texts.get(mail.id)).map((mail) => mail.gmailMessageId),
    ...snap.replies.filter((reply) => texts.get(reply.id)).map((reply) => reply.gmailMessageId),
  ]);
  const steps = new Map<string, StepState>();
  for (const mail of snap.mails) {
    if (mail.relevanceState !== 'RELEVANT' || !mail.aiProcessingResult) continue;
    const reason = mail.requestClosedReason;
    const replayed =
      !!reason &&
      MESSAGE_CLOSURES.includes(reason) &&
      reread.has(mail.requestClosedByMessageId ?? '');
    steps.set(mail.id, {
      mail,
      result: mail.aiProcessingResult,
      closure:
        reason && !replayed
          ? { reason, byMessageId: mail.requestClosedByMessageId, at: mail.requestClosedAt }
          : null,
      userClosed: closedByUser(mail),
      reopenedAt: mail.requestUserState === 'OPEN' ? mail.requestUserStateAt : null,
    });
  }
  return steps;
}

/** One mail read again with the steps open before it; its own step then takes the new read. */
async function replayMail(userId: string, mail: SnapMail, { steps, texts, replay }: ReplayState) {
  const open = openAsksAmong([...steps.values()].map(asSource), {
    before: mail.receivedAt,
    except: mail.id,
  });
  const read = await readMailAgain(userId, mail, texts.get(mail.id)!, open);
  replay.mails.set(mail.id, read);
  for (const closed of closedAsks(read, open))
    close(steps.get(closed.emailId), {
      reason: closed.reason,
      byMessageId: mail.gmailMessageId,
      at: mail.receivedAt,
    });
  const step = steps.get(mail.id);
  if (step)
    step.result = {
      ...step.result,
      ...read.fields,
      category: read.category ?? step.result.category,
    };
}

/** One reply read again with the steps open before it. */
async function replayReply(
  userId: string,
  reply: OutgoingEmail,
  { steps, texts, replay }: ReplayState,
) {
  const open = openAsksAmong([...steps.values()].map(asSource), { before: reply.sentAt });
  const read = await readReplyAgainInReplay(userId, texts.get(reply.id)!.body, open);
  replay.replies.set(reply.id, read.reply);
  for (const closed of read.closes)
    close(steps.get(closed.emailId), {
      reason: closed.reason,
      byMessageId: reply.gmailMessageId,
      at: reply.sentAt,
    });
}

/** The mail's two reads with today's rules: its type, then its details and what it closes. */
async function readMailAgain(
  userId: string,
  mail: SnapMail,
  text: MailText,
  open: OpenAsk[],
): Promise<MailRead> {
  const typeContract = classificationContractFor(AI_CONTRACT_VERSIONS.CLASSIFICATION);
  const sorted = await runUserCall({
    userId,
    purpose: 'reanalyze-type',
    contract: typeContract,
    call: (ai) => ai.classifier.classifyRelevance(relevanceInput(mail, text), typeContract.version),
  });
  // Only the type is used: a job mail stays a job mail, with a job mail's type.
  const type = sorted.data.decision !== 'IRRELEVANT' ? sorted.data.category : undefined;
  const category = type && JOB_TYPES.includes(type) ? type : null;
  const version = newMailExtractionVersion();
  const contract = extractionContractFor(version);
  const saysNoReply = mailSaysNoReply(text.body);
  const senderCanReply =
    !saysNoReply && canReplyTo(mail.sender, await noReplySenders(prisma, userId));
  const thread = THREAD_EXTRACTION_VERSIONS.includes(version)
    ? {
        senderCanReply,
        openAsks: open.map(({ id, ask, kind, askedAt }) => ({ id, ask, kind, askedAt })),
      }
    : undefined;
  const read = await runUserCall({
    userId,
    purpose: 'reanalyze-read',
    contract,
    call: extractionCall(version, {
      body: text.body,
      receivedAt: mail.receivedAt,
      subject: mail.subject,
      sender: mail.sender,
      thread,
    }),
  });
  const sortedAs = {
    category: category ?? mail.aiProcessingResult?.category ?? null,
    bulkMail: !!text.bulk,
    saysNoReply,
  };
  });
  return {
    version,
    data: read.data,
    fields: extractionFields(version, read.data, { ...mail, ...sortedAs, senderCanReply }),
    category,
    provider: read.provider,
    model: read.model,
  };
}

/** The open asks the mail's read names as closed, by their ids in what it was given. */
function closedAsks(read: MailRead, open: OpenAsk[]) {
  if (!THREAD_EXTRACTION_VERSIONS.includes(read.version)) return [];
  const answer = ThreadReadSchema.safeParse(read.data);
  return (answer.success ? (answer.data.closedAsks ?? []) : []).flatMap((entry) => {
    const ask = open.find((candidate) => candidate.id === entry.id);
    if (!ask) return [];
    const reason: RequestClosedReason =
      entry.reason === 'CONFIRMED_DONE' ? 'CONFIRMED_BY_MAIL' : 'REPLACED_BY_MAIL';
    return [{ emailId: ask.emailId, reason }];
  });
}

/** The reply's read with today's reply rules, when a step was open before it. */
async function readReplyAgainInReplay(userId: string, body: string, open: OpenAsk[]) {
  if (!open.length)
    return {
      reply: { version: null, state: null, leavesJob: false } satisfies ReplyRead,
      closes: [],
    };
  const version = REPLY_READ_V2_CONTRACT.version;
  const text = ownText(body);
  const read = text ? await readReply(userId, version, open, text) : NOTHING_READ;
  const outcomeOf = new Map(read.asks.map((entry) => [entry.id, entry.outcome]));
  const closes = open.flatMap((ask) => {
    const outcome = outcomeOf.get(ask.id);
    const reason = outcome && CLOSES_AS[outcome];
    return reason ? [{ emailId: ask.emailId, reason }] : [];
  });
  const askedBack = open.some((ask) => outcomeOf.get(ask.id) === 'ASKED_BACK');
  return {
    reply: {
      version,
      state: askedBack ? 'ASKED_BACK' : 'READ',
      leavesJob: read.leavesJob,
    } satisfies ReplyRead,
    closes,
  };
}

/**
 * A step from a mail that came before the user closed or rejected the application closes as the
 * application closed, as it would have then (`closeAsksOfApplication`).
 */
function closeAsApplicationDid(steps: Map<string, StepState>, applications: Application[]) {
  for (const step of steps.values()) {
    const { mail } = step;
    if (step.userClosed || step.closure || mail.matchState !== 'MATCHED') continue;
    if (!step.result.actionRequired && !step.result.followUpRequired) continue;
    const app = applications.find((candidate) => candidate.id === mail.applicationId);
    const closedAt = app?.userStatusSetAt;
    if (!app || !closedAt || (app.userStatus !== 'REJECTED' && app.userStatus !== 'CLOSED'))
      continue;
    if (mail.receivedAt && mail.receivedAt < closedAt)
      step.closure = { reason: 'APPLICATION_CLOSED', byMessageId: null, at: closedAt };
  }
}
