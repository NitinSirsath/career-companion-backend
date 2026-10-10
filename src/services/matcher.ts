import { suppressNotifications } from './notificationSuppression';
import { AppError, CHANGE_REJECTED } from '../errors';
import { projectAgenda } from './agenda';
import { Prisma, Email, Application, Action } from '@prisma/client';
import type { CorrectEmailMatchRequest } from '../contracts/email';
import { lockUser, LOCK_NAMESPACE } from '../utils/advisoryLock';
import { parseActionDeadline } from '../utils/actionDeadline';
import { prisma } from '../db/prisma';
import {
  ApplicationStatus,
  EmailMatchState,
  EmailRelevanceState,
  AIProcessingResult,
  MatchConfirmationSource,
} from '@prisma/client';
import { enqueueNotificationJob } from './enqueue';
import { logEvent, logError } from '../utils/log';

// Messages for a match correction that fails.
const MATCH_GONE = 'Email or application no longer available';
const MATCH_CHANGED =
  'This email link changed or cannot be corrected. Refresh before trying again.';

/**
 * Run the matching logic for an email.
 * Returns the applicationId if matched, or undefined.
 */
export async function matchEmailToApplication(emailId: string): Promise<void> {
  const email = await prisma.email.findUnique({
    where: { id: emailId },
    include: { aiProcessingResult: true },
  });

  if (!email || !email.aiProcessingResult) {
    return;
  }

  const { aiProcessingResult, userId, matchConfirmedBy, applicationId } = email;

  if (matchConfirmedBy === MatchConfirmationSource.USER_CONFIRMED && !applicationId) return;

  if (matchConfirmedBy === MatchConfirmationSource.USER_CONFIRMED && applicationId) {
    // Re-apply the match using the existing user-confirmed application to allow
    // new AI data (e.g. actions/state) to be recorded, but PRESERVE the user's decision.
    await applyMatch(
      email.id,
      applicationId,
      aiProcessingResult,
      MatchConfirmationSource.USER_CONFIRMED,
    );
    return;
  }

  if (email.matchState === 'MATCHED' && applicationId) {
    await applyMatch(email.id, applicationId, aiProcessingResult, 'AI_AUTO');
    return;
  }
  if (email.matchState === 'IGNORED') return;

  // 1. Thread Match
  const decision = await threadDecision(prisma, email);
  if (decision.kind === 'STOP') return;
  if (
    decision.kind === 'LINK' &&
    (await applyMatch(email.id, decision.applicationId, aiProcessingResult, 'AI_AUTO', true))
  )
    return;

  // 2. Company + Role Match
  const companyName = aiProcessingResult.companyName;
  const role = aiProcessingResult.jobTitle;

  if (!companyName) {
    // If we don't have a company name, we can't do a deterministic match
    return;
  }

  // Normalize
  const normalizedCompany = normalize(companyName);
  const normalizedRole = role ? normalize(role) : null;

  // Find candidate applications for this user
  const applications = await prisma.application.findMany({
    where: { userId, archivedAt: null },
  });

  const candidates = applications.filter((app) => {
    const appCompany = normalize(app.companyName);
    if (appCompany !== normalizedCompany) return false;

    if (normalizedRole && app.jobTitle) {
      const appRole = normalize(app.jobTitle);
      if (appRole !== normalizedRole) return false;
    }

    return true;
  });

  if (candidates.length === 1) {
    // Exact match
    await applyMatch(
      email.id,
      candidates[0].id,
      aiProcessingResult,
      MatchConfirmationSource.AI_AUTO,
    );
  } else if (candidates.length > 1) {
    const current = await prisma.$transaction(async (tx) => {
      await lockUser(tx, LOCK_NAMESPACE.emailMatches, userId);
      await tx.$queryRaw`SELECT id FROM emails WHERE id = ${email.id}::uuid FOR UPDATE`;
      const fresh = await tx.email.findUniqueOrThrow({ where: { id: email.id } });
      if (fresh.matchState === 'MATCHED' || fresh.matchState === 'IGNORED')
        return { kind: 'NONE' as const };
      const decision = await threadDecision(tx, fresh);
      if (decision.kind === 'LINK') return decision;
      await tx.email.updateMany({
        where: {
          id: email.id,
          matchState: { in: ['UNMATCHED', 'AMBIGUOUS'] },
          OR: [{ matchConfirmedBy: null }, { matchConfirmedBy: { not: 'USER_CONFIRMED' } }],
        },
        data: { matchState: decision.kind === 'STOP' ? 'UNMATCHED' : 'AMBIGUOUS' },
      });
      return decision;
    });
    if (current.kind === 'LINK')
      await applyMatch(email.id, current.applicationId, aiProcessingResult, 'AI_AUTO', true);
  }
}

function normalize(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

export async function applyMatch(
  emailId: string,
  applicationId: string,
  aiResult: AIProcessingResult,
  source: MatchConfirmationSource,
  fromThread = false,
) {
  const owner = await prisma.email.findUnique({
    where: { id: emailId },
    select: { userId: true },
  });
  if (!owner) throw new Error('EMAIL_NOT_FOUND');
  const actionId = await prisma.$transaction(async (tx) => {
    await lockUser(tx, LOCK_NAMESPACE.emailMatches, owner.userId);
    // Serialize domain effects for this email and application, inside the DB transaction.
    await tx.$queryRaw`SELECT id FROM emails WHERE id = ${emailId}::uuid FOR UPDATE`;
    const email = await tx.email.findUnique({ where: { id: emailId } });
    if (!email || aiResult.emailId !== emailId) throw new Error('EMAIL_NOT_FOUND');
    if (
      source === MatchConfirmationSource.AI_AUTO &&
      email.matchConfirmedBy === MatchConfirmationSource.USER_CONFIRMED
    )
      return null;
    if (source === 'AI_AUTO') {
      if (
        email.matchState === 'IGNORED' ||
        (email.matchState === 'MATCHED' && email.applicationId !== applicationId)
      )
        return null;
      if (email.matchState !== 'MATCHED') {
        const current = await threadDecision(tx, email);
        if (current.kind === 'STOP') return null;
        if (current.kind === 'LINK') {
          applicationId = current.applicationId;
          fromThread = true;
        } else if (fromThread) return undefined;
      }
    }
    await tx.$queryRaw`SELECT id FROM applications WHERE id = ${applicationId}::uuid AND "userId" = ${email.userId}::uuid FOR UPDATE`;
    const app = await tx.application.findFirst({
      where: { id: applicationId, userId: email.userId },
    });
    if (!app) throw new Error('APPLICATION_NOT_FOUND');
    if (app.archivedAt && email.applicationId !== app.id && !fromThread) {
      if (source === 'USER_CONFIRMED')
        throw new AppError(409, 'APPLICATION_ARCHIVED', CHANGE_REJECTED);
      return null;
    }
    // Fresh state check at the write boundary. A user link is legal only for an email
    // that is still unresolved, or as a replay of the same confirmed link. A resolution whose
    // pre-lock read was overtaken by another decision (another user link, an ignore, or a
    // completed automatic match) fails exactly as it would sequentially; effects never move.
    if (
      source === MatchConfirmationSource.USER_CONFIRMED &&
      !(
        email.matchState === EmailMatchState.UNMATCHED ||
        email.matchState === EmailMatchState.AMBIGUOUS ||
        (email.matchConfirmedBy === source && email.applicationId === applicationId)
      )
    )
      throw new Error('INVALID_MATCH_STATE');
    await tx.email.update({
      where: { id: emailId },
      data: {
        applicationId,
        matchState: EmailMatchState.MATCHED,
        matchConfirmedBy: source,
      },
    });
    return applyEffects(tx, email, app, aiResult);
  });
  if (actionId) {
    try {
      await enqueueNotificationJob(actionId);
    } catch {
      logError('notification_enqueue_failed', { actionId });
    }
  }
  return actionId !== undefined;
}

type EmailWithResult = Prisma.EmailGetPayload<{ include: { aiProcessingResult: true } }>;

export async function correctEmailMatch(
  userId: string,
  emailId: string,
  request: CorrectEmailMatchRequest,
) {
  const target = request.applicationId;
  const result = await prisma.$transaction(async (tx) => {
    const email = await lockEmailForCorrection(tx, userId, emailId, request);
    const work = await workFromEmail(tx, userId, emailId);
    const apps = await lockApplications(tx, userId, [
      ...(email.applicationId ? [email.applicationId] : []),
      ...work.events.map((e) => e.applicationId),
      ...work.actions.map((a) => a.applicationId),
      ...work.agenda.map((a) => a.applicationId),
      ...(target ? [target] : []),
    ]);
    const targetApp = apps.find((a) => a.id === target);
    if (target && !targetApp) throw new AppError(404, 'APPLICATION_NOT_FOUND', MATCH_GONE);
    if (targetApp?.archivedAt) throw new AppError(409, 'APPLICATION_ARCHIVED', CHANGE_REJECTED);
    if (target && !email.aiProcessingResult)
      throw new AppError(409, 'MATCH_NOT_CORRECTABLE', MATCH_CHANGED);

    const sources = apps.filter((a) => a.id !== target).map((a) => a.id);
    const retired = await retireWorkFromEmail(tx, userId, emailId, sources, !!target);
    const updated = await tx.email.update({
      where: { id: emailId },
      data: {
        applicationId: target,
        matchState: target ? 'MATCHED' : 'IGNORED',
        matchConfirmedBy: 'USER_CONFIRMED',
      },
      select: { id: true, matchState: true, matchConfirmedBy: true, applicationId: true },
    });
    if (targetApp && email.aiProcessingResult) {
      // The user's earlier answer travels with the email: done stays done, a snooze stays a snooze.
      await applyEffects(tx, email, targetApp, email.aiProcessingResult, {
        reactivate: true,
        actionStatus: carriedActionStatus(work.priorActions),
        snoozedUntil:
          work.priorActions.find((a) => a.status === 'PENDING' && a.snoozedUntil)?.snoozedUntil ??
          null,
      });
      await projectAgenda(tx, email, targetApp, email.aiProcessingResult, true, work.priorAgenda);
    }
    await refreshAiStatus(
      tx,
      userId,
      apps.filter((a) => sources.includes(a.id)),
    );
    return {
      email: updated,
      affectedApplicationIds: apps.map((a) => a.id),
      fromApplicationIds: sources,
      ...retired,
    };
  });
  logEvent('email_match_corrected', {
    emailId,
    kind: target ? 'MOVE' : 'UNLINK',
    fromApplicationIds: result.fromApplicationIds,
    toApplicationId: target,
    retiredEvents: result.retiredEvents,
    retiredActions: result.retiredActions,
  });
  return { email: result.email, affectedApplicationIds: result.affectedApplicationIds };
}

/** Locks the email and refuses the correction when the user acted on an outdated screen. */
async function lockEmailForCorrection(
  tx: Prisma.TransactionClient,
  userId: string,
  emailId: string,
  request: CorrectEmailMatchRequest,
): Promise<EmailWithResult> {
  await lockUser(tx, LOCK_NAMESPACE.emailMatches, userId);
  await tx.$queryRaw`SELECT id FROM emails WHERE id = ${emailId}::uuid AND "userId" = ${userId}::uuid FOR UPDATE`;
  const email = await tx.email.findFirst({
    where: { id: emailId, userId },
    include: { aiProcessingResult: true },
  });
  if (!email) throw new AppError(404, 'NOT_FOUND', MATCH_GONE);
  if (
    email.matchState !== request.expectedMatchState ||
    email.applicationId !== request.expectedApplicationId
  )
    throw new AppError(409, 'MATCH_CONFLICT', MATCH_CHANGED);
  return email;
}

/**
 * The events, actions and agenda items this email produced. When none is live any more, the
 * `prior` lists hold the retired ones, so a move can carry the user's earlier answers over.
 */
async function workFromEmail(tx: Prisma.TransactionClient, userId: string, emailId: string) {
  const events = await tx.applicationEvent.findMany({
    where: {
      emailId,
      retiredAt: null,
      externalSubmissionId: null,
      type: { not: 'AUTOMATION_SUBMITTED' },
      application: { userId },
    },
    select: { applicationId: true },
  });
  const actions = await tx.action.findMany({
    where: { emailId, retiredAt: null, application: { userId } },
    select: { applicationId: true, status: true, snoozedUntil: true },
  });
  const agenda = await tx.agendaItem.findMany({
    where: { emailId, userId, retiredAt: null },
    orderBy: { id: 'asc' },
  });
  const priorActions = actions.length
    ? actions
    : await tx.action.findMany({
        where: { emailId, application: { userId }, retiredAt: { not: null } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 1,
      });
  const priorAgenda = agenda.length
    ? agenda
    : await tx.agendaItem.findMany({
        where: { emailId, userId },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      });
  return { events, actions, agenda, priorActions, priorAgenda };
}

/** Locks the user's applications in ID order, so two corrections cannot deadlock. */
async function lockApplications(tx: Prisma.TransactionClient, userId: string, ids: string[]) {
  const affected = [...new Set(ids)].sort();
  if (!affected.length) return [];
  return tx.$queryRaw<
    Application[]
  >`SELECT * FROM applications WHERE id = ANY(${affected}::uuid[]) AND "userId" = ${userId}::uuid ORDER BY id FOR UPDATE`;
}

/** Retires what the email produced on the applications it is leaving. Nothing is deleted. */
async function retireWorkFromEmail(
  tx: Prisma.TransactionClient,
  userId: string,
  emailId: string,
  sources: string[],
  moved: boolean,
) {
  const retirement = {
    retiredAt: new Date(),
    retiredReason: moved ? ('EMAIL_MOVED' as const) : ('EMAIL_UNLINKED' as const),
  };
  const retiredEvents = await tx.applicationEvent.updateMany({
    where: {
      emailId,
      applicationId: { in: sources },
      retiredAt: null,
      externalSubmissionId: null,
      type: { not: 'AUTOMATION_SUBMITTED' },
    },
    data: retirement,
  });
  const retiredActions = await tx.action.updateMany({
    where: { emailId, applicationId: { in: sources }, retiredAt: null },
    data: { ...retirement, actionRevision: { increment: 1 } },
  });
  await tx.agendaItem.updateMany({
    where: { emailId, userId, applicationId: { in: sources }, retiredAt: null },
    data: { ...retirement, revision: { increment: 1 } },
  });
  return { retiredEvents: retiredEvents.count, retiredActions: retiredActions.count };
}

function carriedActionStatus(priorActions: { status: Action['status'] }[]) {
  if (priorActions.some((a) => a.status === 'COMPLETED')) return 'COMPLETED';
  return priorActions.some((a) => a.status === 'DISMISSED') ? 'DISMISSED' : 'PENDING';
}

/** An application's AI status follows the emails still matched to it. */
async function refreshAiStatus(tx: Prisma.TransactionClient, userId: string, apps: Application[]) {
  for (const app of apps) {
    const remaining = await tx.aIProcessingResult.findMany({
      where: { email: { userId, applicationId: app.id, matchState: 'MATCHED' } },
    });
    const aiStatus = aiStatusFromEvidence(remaining);
    if (app.aiStatus !== aiStatus)
      await tx.application.update({ where: { id: app.id }, data: { aiStatus } });
  }
}

export async function getAmbiguousMatches(userId: string, limit: number = 20, offset: number = 0) {
  return prisma.email.findMany({
    where: {
      userId,
      matchState: EmailMatchState.AMBIGUOUS,
    },
    take: limit + 1,
    skip: offset,
    include: {
      aiProcessingResult: true,
    },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
  });
}

/**
 * Get relevant emails that had zero candidate applications during matching.
 * These need user-driven resolution to link them to an existing application.
 */
export async function getUnmatchedEmails(userId: string, limit: number = 20, offset: number = 0) {
  return prisma.email.findMany({
    where: {
      userId,
      relevanceState: EmailRelevanceState.RELEVANT,
      matchState: EmailMatchState.UNMATCHED,
    },
    take: limit + 1,
    skip: offset,
    include: {
      aiProcessingResult: true,
    },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
  });
}

/**
 * Resolve an email that needs human-in-the-loop matching.
 * Supports both AMBIGUOUS (multiple candidates) and UNMATCHED (zero candidates) emails.
 *
 * For AMBIGUOUS: applicationId can be null (→ IGNORED) or a valid application ID.
 * For UNMATCHED: applicationId must be non-null (linking to an application is mandatory).
 */
export async function resolveEmailMatch(
  userId: string,
  emailId: string,
  applicationId: string | null,
): Promise<void> {
  const email = await prisma.email.findUnique({
    where: { id: emailId, userId }, // isolation check
    include: { aiProcessingResult: true },
  });

  if (!email) {
    throw new Error('EMAIL_NOT_FOUND');
  }

  // Validate match state — only AMBIGUOUS and UNMATCHED can be resolved
  if (
    email.matchState !== EmailMatchState.AMBIGUOUS &&
    email.matchState !== EmailMatchState.UNMATCHED
  ) {
    throw new Error('INVALID_MATCH_STATE');
  }

  // UNMATCHED emails require an applicationId (linking is mandatory)
  if (email.matchState === EmailMatchState.UNMATCHED && !applicationId) {
    throw new Error('APPLICATION_REQUIRED_FOR_UNMATCHED');
  }

  if (!applicationId) {
    // No match — only valid for AMBIGUOUS emails
    const ignored = await prisma.$transaction(async (tx) => {
      await lockUser(tx, LOCK_NAMESPACE.emailMatches, userId);
      return tx.email.updateMany({
        where: { id: emailId, userId, matchState: 'AMBIGUOUS' },
        data: { matchState: 'IGNORED', matchConfirmedBy: 'USER_CONFIRMED' },
      });
    });
    if (!ignored.count) throw new Error('INVALID_MATCH_STATE');
    return;
  }

  // Ownership check for application
  const app = await prisma.application.findUnique({
    where: { id: applicationId, userId }, // isolation check
  });

  if (!app) {
    throw new Error('APPLICATION_NOT_FOUND');
  }

  if (!email.aiProcessingResult) {
    throw new Error('NO_AI_RESULT');
  }

  await applyMatch(
    email.id,
    applicationId,
    email.aiProcessingResult,
    MatchConfirmationSource.USER_CONFIRMED,
  );
}
export function inferState(aiResult: AIProcessingResult): ApplicationStatus | null {
  if (aiResult.rejectionInfo || aiResult.category === 'REJECTION')
    return ApplicationStatus.REJECTED;
  if (aiResult.offerInfo || aiResult.category === 'OFFER') return ApplicationStatus.OFFER;
  if (aiResult.interviewStage || aiResult.interviewDate || aiResult.category === 'INTERVIEW')
    return ApplicationStatus.INTERVIEW;
  if (aiResult.assessmentInfo || aiResult.category === 'ASSESSMENT')
    return ApplicationStatus.ASSESSMENT;
  if (aiResult.recruiterName || aiResult.category === 'RECRUITER')
    return ApplicationStatus.RECRUITER_CONTACT;
  return null;
}

export function canTransition(current: ApplicationStatus | null, next: ApplicationStatus): boolean {
  if (!current) return true;

  const stateOrder: Record<ApplicationStatus, number> = {
    APPLIED: 0,
    RECRUITER_CONTACT: 1,
    ASSESSMENT: 2,
    INTERVIEW: 3,
    OFFER: 4,
    REJECTED: 5,
    CLOSED: 6,
  };

  return stateOrder[next] >= stateOrder[current];
}
export function aiStatusFromEvidence(results: AIProcessingResult[]): ApplicationStatus | null {
  let status: ApplicationStatus | null = null;
  for (const result of results) {
    const next = inferState(result);
    if (next && canTransition(status, next)) status = next;
  }
  return status;
}
export async function threadDecision(db: Prisma.TransactionClient, email: Email) {
  if (!email.threadId) return { kind: 'NONE' as const };
  const where = { userId: email.userId, threadId: email.threadId, id: { not: email.id } };
  const orderBy = [{ receivedAt: 'desc' as const }, { id: 'desc' as const }];
  const confirmed = await db.email.findFirst({
    where: {
      ...where,
      matchConfirmedBy: 'USER_CONFIRMED',
      matchState: { in: ['MATCHED', 'IGNORED'] },
    },
    orderBy,
  });
  if (confirmed)
    return confirmed.matchState === 'IGNORED' || !confirmed.applicationId
      ? { kind: 'STOP' as const }
      : { kind: 'LINK' as const, applicationId: confirmed.applicationId };
  const automatic = await db.email.findFirst({
    where: { ...where, matchState: 'MATCHED', applicationId: { not: null } },
    orderBy,
  });
  return automatic?.applicationId
    ? { kind: 'LINK' as const, applicationId: automatic.applicationId }
    : { kind: 'NONE' as const };
}

/**
 * Applies a matched email to its application: status, timeline event, agenda and action.
 * Returns the ID of the action to notify about, or null when there is nothing to notify.
 */
async function applyEffects(
  tx: Prisma.TransactionClient,
  email: Email,
  app: Application,
  aiResult: AIProcessingResult,
  carried: {
    reactivate?: boolean;
    actionStatus?: Action['status'];
    snoozedUntil?: Date | null;
  } = {},
) {
  const { reactivate = false, actionStatus = 'PENDING', snoozedUntil = null } = carried;
  await recordEmailOnTimeline(tx, email, app, aiResult, reactivate);
  if (!reactivate) await projectAgenda(tx, email, app, aiResult);
  if (!aiResult.actionRequired && !aiResult.followUpRequired) return null;

  const existing = await tx.action.findFirst({
    where: { applicationId: app.id, emailId: email.id },
  });
  if (existing) return reuseAction(tx, app, existing, reactivate);

  const action = await createActionFromEmail(tx, email, app, aiResult, {
    actionStatus,
    snoozedUntil,
  });
  if (app.archivedAt || (snoozedUntil && snoozedUntil > new Date())) {
    await suppressNotifications(tx, [action.id]);
    return null;
  }
  return action.id;
}

/** Moves the application's AI status forward when the email suggests it, and records the event once. */
async function recordEmailOnTimeline(
  tx: Prisma.TransactionClient,
  email: Email,
  app: Application,
  aiResult: AIProcessingResult,
  reactivate: boolean,
) {
  const emailId = email.id,
    applicationId = app.id;
  const newState = inferState(aiResult);
  const finalState = newState && canTransition(app.aiStatus, newState) ? newState : app.aiStatus;
  if (finalState !== app.aiStatus)
    await tx.application.update({
      where: { id: applicationId },
      data: { aiStatus: finalState },
    });
  const existingEvent = await tx.applicationEvent.findFirst({
    where: { applicationId, emailId, type: 'EMAIL_PROCESSED' },
  });
  if (existingEvent?.retiredAt && reactivate)
    await tx.applicationEvent.update({
      where: { id: existingEvent.id },
      data: { retiredAt: null, retiredReason: null },
    });
  if (!existingEvent)
    await tx.applicationEvent.create({
      data: {
        applicationId,
        emailId,
        type: 'EMAIL_PROCESSED',
        oldState: app.aiStatus,
        newState: finalState,
        description: newState
          ? `Received relevant email suggesting state ${newState}`
          : 'Received relevant email',
        provenance: aiResult.provenance,
      },
    });
}

/** The email already produced an action here: bring it back if asked, never create a second one. */
async function reuseAction(
  tx: Prisma.TransactionClient,
  app: Application,
  existing: Action,
  reactivate: boolean,
) {
  if (existing.retiredAt && reactivate)
    await tx.action.update({
      where: { id: existing.id },
      data: { retiredAt: null, retiredReason: null, actionRevision: { increment: 1 } },
    });
  if (app.archivedAt || (existing.snoozedUntil && existing.snoozedUntil > new Date())) {
    await suppressNotifications(tx, [existing.id]);
    return null;
  }
  return existing.retiredAt && !reactivate ? null : existing.id;
}

async function createActionFromEmail(
  tx: Prisma.TransactionClient,
  email: Email,
  app: Application,
  aiResult: AIProcessingResult,
  carried: { actionStatus: Action['status']; snoozedUntil: Date | null },
) {
  const deadlineText = aiResult.actionRequired ? aiResult.actionDeadline : aiResult.followUpDate;
  const parsed = parseActionDeadline(deadlineText, email.receivedAt);
  if (deadlineText?.trim() && !parsed.deadline)
    logEvent('action_deadline_unclear', { emailId: email.id, reason: parsed.reason });
  return tx.action.create({
    data: {
      applicationId: app.id,
      emailId: email.id,
      status: carried.actionStatus,
      origin: 'EMAIL',
      snoozedUntil: carried.actionStatus === 'PENDING' ? carried.snoozedUntil : null,
      type: aiResult.actionRequired ? 'ACTION_REQUIRED' : 'FOLLOW_UP_REQUIRED',
      description: aiResult.actionRequired
        ? aiResult.requestedAction || 'Action required'
        : 'Follow up required',
      deadline: parsed.deadline,
      deadlinePrecision: parsed.precision,
    },
  });
}
