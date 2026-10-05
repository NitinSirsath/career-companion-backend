// Real pg-boss retry after SIGKILL. Only a dedicated empty local *_crash_test database is accepted.
const { config } = require('dotenv');
const { fork, spawnSync } = require('node:child_process');
const { Client } = require('pg');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const expected = process.env.TEST_DATABASE_URL;
config({ path: '.env.crash.test', override: true, quiet: true });
require('../dist/utils/testDatabase').assertTestDatabase(process.env.DATABASE_URL, expected);
assert.equal(process.env.TEST_DATABASE_URL, expected);
assert.match(new URL(expected).pathname, /_crash_test$/);
process.env.NODE_ENV = 'test';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function worker() {
  const { google } = require('googleapis');
  google.gmail = () => ({
    users: {
      getProfile: async () => ({ data: { historyId: 'fixture-checkpoint' } }),
      history: { list: async () => ({ data: { historyId: 'fixture-checkpoint', history: [] } }) },
      messages: {
        list: async () => {
          if (process.argv.includes('--crash')) {
            process.send({ gate: true });
            await new Promise(() => {});
          }
          return { data: { messages: [{ id: 'fixture-message' }] } };
        },
        get: async () => ({
          data: { labelIds: ['INBOX'], internalDate: String(Date.now()), payload: { headers: [] } },
        }),
      },
    },
  });
  require('../dist/jobs/emailProcessingJob').enqueueEmailProcessingJob = async () =>
    'fixture-email-job';
  const queue = require('../dist/services/queue');
  process.on('SIGTERM', async () => {
    await queue.stopQueue();
    await require('../dist/db/prisma').prisma.$disconnect();
    process.exit(0);
  });
  await require('../dist/jobs/gmailSyncJob').startGmailSyncWorker();
}
async function main() {
  const db = new Client({ connectionString: expected });
  await db.connect();
  assert.equal(
    (await db.query('SELECT pg_try_advisory_lock(707070) AS locked')).rows[0].locked,
    true,
  );
  // Refuse a previously populated application or queue before making any changes.
  const tables = (
    await db.query("SELECT to_regclass('public.users') AS users, to_regclass('pgboss.job') AS jobs")
  ).rows[0];
  if (tables.users)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);
  if (tables.jobs)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM pgboss.job')).rows[0].n, 0);
  const migrate = spawnSync(
    process.execPath,
    [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
    { env: process.env, stdio: 'pipe' },
  );
  assert.equal(migrate.status, 0, 'Crash fixture migration failed');
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY = nodeCrypto.randomBytes(32).toString('hex');
  const { prisma } = require('../dist/db/prisma');
  const { encryptToken } = require('../dist/utils/gmailTokenEncryption');
  const { getQueue, stopQueue } = require('../dist/services/queue');
  const { requestGmailSync } = require('../dist/jobs/gmailSyncJob');
  let user;
  let child;
  let quarantine = false;
  const events = [];
  async function stop(signal) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal);
    try {
      await until(() => child.exitCode !== null || child.signalCode !== null, 'child exit');
    } catch (error) {
      quarantine = true;
      throw error;
    }
  }
  function launch(crash) {
    child = fork(__filename, ['--worker', ...(crash ? ['--crash'] : [])], {
      env: process.env,
      silent: true,
    });
    let buffer = '';
    child.stdout.on('data', (data) => {
      buffer += data;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.event?.startsWith('gmail_sync_')) events.push(event);
        } catch {
          /* non-event startup output */
        }
      }
    });
    child.stderr.resume();
    return child;
  }
  try {
    const boss = await getQueue();
    user = await prisma.user.create({
      data: { email: `crash-${nodeCrypto.randomUUID()}@fixture.test` },
    });
    await prisma.gmailConnection.create({
      data: {
        userId: user.id,
        gmailEmail: user.email,
        status: 'CONNECTED',
        accessToken: encryptToken('fixture-token'),
      },
    });
    await requestGmailSync(user.id);
    const job = (
      await db.query(
        "SELECT id, data FROM pgboss.job WHERE name='gmail-sync-job' AND data->>'userId'=$1",
        [user.id],
      )
    ).rows[0];
    let gated = false;
    launch(true).on('message', (value) => {
      if (value.gate) gated = true;
    });
    await until(() => gated, 'worker acquired request');
    await stop('SIGKILL');
    assert.equal(child.signalCode, 'SIGKILL');
    await db.query(
      "UPDATE pgboss.job SET started_on=now()-interval '10 minutes' WHERE id=$1 AND name='gmail-sync-job' AND data->>'userId'=$2",
      [job.id, user.id],
    );
    await prisma.gmailConnection.update({
      where: { userId: user.id },
      data: { syncLeaseUntil: new Date(0) },
    });
    // supervise() expires jobs only when the queue's monitor gate is older than
    // monitorIntervalSeconds (60 s by default), and that gate lives in pgboss.queue, which
    // cleanup keeps. Move it back like started_on above, so a second run within a minute
    // still exercises expiry.
    await db.query(
      "UPDATE pgboss.queue SET monitor_on=now()-interval '10 minutes', monitor_claim_on=now()-interval '10 minutes' WHERE name='gmail-sync-job'",
    );
    await boss.supervise('gmail-sync-job');
    assert.equal(
      (await db.query('SELECT state FROM pgboss.job WHERE id=$1', [job.id])).rows[0].state,
      'retry',
    );
    await db.query(
      "UPDATE pgboss.job SET start_after=now()-interval '1 second' WHERE id=$1 AND name='gmail-sync-job' AND data->>'userId'=$2",
      [job.id, user.id],
    );
    launch(false);
    await until(
      async () =>
        (await db.query('SELECT state FROM pgboss.job WHERE id=$1', [job.id])).rows[0]?.state ===
        'completed',
      'same job completes after retry',
    );
    const retry = (await db.query('SELECT retry_count, data FROM pgboss.job WHERE id=$1', [job.id]))
      .rows[0];
    assert.equal(retry.retry_count, 1);
    assert.equal(retry.data.claim, job.data.claim);
    assert.equal(
      events.filter((e) => e.event === 'gmail_sync_started' && e.jobId === job.id).length,
      2,
    );
    assert.equal(
      events.filter((e) => e.event === 'gmail_sync_completed' && e.jobId === job.id).length,
      1,
    );
    assert.equal(
      (await prisma.gmailConnection.findUniqueOrThrow({ where: { userId: user.id } }))
        .lastHistoryId,
      'fixture-checkpoint',
    );
    assert.equal(await prisma.email.count({ where: { userId: user.id } }), 1);
    await requestGmailSync(user.id);
    await until(
      async () =>
        (await prisma.gmailConnection.findUniqueOrThrow({ where: { userId: user.id } }))
          .syncStatus === 'IDLE',
      'repeat request',
    );
    assert.equal(await prisma.email.count({ where: { userId: user.id } }), 1);
    console.log('PASS: SIGKILL, same-job retry, fenced checkpoint, no duplicate mail');
  } finally {
    await stop('SIGTERM');
    await stopQueue();
    if (!quarantine && user) {
      await db.query("DELETE FROM pgboss.job WHERE data->>'userId'=$1", [user.id]);
      await prisma.user.delete({ where: { id: user.id } });
      assert.equal((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM pgboss.job')).rows[0].n, 0);
      console.log('PASS: fixture residue = 0');
    }
    await prisma.$disconnect();
    await db.end();
  }
}
(process.argv.includes('--worker') ? worker() : main()).catch((error) => {
  console.error(
    'Crash fixture failed; inspect the dedicated database before reuse.',
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
