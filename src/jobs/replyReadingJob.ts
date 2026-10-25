import { enqueueReplyReading, REPLY_READING_JOB, ReplyReadingJobData } from '../services/enqueue';
import { getQueue } from '../services/queue';
import { readSentReply } from '../services/replyReading';
import { logDebug } from '../utils/log';

/** Reads the user's own replies; a read that must wait is queued again for when it may work. */
export async function startReplyReadingWorker() {
  const queue = await getQueue();
  await queue.work(REPLY_READING_JOB, async (jobs: { id: string; data: ReplyReadingJobData }[]) => {
    const { userId, outgoingEmailId } = jobs[0].data;
    const next = await readSentReply(userId, outgoingEmailId);
    if (next) await enqueueReplyReading(userId, outgoingEmailId, next);
  });
  logDebug('worker_registered', { queue: REPLY_READING_JOB });
}
