import { getQueue } from '../services/queue';
import { prisma } from '../db/prisma';
import { EmailAIPipeline } from '../services/ai/pipeline';

export const EMAIL_PROCESSING_JOB = 'email-processing-job';

export interface EmailProcessingJobData {
  userId: string;
  emailId: string;
}

export async function enqueueEmailProcessingJob(userId: string, emailId: string) {
  const queue = await getQueue();
  // stable idempotency identity based on (userId, emailId)
  const jobId = `${userId}-${emailId}`;
  
  await queue.send(EMAIL_PROCESSING_JOB, { userId, emailId }, {
    singletonKey: jobId,
    retryLimit: 3,
    retryBackoff: true,
  });
}

export async function startEmailProcessingWorker() {
  const queue = await getQueue();

  await queue.work(EMAIL_PROCESSING_JOB, async (jobs: { id: string, data: EmailProcessingJobData }[]) => {
    const job = jobs[0];
    const { userId, emailId } = job.data;
    const startTime = Date.now();
    
    console.log(JSON.stringify({
      event: 'job_started',
      jobId: job.id,
      emailId,
      timestamp: new Date().toISOString()
    }));
    
    // Update processing state
    await prisma.email.updateMany({
      where: { id: emailId, userId },
      data: { processingState: 'PROCESSING' }
    });

    try {
      await EmailAIPipeline.processEmail(userId, emailId);

      const aiResult = await prisma.aIProcessingResult.findUnique({
        where: { emailId },
        select: { relevanceDecision: true }
      });

      let mappedRelevanceState = undefined;
      if (aiResult?.relevanceDecision === 'RELEVANT') mappedRelevanceState = 'RELEVANT';
      else if (aiResult?.relevanceDecision === 'IRRELEVANT') mappedRelevanceState = 'IRRELEVANT';
      else if (aiResult?.relevanceDecision === 'UNCERTAIN') mappedRelevanceState = 'RELEVANT';

      await prisma.email.updateMany({
        where: { id: emailId, userId },
        data: { 
          processingState: 'COMPLETED',
          ...(mappedRelevanceState ? { relevanceState: mappedRelevanceState as import('@prisma/client').EmailRelevanceState } : {})
        }
      });
      
      const durationMs = Date.now() - startTime;
      console.log(JSON.stringify({
        event: 'job_completed',
        jobId: job.id,
        emailId,
        durationMs,
        timestamp: new Date().toISOString()
      }));
    } catch (err) {
      await prisma.email.updateMany({
        where: { id: emailId, userId },
        data: { processingState: 'FAILED' }
      });
      
      const durationMs = Date.now() - startTime;
      const errorCategory = err instanceof Error ? err.name : 'UnknownError';
      console.error(JSON.stringify({
        event: 'job_failed',
        jobId: job.id,
        emailId,
        errorCategory,
        durationMs,
        timestamp: new Date().toISOString()
      }));
      // Rethrow to let pg-boss handle retry/dead-letter
      throw err;
    }
  });
}
