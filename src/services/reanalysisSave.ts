/**
 * Reanalyze's save (owner, 19 Nov 2026): one transaction writes a conversation's replay, under the
 * per-user lock the matcher uses, and only when nothing changed since the run read it. It rebuilds
 * only what the AI made from those mails; what the user did stays. No alert is ever sent.
 */
import { Prisma } from '@prisma/client';
import type { AIProcessingResult, Action, Application, ApplicationStatus } from '@prisma/client';
import { prisma } from '../db/prisma';
import { lockUser, LOCK_NAMESPACE } from '../utils/advisoryLock';
import { logWarn } from '../utils/log';
import { STILL_OPEN } from './declineQuestion';
import { requestOf } from './emailRequest';
import { aiStatusFromEvidence, canTransition, inferState } from './matcher';
import { suppressNotifications } from './notificationSuppression';
import { ReanalysisStop } from './reanalysisRuns';
import {
  loadConversation,
  type Closure,
  type MailRead,
  type Replay,
  type Snapshot,
  type SnapMail,
} from './reanalysisReplay';
import { saveDates } from './reanalysisDates';
import { OPEN_AGAIN } from './threadAsks';

type Tx = Prisma.TransactionClient;

/** Retired by a re-read that no longer finds it. */
export const RETIRED = (now: Date) => ({ retiredAt: now, retiredReason: 'REANALYZED' as const });

/** What the user sees of a mail's read: one change when any of these differ. */
const SHOWN_FIELDS = [
  'companyName',
  'jobTitle',
  'category',
  'actionRequired',
  'requestedAction',
  'actionDeadline',
  'followUpRequired',
  'followUpDate',
  'fakeOfferWarning',
  'interviewDate',
  'interviewTime',
  'assessmentDeadline',
  'askKind',
] as const;

/** Saves the replay of one conversation. Returns how many things changed. */
export async function saveReplay(
  userId: string,
  runId: string,
  snap: Snapshot,
  replay: Replay,
): Promise<number> {
  return prisma.$transaction(
    async (tx) => {
      await lockUser(tx, LOCK_NAMESPACE.emailMatches, userId);
      const [run] = await tx.$queryRaw<{ state: string }[]>`
        SELECT state FROM reanalysis_runs WHERE id = ${runId}::uuid FOR UPDATE`;
      if (run?.state !== 'RUNNING') throw new ReanalysisStop('INTERRUPTED');
      const fresh = await loadConversation(tx, userId, snap.key);
      if (fresh.suspended) throw new ReanalysisStop('SUSPENDED');
      if (fresh.fingerprint !== snap.fingerprint) throw new ReanalysisStop('NEW_ACTIVITY');
      await tx.$queryRaw`
        SELECT id FROM applications
        WHERE id = ANY(${fresh.applications.map((app) => app.id)}::uuid[]) AND "userId" = ${userId}::uuid
        ORDER BY id FOR UPDATE`;
      const changed = await saveConversation({
        tx,
        runId,
        snap: fresh,
        replay,
        now: new Date(),
        results: new Map(),
        quiet: [],
        changed: 0,
      });
      await tx.reanalysisRun.update({
        where: { id: runId },
        data: {
          savedKeys: { push: snap.key },
          changed: { increment: changed },
          gone: { increment: replay.gone },
        },
      });
      return changed;
    },
    { timeout: 60_000, maxWait: 15_000 },
  );
}

/** What one conversation's save works with, and what it counts. */
interface Save {
  tx: Tx;
  runId: string;
  snap: Snapshot;
  replay: Replay;
  now: Date;
  /** By email id: each job mail's AI result as saved now. */
  results: Map<string, AIProcessingResult>;
  /** To-dos made or opened again: marked so no alert goes out. */
  quiet: string[];
  changed: number;
}

/** One conversation's writes, in order: reads, steps, to-dos, dates, timeline, status, replies. */
async function saveConversation(save: Save) {
  const jobMails = save.snap.mails.filter((mail) => mail.relevanceState === 'RELEVANT');
  for (const mail of jobMails) {
    const read = save.replay.mails.get(mail.id);
    if (read && mail.aiProcessingResult) await saveRead(save, mail, mail.aiProcessingResult, read);
    else if (mail.aiProcessingResult) save.results.set(mail.id, mail.aiProcessingResult);
  }
  for (const mail of jobMails) await saveStep(save, mail);
  for (const mail of jobMails) {
    const read = save.replay.mails.get(mail.id);
    const app = linkedApplication(save, mail);
    if (!read) continue;
    save.changed += await saveDates(save.tx, {
      mail,
      read,
      app,
      runId: save.runId,
      now: save.now,
      fake: !!save.results.get(mail.id)?.fakeOfferWarning,
    });
    if (!app) continue;
    await saveToDo(save, mail, app);
    await saveTimeline(save, mail, app);
  }
  if (save.quiet.length) await suppressNotifications(save.tx, save.quiet);
  const touched = new Set(
    jobMails.flatMap((mail) => {
      const app = save.replay.mails.has(mail.id) && linkedApplication(save, mail);
      return app ? [app.id] : [];
    }),
  );
  for (const app of save.snap.applications) if (touched.has(app.id)) await saveStatus(save, app);
  await saveReplies(save);
  await saveDecline(save, jobMails);
  return save.changed;
}

/** The application a mail is linked to, unless it is archived (Reanalyze leaves those alone). */
function linkedApplication(save: Save, mail: SnapMail): Application | null {
  if (mail.matchState !== 'MATCHED' || !mail.applicationId) return null;
  const app = save.snap.applications.find((candidate) => candidate.id === mail.applicationId);
  return app && !app.archivedAt ? app : null;
}

/** The mail's new read, and its one ledger row, so every reader of the answer agrees. */
async function saveRead(save: Save, mail: SnapMail, before: AIProcessingResult, read: MailRead) {
  // The dates are saved after they are matched with the agenda (`saveSchedule`).
  const fields: Record<string, unknown> = { ...read.fields };
  delete fields.scheduleCandidates;
  const result = await save.tx.aIProcessingResult.update({
    where: { emailId: mail.id },
    data: {
      ...(fields as Omit<MailRead['fields'], 'scheduleCandidates'>),
      ...(read.category ? { category: read.category } : {}),
      provider: read.provider,
      model: read.model,
      contractVersion: read.version,
      processingStatus: 'COMPLETED',
      errorCategory: null,
      errorDetails: null,
    },
  });
  save.results.set(mail.id, result);
  if (SHOWN_FIELDS.some((field) => JSON.stringify(before[field]) !== JSON.stringify(result[field])))
    save.changed++;
  const rows = mail.aiOperations;
  const ledger = {
    version: read.version,
    result: read.data as Prisma.InputJsonValue,
    provider: read.provider,
    model: read.model,
    status: 'COMPLETED' as const,
    errorCode: null,
    lastFailure: Prisma.DbNull,
  };
  // The row keeps its own times: the reading speed counts only mails read as they came.
  if (rows.length === 1)
    await save.tx.aIOperation.update({ where: { id: rows[0].id }, data: ledger });
  else if (!rows.length)
    await save.tx.aIOperation.create({
      data: { emailId: mail.id, operation: 'extraction', ...ledger },
    });
  else logWarn('reanalysis_ledger_left', { emailId: mail.id, rows: rows.length });
}

/** The step's closing as the replay ended. Steps the user closed or reopened are the user's. */
async function saveStep(save: Save, mail: SnapMail) {
  if (save.replay.userClosed.has(mail.id) || !save.replay.closures.has(mail.id)) return;
  const wanted = save.replay.closures.get(mail.id) ?? null;
  if (
    (wanted?.reason ?? null) === mail.requestClosedReason &&
    (wanted?.byMessageId ?? null) === mail.requestClosedByMessageId
  )
    return;
  const result = save.results.get(mail.id);
  if (result && requestOf(result, mail.receivedAt, mail.sender)) save.changed++;
  if (wanted) await closeStep(save, mail, wanted);
  else await reopenStep(save, mail);
}

/** Opened again: its to-do too, if the closing finished it (a dismissed one stays dismissed). */
async function reopenStep(save: Save, mail: SnapMail) {
  await save.tx.email.update({ where: { id: mail.id }, data: OPEN_AGAIN });
  const finished = mail.actions.filter((a) => !a.retiredAt && a.status === 'COMPLETED');
  await save.tx.action.updateMany({
    where: { id: { in: finished.map((a) => a.id) } },
    data: { status: 'PENDING', actionRevision: { increment: 1 } },
  });
  save.quiet.push(...finished.map((a) => a.id));
}

/** Closed by a message of the replay (dated by that message), or as the application closed. */
async function closeStep(save: Save, mail: SnapMail, wanted: Closure) {
  await save.tx.email.update({
    where: { id: mail.id },
    data: {
      requestClosedReason: wanted.reason,
      requestClosedAt: wanted.at ?? save.now,
      requestClosedByMessageId: wanted.byMessageId,
    },
  });
  if (!mail.requestClosedReason)
    await save.tx.action.updateMany({
      where: { emailId: mail.id, status: 'PENDING', retiredAt: null },
      data: { status: 'COMPLETED', snoozedUntil: null, actionRevision: { increment: 1 } },
    });
}

type WantedToDo = ReturnType<typeof wantedToDo>;
function wantedToDo(request: NonNullable<ReturnType<typeof requestOf>>) {
  return {
    type: request.kind === 'ACTION' ? 'ACTION_REQUIRED' : 'FOLLOW_UP_REQUIRED',
    description:
      request.kind === 'ACTION' ? request.text || 'Action required' : 'Follow up required',
    deadline: request.deadline.deadline,
    deadlinePrecision: request.deadline.precision,
  };
}

/** The to-do follows the new read: open ones only; finished ones and the user's own stay. */
async function saveToDo(save: Save, mail: SnapMail, app: Application) {
  const result = save.results.get(mail.id);
  // A fake offer's mail never makes a to-do: only its safe step shows on the mail page.
  const request =
    result && !result.fakeOfferWarning ? requestOf(result, mail.receivedAt, mail.sender) : null;
  const all = await save.tx.action.findMany({
    where: {
      applicationId: app.id,
      emailId: mail.id,
      OR: [{ origin: null }, { origin: { not: 'USER' } }],
    },
  });
  const live = all.filter((a) => !a.retiredAt);
  if (!request) {
    await retireOpen(save, live);
    return;
  }
  const want = wantedToDo(request);
  const current = live.find((a) => a.type === want.type) ?? live[0];
  await retireOpen(
    save,
    live.filter((a) => a !== current),
    false,
  );
  if (current?.type === want.type) {
    await updateToDo(save, current, want);
    return;
  }
  if (current && current.status !== 'PENDING') return;
  // A new kind of step: the old open to-do goes and one of the new kind comes.
  if (current) await retireOpen(save, [current], false);
  await addToDo(save, { mail, app, want, retired: all.filter((a) => a.retiredAt) });
}

/** Retires the open ones among these to-dos. */
async function retireOpen(save: Save, actions: Action[], counts = true) {
  const open = actions.filter((a) => a.status === 'PENDING');
  if (!open.length) return;
  await save.tx.action.updateMany({
    where: { id: { in: open.map((a) => a.id) } },
    data: { ...RETIRED(save.now), actionRevision: { increment: 1 } },
  });
  if (counts) save.changed++;
}

async function updateToDo(save: Save, current: Action, want: WantedToDo) {
  if (current.status !== 'PENDING' || sameToDo(current, want)) return;
  await save.tx.action.update({
    where: { id: current.id },
    data: { ...want, actionRevision: { increment: 1 } },
  });
  save.changed++;
}

/** A to-do for a new step, finished at once when the step is closed. A retired one of the same
 * kind comes back instead: only one per mail and kind may exist. No alert. */
async function addToDo(
  save: Save,
  {
    mail,
    app,
    want,
    retired,
  }: { mail: SnapMail; app: Application; want: WantedToDo; retired: Action[] },
) {
  const email = await save.tx.email.findUniqueOrThrow({
    where: { id: mail.id },
    select: { requestClosedReason: true, requestUserState: true },
  });
  const status =
    email.requestClosedReason || email.requestUserState === 'DONE' ? 'COMPLETED' : 'PENDING';
  const earlier = retired.find((a) => a.type === want.type);
  const saved = earlier
    ? await save.tx.action.update({
        where: { id: earlier.id },
        data: {
          ...want,
          status,
          snoozedUntil: null,
          retiredAt: null,
          retiredReason: null,
          actionRevision: { increment: 1 },
        },
      })
    : await save.tx.action.create({
        data: { applicationId: app.id, emailId: mail.id, origin: 'EMAIL', status, ...want },
      });
  save.quiet.push(saved.id);
  save.changed++;
}

/** The mail's one timeline line, updated in place: same date, same place in the list. */
async function saveTimeline(save: Save, mail: SnapMail, app: Application) {
  const result = save.results.get(mail.id)!;
  const state = inferState(result);
  await save.tx.applicationEvent.updateMany({
    where: { applicationId: app.id, emailId: mail.id, type: 'EMAIL_PROCESSED', retiredAt: null },
    data: {
      description: state
        ? `Received relevant email suggesting state ${state}`
        : 'Received relevant email',
      provenance: result.provenance,
    },
  });
}

/**
 * The AI status from all the application's mails (it may go down), and its AI status history
 * rebuilt in mail order, dated by each mail, with no entry for a step the user's own status hid.
 * The user's status and its history are not touched.
 */
async function saveStatus(save: Save, app: Application) {
  const mails = await save.tx.email.findMany({
    where: { userId: app.userId, applicationId: app.id, matchState: 'MATCHED' },
    include: { aiProcessingResult: true },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
  });
  const results = mails.flatMap((mail) =>
    mail.aiProcessingResult ? [mail.aiProcessingResult] : [],
  );
  const aiStatus = aiStatusFromEvidence(results);
  if (aiStatus !== app.aiStatus) {
    await save.tx.application.update({ where: { id: app.id }, data: { aiStatus } });
    if (!app.userStatus) save.changed++;
  }
  const wanted: {
    emailId: string;
    from: ApplicationStatus | null;
    to: ApplicationStatus;
    at: Date;
  }[] = [];
  let running: ApplicationStatus | null = null;
  for (const mail of mails) {
    const next = mail.aiProcessingResult && inferState(mail.aiProcessingResult);
    if (!next || next === running || !canTransition(running, next)) continue;
    const at = mail.receivedAt ?? mail.createdAt;
    const hidden = !!app.userStatus && !!app.userStatusSetAt && at >= app.userStatusSetAt;
    if (!hidden) wanted.push({ emailId: mail.id, from: running, to: next, at });
    running = next;
  }
  const live = await save.tx.statusChange.findMany({
    where: { applicationId: app.id, source: 'AI', retiredAt: null },
  });
  const same = (row: (typeof live)[number], want: (typeof wanted)[number]) =>
    row.emailId === want.emailId &&
    row.toStatus === want.to &&
    row.changedAt.getTime() === want.at.getTime();
  const stale = live.filter((row) => !wanted.some((want) => same(row, want)));
  if (stale.length)
    await save.tx.statusChange.updateMany({
      where: { id: { in: stale.map((row) => row.id) } },
      data: { retiredAt: save.now },
    });
  const missing = wanted.filter((want) => !live.some((row) => same(row, want)));
  if (missing.length)
    await save.tx.statusChange.createMany({
      data: missing.map((want) => ({
        applicationId: app.id,
        emailId: want.emailId,
        source: 'AI' as const,
        fromStatus: want.from,
        toStatus: want.to,
        changedAt: want.at,
      })),
    });
}

/** Each reply read again: answered, asked them a question, or not read (nothing was open). */
async function saveReplies(save: Save) {
  for (const [id, read] of save.replay.replies) {
    const sent = save.snap.replies.find((reply) => reply.id === id);
    if (!sent) continue;
    if (sent.replyReadState === read.state && sent.replyReadVersion === read.version) continue;
    await save.tx.outgoingEmail.update({
      where: { id },
      data: {
        replyReadState: read.state,
        replyReadVersion: read.version,
        replyReadAt: read.state ? save.now : null,
        replyReadTries: 0,
      },
    });
    if (sent.replyReadState !== read.state) save.changed++;
  }
}

/**
 * "Close the application?" follows the replies read again. A decline found now in an older
 * reply gives the user three days from now; a question no reply asks any more goes, if the user
 * had not answered it. As for a new reply, it goes to the conversation's linked application.
 */
async function saveDecline(save: Save, jobMails: SnapMail[]) {
  const linked = [...jobMails]
    .reverse()
    .find((mail) => mail.matchState === 'MATCHED' && mail.applicationId);
  const app = linked && save.snap.applications.find((a) => a.id === linked.applicationId);
  if (!app) return;
  const reread = save.snap.replies.filter((reply) => save.replay.replies.has(reply.id));
  const leaving = reread
    .filter((reply) => save.replay.replies.get(reply.id)?.leavesJob)
    .map((reply) => reply.sentAt)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  if (leaving) {
    if (app.declinedAt?.getTime() === leaving.getTime()) return;
    const { count } = await save.tx.application.updateMany({
      where: {
        id: app.id,
        ...STILL_OPEN,
        AND: [{ OR: [{ declinedAt: null }, { declinedAt: { lt: leaving } }] }],
      },
      data: {
        declinedAt: leaving,
        declineNotedAt: save.now,
        declineAnswer: null,
        declineAnsweredAt: null,
      },
    });
    save.changed += count;
    return;
  }
  const fromHere = reread.some((reply) => reply.sentAt.getTime() === app.declinedAt?.getTime());
  if (!fromHere || app.declineAnswer !== null) return;
  await save.tx.application.update({
    where: { id: app.id },
    data: { declinedAt: null, declineNotedAt: null },
  });
  save.changed++;
}

const sameToDo = (
  action: Action,
  want: { description: string; deadline: Date | null; deadlinePrecision: string | null },
) =>
  action.description === want.description &&
  (action.deadline?.getTime() ?? null) === (want.deadline?.getTime() ?? null) &&
  (action.deadlinePrecision ?? null) === (want.deadlinePrecision ?? null);
