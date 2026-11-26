/**
 * Keeps stored requests in step with today's rules (owner, 26 Nov 2026), so nothing stale stays in
 * Needs action. After each mail is read: the asks an ended application or a repeated ask closes.
 * Every hour and when the server starts: the same for every user, plus the mails and steps saved
 * before a rule existed. Everything here is safe to run again.
 */
import { prisma } from '../db/prisma';
import { logEvent } from '../utils/log';
import { askRules, requestOf, TELL_THEM } from './emailRequest';
import { noReplySenders } from './mailSender';
import { RETIRED } from './reanalysisSave';
import { closeAsksOfEndedApplications, closeRepeatedAsks } from './threadAsks';

/** The user's asks that an ended application or the same ask sent again closes. */
export async function tidyRequestsOf(userId: string) {
  return (await closeAsksOfEndedApplications(userId)) + (await closeRepeatedAsks(userId));
}

/**
 * Mails read before `askRules` existed: an automatic reply, or a "follow up" with no date the app
 * can read, no longer asks for anything, and its open to-do goes. The AI's own answer stays in
 * the reading ledger. Returns how many mails changed.
 */
async function dropAsksThatAreNone() {
  const asking = [{ actionRequired: true }, { followUpRequired: true }];
  const subjectStarts = (start: string) => ({
    OR: asking,
    email: { subject: { startsWith: start, mode: 'insensitive' as const } },
  });
  const results = await prisma.aIProcessingResult.findMany({
    where: {
      email: { relevanceState: 'RELEVANT' },
      OR: [
        { followUpRequired: true, OR: [{ actionRequired: false }, { actionRequired: null }] },
        subjectStarts('auto'),
        subjectStarts('out of'),
      ],
    },
    include: { email: { select: { subject: true, receivedAt: true } } },
  });
  let changed = 0;
  for (const { email, ...read } of results) {
    const change = askRules(read, email);
    if (!Object.keys(change).length) continue;
    const after = { ...read, ...change };
    const asksNothing = !after.actionRequired && !after.followUpRequired && !after.fakeOfferWarning;
    await prisma.$transaction(async (tx) => {
      await tx.aIProcessingResult.update({ where: { id: read.id }, data: change });
      if (!asksNothing) return;
      await tx.action.updateMany({
        where: {
          emailId: read.emailId,
          status: 'PENDING',
          retiredAt: null,
          OR: [{ origin: null }, { origin: { not: 'USER' } }],
        },
        data: { ...RETIRED(new Date()), actionRevision: { increment: 1 } },
      });
    });
    changed++;
  }
  return changed;
}

/**
 * Open steps from mails keep the deadline read when they were made. One whose deadline text the
 * app could not read then, and can read now, gets its date. Returns how many did.
 */
async function readStepDeadlinesAgain() {
  const steps = await prisma.action.findMany({
    where: {
      status: 'PENDING',
      retiredAt: null,
      deadline: null,
      email: {
        aiProcessingResult: {
          OR: [{ actionDeadline: { not: null } }, { followUpDate: { not: null } }],
        },
      },
    },
    select: {
      id: true,
      email: { select: { receivedAt: true, sender: true, aiProcessingResult: true } },
    },
  });
  let repaired = 0;
  for (const { id, email } of steps) {
    const request =
      email?.aiProcessingResult &&
      requestOf(email.aiProcessingResult, email.receivedAt, email.sender);
    if (!request?.deadline.deadline) continue;
    const { count } = await prisma.action.updateMany({
      where: { id, status: 'PENDING', retiredAt: null, deadline: null },
      data: {
        deadline: request.deadline.deadline,
        deadlinePrecision: request.deadline.precision,
        actionRevision: { increment: 1 },
      },
    });
    repaired += count;
  }
  return repaired;
}

/**
 * Open steps from mails keep the words they were made with. One that says "then tell them you
 * did" about a sender no reply can reach (`canReplyTo`: a system address, or an address whose mail
 * has since said that nobody reads replies) gets today's words. Returns how many did.
 */
async function writeStepTextsAgain() {
  const steps = await prisma.action.findMany({
    where: {
      status: 'PENDING',
      retiredAt: null,
      description: { endsWith: TELL_THEM },
      OR: [{ origin: null }, { origin: { not: 'USER' } }],
      email: { aiProcessingResult: { isNot: null } },
    },
    select: {
      id: true,
      description: true,
      application: { select: { userId: true } },
      email: { select: { receivedAt: true, sender: true, aiProcessingResult: true } },
    },
  });
  const saidNoReply = new Map<string, Set<string>>();
  let changed = 0;
  for (const { id, description, application, email } of steps) {
    const { userId } = application;
    const known = saidNoReply.get(userId) ?? (await noReplySenders(prisma, userId));
    saidNoReply.set(userId, known);
    const text =
      email?.aiProcessingResult &&
      requestOf(email.aiProcessingResult, email.receivedAt, email.sender, known)?.text;
    if (!text || text.endsWith(TELL_THEM)) continue;
    const { count } = await prisma.action.updateMany({
      where: { id, status: 'PENDING', retiredAt: null, description },
      data: { description: text, actionRevision: { increment: 1 } },
    });
    changed += count;
  }
  if (changed) logEvent('step_texts_updated', { changed });
  return changed;
}

/** The hourly run: old rows first, then every user who has an open step from a mail. */
export async function tidyAllRequests() {
  const dropped = await dropAsksThatAreNone();
  const deadlines = await readStepDeadlinesAgain();
  await writeStepTextsAgain();
  const users = await prisma.user.findMany({
    where: {
      applications: {
        some: { actions: { some: { status: 'PENDING', retiredAt: null, emailId: { not: null } } } },
      },
    },
    select: { id: true },
  });
  let closed = 0;
  for (const { id } of users) closed += await tidyRequestsOf(id);
  if (dropped || deadlines || closed)
    logEvent('request_upkeep_done', { dropped, deadlines, closed });
  return { dropped, deadlines, closed };
}
