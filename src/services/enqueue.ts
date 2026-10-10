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
