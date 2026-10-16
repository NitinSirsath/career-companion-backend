/**
 * Offers emails to AI processing. Gmail sync and AI settings both call this module, so neither
 * imports the other.
 */
import type { AIOperationStatus } from '@prisma/client';
import type { AIRole } from '../../contracts/aiCatalog';
import { prisma } from '../../db/prisma';
import { enqueueEmailProcessingJob, enqueueRelevanceTriage } from '../enqueue';
import { ModelPause, getAccessState } from './access';
import { triageBatchEnabled } from './triage';
import { resumeAfterPause } from './usage';
import { logEvent } from '../../utils/log';

export const REOFFER_LIMIT = 100;

/** Queues a newly synced email: the user's batched relevance check when batching is on, else its own job. */
export async function enqueueForProcessing(userId: string, emailId: string): Promise<void> {
  if (triageBatchEnabled()) await enqueueRelevanceTriage(userId);
  else await offerEmail(userId, emailId);
}

/** Queues the email's own job. While a job for it waits or runs, the queue drops this one. */
async function offerEmail(userId: string, emailId: string) {
  if (!(await enqueueEmailProcessingJob(userId, emailId)))
    logEvent('email_offer_suppressed', { userId, emailId });
}

/**
 * The model role a waiting email needs next, from its classification rows: the fast model until
 * its relevance is decided, then the detailed one.
 */
export const nextRole = (email: { aiOperations: { status: AIOperationStatus }[] }): AIRole =>
  email.aiOperations.some((op) => op.status === 'COMPLETED') ? 'detailed' : 'fast';

/** Up to 100 of the user's PENDING emails, newest first, with the model role each needs next. */
async function waitingEmails(userId: string) {
  const pending = await prisma.email.findMany({
    where: { userId, processingState: 'PENDING' },
    orderBy: [{ receivedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
    take: REOFFER_LIMIT,
    select: {
      id: true,
      aiProcessingResult: { select: { id: true } },
      aiOperations: { where: { operation: 'classification' }, select: { status: true } },
    },
  });
  return pending.map((email) => ({ ...email, role: nextRole(email) }));
}

/** True while the email waits for a paused model; only that pause's test mail may go. */
const waitsForPause = (pauses: readonly ModelPause[], email: { id: string; role: AIRole }) =>
  pauses.some((pause) => pause.roles.includes(email.role) && pause.testEmailId !== email.id);

/**
 * Re-offers up to 100 of the user's PENDING emails to the worker, newest first, so fresh mail is
 * not stuck behind a backlog. Covers the DB-insert / queue-send gap and emails that waited for AI
 * access. Offers nothing while the user's AI access is not ready (at Career Companion's daily limit
 * it queues the read for midnight UTC), and skips an email whose next step needs a paused model:
 * those emails wait and are re-offered when the pause ends (`resumeWaitingEmails`), by the next
 * sync, or after the user fixes access. Enqueueing is idempotent per email (singleton key).
 * Returns how many emails were offered.
 */
export async function reofferPendingEmails(
  userId: string,
  guard?: () => Promise<void>,
): Promise<number> {
  const access = await getAccessState(userId);
  if (access.state !== 'READY') {
    if (access.reason === 'SAFETY_LIMIT') await resumeAfterPause(userId, access.resumesAt);
    return 0;
  }
  const waiting = (await waitingEmails(userId)).filter(
    (email) => !waitsForPause(access.pauses, email),
  );
  let triageQueued = false;
  for (const email of waiting) {
    await guard?.();
    // With batching on, an email with no result and no classification row goes to the batched
    // check; every other email continues on the per-email job, which reuses or resumes its row.
    if (triageBatchEnabled() && !email.aiProcessingResult && !email.aiOperations.length) {
      if (!triageQueued) {
        await enqueueRelevanceTriage(userId);
        triageQueued = true;
      }
      continue;
    }
    await offerEmail(userId, email.id);
  }
  return waiting.length;
}

/**
 * "Read waiting mails now" while models are paused: the newest waiting email whose next step needs
 * a paused model goes first, alone, as the test. Until such a model answers, only the test mail
 * may use it; the others follow when it works (`noteProviderSuccess`). A test the mail's job leaves
 * without an answer from that model ends with the job (`endTest`). Returns the test mail's ID, or
 * null when no waiting mail needs a paused model.
 */
export async function offerTestMail(
  userId: string,
  pauses: readonly ModelPause[],
): Promise<string | null> {
  const test = (await waitingEmails(userId)).find((email) =>
    pauses.some((pause) => pause.roles.includes(email.role)),
  );
  if (!test) return null;
  // The steps the test mail still has: sorting, then the details; or the details only.
  const steps: AIRole[] = test.role === 'fast' ? ['fast', 'detailed'] : ['detailed'];
  const tested = pauses.filter((pause) => pause.roles.some((role) => steps.includes(role)));
  await prisma.aIModelPause.updateMany({
    where: { userId, model: { in: tested.map((pause) => pause.model) } },
    data: { testEmailId: test.id, testStartedAt: new Date(), testResult: null },
  });
  await offerEmail(userId, test.id);
  return test.id;
}

/**
 * Runs when a pause or Career Companion's daily limit ends (the job queued then). The waiting mail
 * whose next step can run now is offered again; mail for a model that is still paused waits for
 * that pause's own job. If the provider is still busy, the first call starts the next, longer
 * pause and queues the next try. Problems that need the user (key, billing, model) get no
 * automatic try; while the daily limit is reached, the read waits until midnight UTC.
 */
export async function resumeWaitingEmails(userId: string): Promise<void> {
  const access = await getAccessState(userId);
  const offered = await reofferPendingEmails(userId);
  logEvent('ai_resumed_after_pause', { userId, offered, access: access.state });
}
