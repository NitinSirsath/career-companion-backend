// Sprint 6 S6-05 fresh and additive-upgrade preservation lanes (runbook §4).
//
// FRESH_DATABASE_URL and UPGRADE_DATABASE_URL must name separate, EMPTY, local
// career_companion_*test databases created for this check. Every migration goes through
// scripts/guarded-migrate.cjs. Synthetic data only; this is not the preserved user dataset.
//
//   FRESH_DATABASE_URL=... UPGRADE_DATABASE_URL=... node scripts/verify-migration-preservation.cjs
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { assertTestDatabase } = require('../dist/utils/testDatabase');

const NEW_MIGRATION = '20261002090000_add_user_status_revision';
const backend = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-s6-migrate-'));

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
  SELECT (SELECT array_agg(tgname ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal) AS triggers,
         (SELECT array_agg(indexname ORDER BY indexname) FROM pg_indexes WHERE schemaname='public' AND indexdef LIKE 'CREATE UNIQUE%') AS uniques`)
  ).rows[0];

async function expectRejected(db, sql, params) {
  await db.query('SAVEPOINT probe');
  let rejected = false;
  try {
    await db.query(sql, params);
  } catch {
    rejected = true;
  }
  await db.query('ROLLBACK TO SAVEPOINT probe');
  return rejected;
}

async function freshLane(url) {
  const db = await connectEmpty(url);
  guardedMigrate(url);
  const user = (
    await db.query(
      `INSERT INTO users (id, email, "updatedAt") VALUES (gen_random_uuid(), 'fresh@lane.test', now()) RETURNING id`,
    )
  ).rows[0].id;
  const app = (
    await db.query(
      `INSERT INTO applications (id, "userId", "companyName", "updatedAt") VALUES (gen_random_uuid(), $1, 'Fresh', now()) RETURNING "userStatusRevision"`,
      [user],
    )
  ).rows[0];
  assert.equal(app.userStatusRevision, 0);
  const { triggers } = await integrity(db);
  for (const t of [
    'application_ownership',
    'email_ownership',
    'action_email_ownership',
    'event_email_ownership',
  ])
    assert(triggers.includes(t), `missing trigger ${t}`);
  const applied = (
    await db.query(
      `SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL`,
    )
  ).rows[0].n;
  await db.end();
  return { migrationsApplied: applied, newApplicationRevision: 0, ownershipTriggers: 4 };
}

const statuses = [
  'APPLIED',
  'RECRUITER_CONTACT',
  'ASSESSMENT',
  'INTERVIEW',
  'OFFER',
  'REJECTED',
  'CLOSED',
  null,
];

async function seedLegacy(db) {
  await db.query('BEGIN');
  const owners = [];
  for (let o = 0; o < 3; o++)
    owners.push(
      (
        await db.query(
          `INSERT INTO users (id, email, "updatedAt") VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
          [`legacy-${o}@lane.test`],
        )
      ).rows[0].id,
    );
  const apps = [];
  let i = 0;
  for (const owner of owners)
    for (const ai of statuses)
      for (const user of [null, 'OFFER', 'REJECTED']) {
        // Includes a user status whose confirmation time is unknown (legacy null timestamp).
        const setAt = user && i % 2 ? `2026-0${(i % 8) + 1}-15T10:00:00Z` : null;
        apps.push(
          (
            await db.query(
              `INSERT INTO applications (id, "userId", "companyName", "aiStatus", "userStatus", "userStatusSetAt", "createdAt", "updatedAt")
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now() - ($6 || ' minutes')::interval, now() - ($6 || ' minutes')::interval)
           RETURNING id, "userId"`,
              [owner, `Legacy ${i}`, ai, user, setAt, String(i)],
            )
          ).rows[0],
        );
        i++;
      }
  // ~1,620 synthetic emails across owners; every 10th linked to an owned application with
  // an event, an action and completed AI work (result + operation ledger).
  for (let e = 0; e < 1620; e++) {
    const owner = owners[e % owners.length];
    const ownedApps = apps.filter((a) => a.userId === owner);
    const linked = e % 10 === 0 ? ownedApps[e % ownedApps.length].id : null;
    const email = (
      await db.query(
        `INSERT INTO emails (id, "userId", "gmailMessageId", "threadId", subject, sender, "receivedAt", "relevanceState", "matchState", "matchConfirmedBy", "processingState", "applicationId", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'synthetic@lane.test', now() - ($5 || ' hours')::interval, $6, $7, $8, 'COMPLETED', $9, now()) RETURNING id`,
        [
          owner,
          `legacy-msg-${e}`,
          `thread-${e % 400}`,
          `Synthetic ${e}`,
          String(e),
          linked ? 'RELEVANT' : 'IRRELEVANT',
          linked ? 'MATCHED' : 'UNMATCHED',
          linked ? (e % 20 === 0 ? 'USER_CONFIRMED' : 'AI_AUTO') : null,
          linked,
        ],
      )
    ).rows[0].id;
    if (!linked) continue;
    await db.query(
      `INSERT INTO application_events (id, "applicationId", "emailId", type, "newState", description) VALUES (gen_random_uuid(), $1, $2, 'EMAIL_PROCESSED', 'INTERVIEW', 'synthetic')`,
      [linked, email],
    );
    await db.query(
      `INSERT INTO actions (id, "applicationId", "emailId", type, description, "updatedAt") VALUES (gen_random_uuid(), $1, $2, 'ACTION_REQUIRED', 'synthetic', now())`,
      [linked, email],
    );
    await db.query(
      `INSERT INTO ai_processing_results (id, "emailId", provider, model, "contractVersion", "processingStatus", "relevanceDecision", "updatedAt") VALUES (gen_random_uuid(), $1, 'fixture', 'fixture', 'extraction/v2', 'COMPLETED', 'RELEVANT', now())`,
      [email],
    );
    await db.query(
      `INSERT INTO ai_operations (id, "emailId", operation, version, status, attempts, result, "completedAt", "updatedAt") VALUES (gen_random_uuid(), $1, 'extraction', 'extraction/v2', 'COMPLETED', 1, '{"companyName":"Synthetic"}', now(), now())`,
      [email],
    );
  }
  await db.query('COMMIT');
}

const SNAPSHOT_TABLES = {
  users: 'SELECT * FROM users ORDER BY id',
  applications:
    'SELECT id, "userId", "companyName", "jobTitle", location, "aiStatus", "userStatus", "userStatusSetAt", "appliedAt", "createdAt", "updatedAt" FROM applications ORDER BY id',
  emails: 'SELECT * FROM emails ORDER BY id',
  events: 'SELECT * FROM application_events ORDER BY id',
  actions: 'SELECT * FROM actions ORDER BY id',
  aiResults: 'SELECT * FROM ai_processing_results ORDER BY id',
  aiOperations: 'SELECT * FROM ai_operations ORDER BY id',
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
  // Pre-Sprint-6 schema: every existing migration except the new additive one.
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
  const column = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='applications' AND column_name='userStatusRevision'`,
  );
  assert.equal(column.rowCount, 0, 'legacy lane must not have the new column yet');

  await seedLegacy(db);
  const before = await snapshot(db);
  const beforeIntegrity = await integrity(db);
  guardedMigrate(url); // apply the candidate's additive migration through the guard
  const after = await snapshot(db);
  const afterIntegrity = await integrity(db);
  assert.deepEqual(after, before, 'existing rows/fields changed during the upgrade');
  assert.deepEqual(
    afterIntegrity,
    beforeIntegrity,
    'constraints/triggers changed during the upgrade',
  );
  const revisions = (
    await db.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE "userStatusRevision" <> 0)::int AS nonzero,
    count(*) FILTER (WHERE "userStatus" IS NOT NULL AND "userStatusSetAt" IS NULL)::int AS unknownTime FROM applications`)
  ).rows[0];
  assert.equal(revisions.nonzero, 0);
  assert(revisions.unknowntime > 0, 'fixture must include legacy unknown confirmation times');

  // Ownership protections still reject cross-owner links and duplicate per-email effects.
  await db.query('BEGIN');
  const [a, b] = (
    await db.query(`SELECT a.id, a."userId" FROM applications a ORDER BY a."userId", a.id`)
  ).rows.filter((r, idx, all) => idx === 0 || r.userId !== all[0].userId);
  const foreignEmail = (
    await db.query(`SELECT id FROM emails WHERE "userId" = $1 LIMIT 1`, [b.userId])
  ).rows[0].id;
  const crossOwner = await expectRejected(
    db,
    `UPDATE emails SET "applicationId" = $1 WHERE id = $2`,
    [a.id, foreignEmail],
  );
  const dupe = (await db.query(`SELECT "applicationId", "emailId" FROM application_events LIMIT 1`))
    .rows[0];
  const duplicate = await expectRejected(
    db,
    `INSERT INTO application_events (id, "applicationId", "emailId", type) VALUES (gen_random_uuid(), $1, $2, 'EMAIL_PROCESSED')`,
    [dupe.applicationId, dupe.emailId],
  );
  const ownerChange = await expectRejected(
    db,
    `UPDATE applications SET "userId" = $1 WHERE id = $2`,
    [b.userId, a.id],
  );
  await db.query('ROLLBACK');
  assert(crossOwner && duplicate && ownerChange, 'ownership/uniqueness protections weakened');
  await db.end();
  return {
    syntheticRows: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.count])),
    unchangedTables: Object.keys(before).length,
    applicationsAtRevisionZero: revisions.n,
    legacyUnknownConfirmationTimes: revisions.unknowntime,
    triggersAndUniqueIndexesUnchanged: true,
    crossOwnerRejected: crossOwner,
    duplicateEffectRejected: duplicate,
    ownerChangeRejected: ownerChange,
  };
}

(async () => {
  const fresh = process.env.FRESH_DATABASE_URL;
  const upgrade = process.env.UPGRADE_DATABASE_URL;
  if (!fresh || !upgrade || fresh === upgrade)
    throw new Error('Set separate FRESH_DATABASE_URL and UPGRADE_DATABASE_URL');
  const result = { fresh: await freshLane(fresh), upgrade: await upgradeLane(upgrade) };
  console.log(JSON.stringify({ event: 'migration_preservation_verified', ...result }, null, 2));
})()
  .catch((err) => {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(work, { recursive: true, force: true }));
