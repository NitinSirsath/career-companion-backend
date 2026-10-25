import { GMAIL_SCHEDULE_QUEUE, setGmailScheduleRegistered } from './gmailSchedule';
import { PgBoss } from 'pg-boss';
import { databaseUrl } from '../utils/config';
import { errorCategory } from '../utils/errorCategory';
import { logError } from '../utils/log';

/** pg-boss keeps its jobs in this database schema. */
export const QUEUE_SCHEMA = 'pgboss';

export const QUEUE_NAMES = [
  'email-processing-job',
  'discord-notification-job',
  'gmail-sync-job',
  'relevance-triage-job',
  'ai-resume-job',
  'reply-reading-job',
] as const;

/**
 * Queues that limit jobs per singleton key. `stately`: one queued and one running.
 * `short`: one queued, so a job that is running can queue the next one.
 */
const QUEUE_POLICIES: Partial<Record<(typeof QUEUE_NAMES)[number], 'stately' | 'short'>> = {
  'relevance-triage-job': 'stately',
  'ai-resume-job': 'short',
};
let started: PgBoss | undefined;
export const getStartedQueue = () => started;

let starting: Promise<PgBoss> | undefined;

export function getQueue(): Promise<PgBoss> {
  if (!starting) {
    starting = (async () => {
      const boss = new PgBoss({ connectionString: databaseUrl(), schema: QUEUE_SCHEMA });
      boss.on('error', (error) => logError('queue_error', errorCategory(error)));
      try {
        await boss.start();
        for (const name of QUEUE_NAMES) {
          const policy = QUEUE_POLICIES[name];
          if (policy) await boss.createQueue(name, { policy });
          else await boss.createQueue(name);
        }
        await boss.createQueue(GMAIL_SCHEDULE_QUEUE);
        started = boss;
        return boss;
      } catch (error) {
        await boss.stop().catch(() => undefined);
        starting = undefined;
        started = undefined;
        throw error;
      }
    })();
  }
  return starting;
}

export async function stopQueue(): Promise<void> {
  setGmailScheduleRegistered(false);
  const current = starting;
  started = undefined;
  try {
    if (current) await (await current).stop();
  } finally {
    starting = undefined;
  }
}
