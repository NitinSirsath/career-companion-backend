// BYO AI (AI-05) fresh and additive-upgrade preservation lanes for the user-provided AI migration.
//
// FRESH_DATABASE_URL and UPGRADE_DATABASE_URL must name separate, EMPTY, local
// career_companion_*test databases created for this check. Every migration goes through
// scripts/guarded-migrate.cjs. Synthetic data only.
//
//   npm run build && FRESH_DATABASE_URL=... UPGRADE_DATABASE_URL=... node scripts/verify-ai-migration.cjs
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { assertTestDatabase } = require('../dist/utils/testDatabase');

const NEW_MIGRATION = '20261002120000_user_provided_ai';
const NEW_UNIQUES = ['ai_configurations_pkey', 'ai_usage_days_pkey'];
const backend = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ai-migrate-'));

function guardedMigrate(url, extraArgs = []) {
  const envFile = path.join(work, `${nodeCrypto.randomUUID()}.env`);
  fs.writeFileSync(envFile, `DATABASE_URL="${url}"\nTEST_DATABASE_URL="${url}"\n`, { mode: 0o600 });
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'guarded-migrate.cjs'), 'migrate', 'deploy', ...extraArgs],
    {
      cwd: backend,
      env: { ...process.env, TEST_ENV_FILE: envFile, TEST_DATABASE_URL: url },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0)
    throw new Error(`guarded migrate failed: ${result.stderr || result.stdout}`);
}

async function connectEmpty(url) {
  assertTestDatabase(url, url);
  const db = new Client({ connectionString: url });
  await db.connect();
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`,
  );
  if (rows[0].n)
    throw new Error(`${new URL(url).pathname.slice(1)} is not empty; refusing to use it`);
  return db;
}

const integrity = async (db) =>
  (
    await db.query(`
  SELECT (SELECT array_agg(tgname::text ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal) AS triggers,
         (SELECT array_agg(indexname::text ORDER BY indexname) FROM pg_indexes WHERE schemaname='public' AND indexdef LIKE 'CREATE UNIQUE%') AS uniques`)
  ).rows[0];

async function rejected(db, sql, params) {
  await db.query('SAVEPOINT probe');
  let failed = false;
  try {
    await db.query(sql, params);
  } catch {
    failed = true;
  }
  await db.query('ROLLBACK TO SAVEPOINT probe');
  return failed;
}

async function freshLane(url) {
  const db = await connectEmpty(url);
  guardedMigrate(url);
  const user = (
    await db.query(
      `INSERT INTO users (id, email, "updatedAt") VALUES (gen_random_uuid(), 'fresh@ai-lane.test', now()) RETURNING id`,
    )
  ).rows[0].id;
  const insert = `INSERT INTO ai_configurations ("userId", provider, "encryptedApiKey", "consentDisclosure", "consentedAt", "updatedAt") VALUES ($1, 'gemini', $2, 'gemini-draft-2026-10', now(), now())`;
  await db.query('BEGIN');
  const plaintextRejected = await rejected(db, insert, [user, 'sk-plaintext']);
  await db.query(insert, [user, 'v1:aXY=:Y3Q=']);
  const secondRejected = await rejected(db, insert, [user, 'v1:aXY=:Y3Q=']);
  await db.query('ROLLBACK');
  assert(plaintextRejected, 'an unsealed key must be rejected');
  assert(secondRejected, 'a second configuration for the same user must be rejected');
  const { uniques } = await integrity(db);
  for (const name of NEW_UNIQUES) assert(uniques.includes(name), `missing ${name}`);
  await db.end();
  return { unsealedKeyRejected: true, oneConfigurationPerUser: true };
}

async function seedLegacy(db) {
  await db.query('BEGIN');
  const owners = [];
  for (let o = 0; o < 3; o++)
    owners.push(
      (
        await db.query(
          `INSERT INTO users (id, email, "updatedAt") VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
          [`legacy-${o}@ai-lane.test`],
        )
      ).rows[0].id,
    );
  for (let e = 0; e < 600; e++) {
    const owner = owners[e % owners.length];
    const email = (
      await db.query(
        `INSERT INTO emails (id, "userId", "gmailMessageId", subject, sender, "processingState", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, 'synthetic@ai-lane.test', $4, now()) RETURNING id`,
        [owner, `legacy-msg-${e}`, `Synthetic ${e}`, e % 5 === 0 ? 'PENDING' : 'COMPLETED'],
      )
    ).rows[0].id;
    // Mix of claimed (attempts > 0) and never-claimed ledger rows in every status.
    const status = ['COMPLETED', 'UNKNOWN', 'FAILED', 'RETRYABLE', 'PENDING', 'PROCESSING'][e % 6];
    const attempts = status === 'PENDING' ? 0 : (e % 3) + 1;
    await db.query(
      `INSERT INTO ai_operations (id, "emailId", operation, version, status, attempts, result, "errorCode", "updatedAt")
       VALUES (gen_random_uuid(), $1, 'classification', 'classification/v2', $2, $3, $4, $5, now())`,
      [
        email,
        status,
        attempts,
        status === 'COMPLETED' ? '{"decision":"IRRELEVANT"}' : null,
        status === 'FAILED' ? 'SchemaValidationFailure' : null,
      ],
    );
    if (status === 'COMPLETED')
      await db.query(
        `INSERT INTO ai_processing_results (id, "emailId", provider, model, "contractVersion", "processingStatus", "relevanceDecision", "updatedAt") VALUES (gen_random_uuid(), $1, 'gemini', 'gemini-2.5-flash-lite', 'classification/v2', 'COMPLETED', 'IRRELEVANT', now())`,
        [email],
      );
  }
  await db.query(
    `INSERT INTO ai_call_budgets (day, calls, "cooldownUntil") VALUES ('2026-10-01', 42, now())`,
  );
  await db.query('COMMIT');
}

const SNAPSHOT_TABLES = {
  users: 'SELECT * FROM users ORDER BY id',
  emails: 'SELECT * FROM emails ORDER BY id',
  aiResults: 'SELECT * FROM ai_processing_results ORDER BY id',
  // Pre-existing columns only; the new columns are checked separately.
  aiOperations:
    'SELECT id, "emailId", operation, version, status, attempts, result, "errorCode", "retryAfter", "startedAt", "completedAt", "createdAt", "updatedAt" FROM ai_operations ORDER BY id',
  aiCallBudgets: 'SELECT * FROM ai_call_budgets ORDER BY day',
};
async function snapshot(db) {
  const out = {};
  for (const [name, sql] of Object.entries(SNAPSHOT_TABLES)) {
    const { rows } = await db.query(sql);
    out[name] = {
      count: rows.length,
      digest: nodeCrypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    };
  }
  return out;
}

async function upgradeLane(url) {
  const db = await connectEmpty(url);
  const legacy = path.join(work, 'prisma-legacy');
  fs.mkdirSync(path.join(legacy, 'migrations'), { recursive: true });
  fs.copyFileSync(path.join(backend, 'prisma/schema.prisma'), path.join(legacy, 'schema.prisma'));
  for (const entry of fs.readdirSync(path.join(backend, 'prisma/migrations')))
    if (entry !== NEW_MIGRATION)
      fs.cpSync(
        path.join(backend, 'prisma/migrations', entry),
        path.join(legacy, 'migrations', entry),
        { recursive: true },
      );
  guardedMigrate(url, ['--schema', path.join(legacy, 'schema.prisma')]);
  assert.equal(
    (await db.query(`SELECT to_regclass('ai_configurations') AS t`)).rows[0].t,
    null,
    'legacy lane must not have the new tables',
  );

  await seedLegacy(db);
  const before = await snapshot(db);
  const beforeIntegrity = await integrity(db);
  guardedMigrate(url);
  const after = await snapshot(db);
  const afterIntegrity = await integrity(db);
  assert.deepEqual(after, before, 'existing rows or columns changed during the upgrade');
  assert.deepEqual(afterIntegrity.triggers, beforeIntegrity.triggers, 'triggers changed');
  assert.deepEqual(
    afterIntegrity.uniques.filter((u) => !NEW_UNIQUES.includes(u)),
    beforeIntegrity.uniques,
    'unique indexes changed',
  );

  const ledger = (
    await db.query(`SELECT
      count(*)::int AS n,
      count(*) FILTER (WHERE attempts > 0 AND provider = 'gemini')::int AS backfilled,
      count(*) FILTER (WHERE attempts = 0 AND provider IS NULL)::int AS unclaimed,
      count(*) FILTER (WHERE model IS NOT NULL OR "approvedRetries" <> 0)::int AS unexpected
    FROM ai_operations`)
  ).rows[0];
  assert.equal(
    ledger.backfilled + ledger.unclaimed,
    ledger.n,
    'provider backfill must cover exactly the claimed rows',
  );
  assert(
    ledger.unclaimed > 0 && ledger.backfilled > 0,
    'fixture must include claimed and unclaimed rows',
  );
  assert.equal(ledger.unexpected, 0);
  await db.end();
  return {
    syntheticRows: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.count])),
    unchangedTables: Object.keys(before).length,
    ledgerRowsBackfilledGemini: ledger.backfilled,
    ledgerRowsNeverClaimed: ledger.unclaimed,
    triggersAndUniqueIndexesUnchanged: true,
  };
}

(async () => {
  const fresh = process.env.FRESH_DATABASE_URL;
  const upgrade = process.env.UPGRADE_DATABASE_URL;
  if (!fresh || !upgrade || fresh === upgrade)
    throw new Error('Set separate FRESH_DATABASE_URL and UPGRADE_DATABASE_URL');
  const result = { fresh: await freshLane(fresh), upgrade: await upgradeLane(upgrade) };
  console.log(JSON.stringify({ event: 'ai_migration_preservation_verified', ...result }, null, 2));
})()
  .catch((err) => {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(work, { recursive: true, force: true });
    process.exit(); // a failed assertion can leave a lane connection open
  });
