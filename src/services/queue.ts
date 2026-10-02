import { PgBoss } from 'pg-boss';
import { errorCategory } from '../utils/errorCategory';

export const QUEUE_NAMES = [
  'email-processing-job',
  'discord-notification-job',
  'gmail-sync-job',
] as const;
let started: PgBoss | undefined;
export const getStartedQueue = () => started;

let starting: Promise<PgBoss> | undefined;

export function getQueue(): Promise<PgBoss> {
  if (!starting) {
    starting = (async () => {
      const boss = new PgBoss({ connectionString: process.env.DATABASE_URL, schema: 'pgboss' });
      boss.on('error', (error) =>
        console.error(JSON.stringify({ event: 'queue_error', ...errorCategory(error) })),
      );
      try {
        await boss.start();
        for (const name of QUEUE_NAMES) await boss.createQueue(name);
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
  const current = starting;
  started = undefined;
  try {
    if (current) await (await current).stop();
  } finally {
    starting = undefined;
  }
}
