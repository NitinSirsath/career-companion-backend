import { PgBoss } from 'pg-boss';

let starting: Promise<PgBoss> | undefined;

export function getQueue(): Promise<PgBoss> {
  if (!starting) {
    starting = (async () => {
      const boss = new PgBoss({ connectionString: process.env.DATABASE_URL, schema: 'pgboss' });
      boss.on('error', () => console.error(JSON.stringify({ event: 'queue_error' })));
      try {
        await boss.start();
        for (const name of ['email-processing-job', 'discord-notification-job', 'gmail-sync-job'])
          await boss.createQueue(name);
        return boss;
      } catch (error) {
        await boss.stop().catch(() => undefined);
        starting = undefined;
        throw error;
      }
    })();
  }
  return starting;
}

export async function stopQueue(): Promise<void> {
  const current = starting;
  if (current) await (await current).stop();
  starting = undefined;
}
