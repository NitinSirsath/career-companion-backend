/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const PgBoss = require('pg-boss');

let boss: any = null;

export async function getQueue(): Promise<any> {
  if (!boss) {
    boss = new PgBoss({
      connectionString: process.env.DATABASE_URL,
      schema: 'pgboss',
    });

    boss.on('error', (error: any) => console.error('[pg-boss] error', error));

    await boss.start();
  }
  return boss;
}

export async function stopQueue(): Promise<void> {
  if (boss) {
    await boss.stop();
    boss = null;
  }
}
