import { getQueue } from '../services/queue';
import { prisma } from '../db/prisma';
import { TerminalAIError } from '../services/ai/errors';
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

  await queue.send(
    EMAIL_PROCESSING_JOB,
    { userId, emailId },
    {
      singletonKey: jobId,
      singletonSeconds: 300,
      retryLimit: 3,
      retryDelay: 60,
      expireInSeconds: 300,
      retryBackoff: true,
    },
  );
}

export async function startEmailProcessingWorker() {
  const queue = await getQueue();

  await queue.work(
    EMAIL_PROCESSING_JOB,
    async (jobs: { id: string; data: EmailProcessingJobData }[]) => {
      const job = jobs[0];
      const { userId, emailId } = job.data;
      const startTime = Date.now();

      console.log(
        JSON.stringify({
          event: 'job_started',
          jobId: job.id,
          emailId,
          timestamp: new Date().toISOString(),
        }),
      );

      try {
        await prisma.email.updateMany({
          where: { id: emailId, userId, processingState: { not: 'COMPLETED' } },
          data: { processingState: 'PROCESSING' },
        });
        await EmailAIPipeline.processEmail(userId, emailId);

        const durationMs = Date.now() - startTime;
        console.log(
          JSON.stringify({
            event: 'job_completed',
            jobId: job.id,
            emailId,
            durationMs,
            timestamp: new Date().toISOString(),
          }),
        );
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const errorCategory = err instanceof Error ? err.name : 'UnknownError';
        const errorDetails = err instanceof Error ? err.message : String(err);
        let errorStage = null;
        let isRetryable = !(err instanceof TerminalAIError);

        // Assuming AIProviderError might have operationStage. Need to cast to any since AIProviderError isn't imported here, 
        // or we can just access it if it exists.
        if (err && typeof err === 'object' && 'operationStage' in err) {
          errorStage = (err as any).operationStage;
        }

        const isTerminal = err instanceof TerminalAIError;

        await prisma.email.updateMany({
          where: { id: emailId, userId, processingState: { not: 'COMPLETED' } },
          data: {
            processingState: isTerminal ? 'FAILED' : 'PROCESSING',
            processingErrorCategory: errorCategory,
            processingErrorDetails: errorDetails,
            processingErrorStage: errorStage,
            processingRetryable: isRetryable,
            processingFailedAt: new Date(),
          },
        });

        console.error(
          JSON.stringify({
            event: 'job_failed',
            jobId: job.id,
            emailId,
            errorCategory,
            errorStage,
            durationMs,
            timestamp: new Date().toISOString(),
          }),
        );
        // Rethrow to let pg-boss handle retry/dead-letter
        if (!isTerminal) throw err;
      }
    },
  );
}
