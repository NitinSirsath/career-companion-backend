import type { JobWithMetadata } from 'pg-boss';
import { EMAIL_PROCESSING_JOB, EmailProcessingJobData } from '../services/enqueue';
import { getQueue } from '../services/queue';
import { prisma } from '../db/prisma';
import { AIAccessError, AIProviderError, TerminalAIError } from '../services/ai/errors';
import { processEmail } from '../services/ai/pipeline';
import { logDebug, logEvent, logWarn, logError } from '../utils/log';

/**
 * Persisted/logged failure description. Only application-authored AI error messages are stored;
 * any other error (database, Gmail transport, unexpected) is reduced to a fixed safe message.
 */
export function describeFailure(err: unknown) {
  if (err instanceof AIProviderError) {
    return {
      category: err.name,
      details: err.message.slice(0, 300),
      stage: err.operationStage ?? null,
      retryable: err.isRetryable,
    };
  }
  const gmail = err instanceof Error && err.message === 'Gmail request failed';
  return {
    category: gmail ? 'GmailRequestFailed' : 'ProcessingError',
    details: gmail ? 'Gmail request failed' : 'Processing failed unexpectedly',
    stage: gmail ? 'gmail' : null,
    retryable: true,
  };
}

/**
 * The only error handed to pg-boss for a failed email job. pg-boss serializes thrown errors
 * (message, stack, enumerable properties) into pgboss.job.output, so it carries the safe
 * category alone and never the original error (S6-R06).
 */
export class EmailJobFailure extends Error {
  constructor(category: string) {
    super(category);
    this.name = 'EmailJobFailure';
    this.stack = `${this.name}: ${category}`;
  }
}

/**
 * Withdraws (cancels) a delivery that only waited for AI access. pg-boss keeps each email's
 * singleton slot for 5 minutes for every job that was not cancelled, so without this a re-offer
 * after the user fixes access, or after a short cooldown, would be suppressed. Cancelling the
 * active job frees the slot; pg-boss then leaves it cancelled instead of completing it.
 * Best effort: on failure the email still waits and is re-offered by a later sync.
 */
async function withdrawDelivery(jobId: string) {
  try {
    await (await getQueue()).cancel(EMAIL_PROCESSING_JOB, jobId);
  } catch {
    logWarn('job_withdraw_failed', { jobId });
  }
}

export async function processEmailJob(job: JobWithMetadata<EmailProcessingJobData>) {
  const { userId, emailId } = job.data;
  const startTime = Date.now();
  const attempt = { retryCount: job.retryCount, retryLimit: job.retryLimit };

  logDebug('job_started', { jobId: job.id, emailId, ...attempt });

  try {
    // The worker alone moves an email (including a manually retried FAILED one) into PROCESSING.
    await prisma.email.updateMany({
      where: { id: emailId, userId, processingState: { not: 'COMPLETED' } },
      data: { processingState: 'PROCESSING' },
    });
    await processEmail(userId, emailId, { signal: job.signal });
    logDebug('job_completed', {
      jobId: job.id,
      emailId,
      outcome: 'completed',
      durationMs: Date.now() - startTime,
      ...attempt,
    });
  } catch (err) {
    if (err instanceof AIAccessError) {
      // Waiting for the user's AI access is not a processing failure (ADR-0001 decision 8): the
      // email returns to PENDING with no error fields, the job is acknowledged, and no email or
      // operation attempt is used. The reason lives once, on the user's AI configuration.
      await prisma.email.updateMany({
        where: { id: emailId, userId, processingState: { not: 'COMPLETED' } },
        data: {
          processingState: 'PENDING',
          processingErrorCategory: null,
          processingErrorDetails: null,
          processingErrorStage: null,
          processingRetryable: null,
          processingFailedAt: null,
        },
      });
      await withdrawDelivery(job.id);
      logEvent('job_waiting_for_ai', {
        jobId: job.id,
        emailId,
        reason: err.reason,
        durationMs: Date.now() - startTime,
        ...attempt,
      });
      return;
    }
    const failure = describeFailure(err);
    const terminal = err instanceof TerminalAIError;
    const exhausted = !terminal && job.retryCount >= job.retryLimit;
    const final = terminal || exhausted;

    // Completed emails are never downgraded. A failure at the final permitted delivery is FAILED.
    await prisma.email.updateMany({
      where: { id: emailId, userId, processingState: { not: 'COMPLETED' } },
      data: {
        processingState: final ? 'FAILED' : 'PROCESSING',
        processingErrorCategory: failure.category,
        processingErrorDetails: failure.details,
        processingErrorStage: failure.stage,
        processingRetryable: final ? false : failure.retryable,
        processingFailedAt: new Date(),
      },
    });

    logError(
      'job_failed',
      {
        jobId: job.id,
        emailId,
        outcome: terminal ? 'failed_terminal' : exhausted ? 'failed_exhausted' : 'retry_scheduled',
        errorCategory: failure.category,
        errorStage: failure.stage,
        durationMs: Date.now() - startTime,
        ...attempt,
      },
      err,
    );
    // Terminal work is acknowledged; anything else lets pg-boss record retry or exhaustion.
    // The original error stays in memory: only the sanitized category reaches pg-boss storage.
    if (!terminal) throw new EmailJobFailure(failure.category);
  }
}

/**
 * Delivery invariant (S6-03): exactly one job per callback. Installed pg-boss 12.31 already
 * defaults to batchSize=1; registration states it explicitly. If more than one job is ever
 * delivered, the callback fails so pg-boss retries every delivered job — none is acknowledged
 * without an attempted, attributable outcome.
 */
export const EMAIL_WORKER_OPTIONS = { includeMetadata: true, batchSize: 1 } as const;

export async function handleEmailJobs(jobs: JobWithMetadata<EmailProcessingJobData>[]) {
  if (jobs.length !== 1) {
    logError('job_batch_rejected', {
      queue: EMAIL_PROCESSING_JOB,
      delivered: jobs.length,
      jobIds: jobs.map((job) => job.id),
    });
    throw new Error('UNEXPECTED_EMAIL_JOB_BATCH');
  }
  await processEmailJob(jobs[0]);
}

export async function startEmailProcessingWorker() {
  const queue = await getQueue();
  await queue.work(EMAIL_PROCESSING_JOB, EMAIL_WORKER_OPTIONS, handleEmailJobs);
  logDebug('worker_registered', { queue: EMAIL_PROCESSING_JOB, batchSize: 1 });
}
