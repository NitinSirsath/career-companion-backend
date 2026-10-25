/**
 * The one place that puts background work on the queue: each job's name, payload, options and
 * enqueue function. Services queue work through these; the files in `src/jobs/` only run it.
 */
import { getQueue } from './queue';

export const EMAIL_PROCESSING_JOB = 'email-processing-job';
export const EMAIL_RETRY_LIMIT = 3;

export interface EmailProcessingJobData {
  userId: string;
  emailId: string;
}

export const emailJobOptions = (userId: string, emailId: string, approval?: number) => ({
  // Stable idempotency identity based on (userId, emailId). A user-approved retry of a held
  // operation has its own identity per approval: the failed delivery still holds the email's
  // 5-minute slot, and approvals cannot race (compare-and-set) while held emails get no other jobs.
  singletonKey:
    approval === undefined ? `${userId}-${emailId}` : `${userId}-${emailId}-approved-${approval}`,
  singletonSeconds: 300,
  retryLimit: EMAIL_RETRY_LIMIT,
  retryDelay: 60,
  expireInSeconds: 300,
  retryBackoff: true,
});

/** Returns the queued job ID, or null when the singleton window suppressed a new job. */
export async function enqueueEmailProcessingJob(
  userId: string,
  emailId: string,
  approval?: number,
): Promise<string | null> {
  const queue = await getQueue();
  return queue.send(
    EMAIL_PROCESSING_JOB,
    { userId, emailId },
    emailJobOptions(userId, emailId, approval),
  );
}

export const RELEVANCE_TRIAGE_JOB = 'relevance-triage-job';

export interface RelevanceTriageJobData {
  userId: string;
}

export const relevanceTriageJobOptions = (userId: string) => ({
  singletonKey: `triage:${userId}`,
  startAfter: 10,
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
  expireInSeconds: 300,
});

export async function enqueueRelevanceTriage(userId: string): Promise<string | null> {
  return (await getQueue()).send(
    RELEVANCE_TRIAGE_JOB,
    { userId },
    relevanceTriageJobOptions(userId),
  );
}

export const AI_RESUME_JOB = 'ai-resume-job';
/** The job starts a moment after the pause ends, so the pause is surely over when it runs. */
const AI_RESUME_MARGIN_MS = 2_000;

export interface AiResumeJobData {
  userId: string;
}

export const aiResumeJobOptions = (userId: string, pauseEndsAt: Date) => ({
  // One job per user and end time: a job queued for a later end never holds back an earlier one.
  singletonKey: `resume:${userId}:${pauseEndsAt.toISOString()}`,
  startAfter: new Date(pauseEndsAt.getTime() + AI_RESUME_MARGIN_MS),
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
  expireInSeconds: 300,
});

/**
 * Queues the job that offers a user's waiting mail again when a pause ends. The queue keeps one
 * waiting job per user and end time: a second send for the same end returns null.
 */
export async function enqueueAiResume(userId: string, pauseEndsAt: Date): Promise<string | null> {
  return (await getQueue()).send(
    AI_RESUME_JOB,
    { userId },
    aiResumeJobOptions(userId, pauseEndsAt),
  );
}

export const NOTIFICATION_JOB = 'discord-notification-job';

export interface NotificationJobData {
  actionId: string;
}

export async function enqueueNotificationJob(actionId: string) {
  const queue = await getQueue();
  const jobId = `notify-discord-${actionId}`; // idempotency key

  await queue.send(
    NOTIFICATION_JOB,
    { actionId },
    {
      singletonKey: jobId,
      singletonSeconds: 300,
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
    },
  );
}

export const GMAIL_SYNC_JOB = 'gmail-sync-job';
export const GMAIL_SYNC_EXPIRE_SECONDS = 300;

export interface GmailSyncJobData {
  userId: string;
  claim: string;
  trigger?: 'manual' | 'scheduled';
}

/** Returns the queued job ID, or null when the queue did not accept the job. */
export async function enqueueGmailSync(data: GmailSyncJobData): Promise<string | null> {
  const queue = await getQueue();
  return queue.send(GMAIL_SYNC_JOB, data, {
    singletonKey: data.claim,
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: GMAIL_SYNC_EXPIRE_SECONDS,
  });
}

export const REPLY_READING_JOB = 'reply-reading-job';

export interface ReplyReadingJobData {
  userId: string;
  outgoingEmailId: string;
}

export const replyReadingJobOptions = (outgoingEmailId: string, startAfter?: Date) => ({
  // One job per sent message and start time: a later try never holds back an earlier one.
  singletonKey: `reply-read:${outgoingEmailId}${startAfter ? `:${startAfter.toISOString()}` : ''}`,
  ...(startAfter ? { startAfter } : {}),
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
  expireInSeconds: 300,
});

/** Reads the user's own reply now, or after a pause or the daily limit ends (`startAfter`). */
export async function enqueueReplyReading(
  userId: string,
  outgoingEmailId: string,
  startAfter?: Date,
): Promise<string | null> {
  return (await getQueue()).send(
    REPLY_READING_JOB,
    { userId, outgoingEmailId },
    replyReadingJobOptions(outgoingEmailId, startAfter),
  );
}
