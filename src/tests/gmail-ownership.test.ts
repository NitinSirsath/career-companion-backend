import { afterAll, beforeAll, expect, it } from 'vitest';
import { Client } from 'pg';
import { prisma } from '../db/prisma';
import { acquireSync, withOwnedSync } from '../services/gmailSyncOwnership';
let userId: string;
beforeAll(async () => {
  userId = (await prisma.user.create({ data: { email: 'ownership@fixture.test' } })).id;
  await prisma.gmailConnection.create({
    data: {
      userId,
      gmailEmail: 'ownership@fixture.test',
      status: 'CONNECTED',
      accessToken: 'fixture',
    },
  });
});
afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } });
});
it('bounds a real row-lock wait and preserves the checkpoint', async () => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM gmail_connections WHERE "userId"=$1 FOR UPDATE', [userId]);
    const started = Date.now();
    const result = acquireSync(userId, undefined, 'direct:fixture').then(
      () => null,
      (error) => error,
    );
    let blocked = false;
    for (let i = 0; i < 30 && !blocked; i++) {
      const rows = await client.query(
        'SELECT pid FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0 AND datname=current_database()',
      );
      blocked = rows.rowCount! > 0;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(blocked).toBe(true);
    expect(await result).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(6000);
    await client.query('ROLLBACK');
    expect(
      (await prisma.gmailConnection.findUniqueOrThrow({ where: { userId } })).lastHistoryId,
    ).toBeNull();
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
it('rejects a stale owner before its transaction callback can mutate data', async () => {
  const first = await acquireSync(userId, undefined, 'direct:one');
  await prisma.gmailConnection.update({ where: { userId }, data: { syncLeaseUntil: new Date(0) } });
  await acquireSync(userId, undefined, 'direct:two');
  let called = false;
  await expect(
    withOwnedSync(userId, first.connection.id, 'direct:one', async () => {
      called = true;
    }),
  ).rejects.toThrow('superseded');
  expect(called).toBe(false);
});
