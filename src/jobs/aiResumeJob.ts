import { AI_RESUME_JOB, AiResumeJobData } from '../services/enqueue';
import { getQueue } from '../services/queue';
import { resumeWaitingEmails } from '../services/ai/offer';
import { logDebug } from '../utils/log';

export async function startAiResumeWorker() {
  const queue = await getQueue();
  await queue.work(AI_RESUME_JOB, async (jobs: { id: string; data: AiResumeJobData }[]) => {
    await resumeWaitingEmails(jobs[0].data.userId);
  });
  logDebug('worker_registered', { queue: AI_RESUME_JOB });
}
