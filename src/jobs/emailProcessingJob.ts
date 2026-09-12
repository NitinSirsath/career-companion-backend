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

  await queue.work(EMAIL_PROCESSING_JOB, async (job: { data: EmailProcessingJobData }) => {
    const { userId, emailId } = job.data;
    
    // Update processing state
    await prisma.email.updateMany({
      where: { id: emailId, userId },
      data: { processingState: 'PROCESSING' }
    });

    try {
      await EmailAIPipeline.processEmail(userId, emailId);

      await prisma.email.updateMany({
        where: { id: emailId, userId },
        data: { processingState: 'COMPLETED' }
      });
    } catch (err) {
      await prisma.email.updateMany({
        where: { id: emailId, userId },
        data: { processingState: 'FAILED' }
      });
      // Rethrow to let pg-boss handle retry/dead-letter
      throw err;
    }
  });
}
