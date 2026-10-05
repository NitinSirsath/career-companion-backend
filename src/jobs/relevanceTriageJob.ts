import type { JobWithMetadata } from 'pg-boss';
import { getQueue } from '../services/queue';
import { runTriage } from '../services/ai/triage';

export const RELEVANCE_TRIAGE_JOB = 'relevance-triage-job';
export interface RelevanceTriageJobData { userId: string; }

export const relevanceTriageJobOptions = (userId: string) => ({
  singletonKey: `triage:${userId}`,
  startAfter: 10,
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
  expireInSeconds: 300,
});

export async function enqueueRelevanceTriage(userId: string): Promise<string | null> {
  return (await getQueue()).send(RELEVANCE_TRIAGE_JOB, { userId }, relevanceTriageJobOptions(userId));
}

export const RELEVANCE_TRIAGE_WORKER_OPTIONS = { includeMetadata: true, batchSize: 1 } as const;
export async function handleRelevanceTriageJobs(jobs: JobWithMetadata<RelevanceTriageJobData>[]) {
  if (jobs.length !== 1) throw new Error('UNEXPECTED_RELEVANCE_TRIAGE_JOB_BATCH');
  await runTriage(jobs[0].data.userId, jobs[0].signal);
}
export async function startRelevanceTriageWorker() {
  await (await getQueue()).work(RELEVANCE_TRIAGE_JOB, RELEVANCE_TRIAGE_WORKER_OPTIONS, handleRelevanceTriageJobs);
}
