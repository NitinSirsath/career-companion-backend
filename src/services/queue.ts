/* eslint-disable @typescript-eslint/no-explicit-any */
import * as PgBossModule from 'pg-boss';

let boss: any = null;

export async function getQueue(): Promise<any> {
  if (!boss) {
    const PgBossClass = (PgBossModule as any).PgBoss || (PgBossModule as any).default || PgBossModule;
    boss = new PgBossClass({
      connectionString: process.env.DATABASE_URL,
      schema: 'pgboss',
    });

    boss.on('error', (error: any) => console.error('[pg-boss] error', error));

    await boss.start();
    
    // Ensure queues exist (idempotent)
    await boss.createQueue('email-processing-job');
    await boss.createQueue('discord-notification-job');
  }
  return boss;
}

export async function stopQueue(): Promise<void> {
  if (boss) {
    await boss.stop();
    boss = null;
  }
}
