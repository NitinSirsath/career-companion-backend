import { getQueue } from '../services/queue';
import { prisma } from '../db/prisma';
import { GmailFetcherService } from '../services/gmailFetcher';
import { AIProcessorStub } from '../services/aiProcessorStub';

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
      const email = await prisma.email.findFirst({
        where: { id: emailId, userId }
      });

      if (!email) {
        // Terminal failure: Email doesn't exist or isn't owned by this user
        console.warn(`Terminal failure: Email ${emailId} not found for user ${userId}`);
        return;
      }

      // Fetch secure bounded body
      const body = await GmailFetcherService.fetchMessageBody(userId, email.gmailMessageId);
      
      // Pass to AI pipeline (stubbed for now)
      await AIProcessorStub.processEmailBody(userId, emailId, body);

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
