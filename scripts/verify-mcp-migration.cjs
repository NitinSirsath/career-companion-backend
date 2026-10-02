// MCP feature (MCP-01) fresh and additive-upgrade preservation lanes for the automation
// submissions migration (ADR-0002).
//
// FRESH_DATABASE_URL and UPGRADE_DATABASE_URL must name separate, EMPTY, local
// career_companion_*test databases created for this check. Every migration goes through
// scripts/guarded-migrate.cjs. Synthetic data only.
//
//   npm run build && FRESH_DATABASE_URL=... UPGRADE_DATABASE_URL=... node scripts/verify-mcp-migration.cjs
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { assertTestDatabase } = require('../dist/utils/testDatabase');

const NEW_MIGRATION = '20261002150000_automation_submissions';
const NEW_UNIQUES = [
  'application_events_externalSubmissionId_key',
  'external_submissions_pkey',
  'external_submissions_userId_source_sourceRecordRef_key',
  'integration_tokens_pkey',
  'integration_tokens_tokenHash_key',
];
const NEW_TRIGGERS = ['event_submission_ownership', 'integration_token_ownership', 'submission_ownership'];
const backend = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mcp-migrate-'));

function guardedMigrate(url, extraArgs = []) {
  const envFile = path.join(work, `${nodeCrypto.randomUUID()}.env`);
  fs.writeFileSync(envFile, `DATABASE_URL="${url}"\nTEST_DATABASE_URL="${url}"\n`, { mode: 0o600 });
  const result = spawnSync(process.execPath, [path.join(__dirname, 'guarded-migrate.cjs'), 'migrate', 'deploy', ...extraArgs], {
    cwd: backend, env: { ...process.env, TEST_ENV_FILE: envFile, TEST_DATABASE_URL: url }, encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`guarded migrate failed: ${result.stderr || result.stdout}`);
}

async function connectEmpty(url) {
  assertTestDatabase(url, url);
  const db = new Client({ connectionString: url });
  await db.connect();
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`);
  if (rows[0].n) throw new Error(`${new URL(url).pathname.slice(1)} is not empty; refusing to use it`);
  return db;
}

const integrity = async (db) => (await db.query(`
  SELECT (SELECT array_agg(tgname::text ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal) AS triggers,
         (SELECT array_agg(indexname::text ORDER BY indexname) FROM pg_indexes WHERE schemaname='public' AND indexdef LIKE 'CREATE UNIQUE%') AS uniques`)).rows[0];

async function rejected(db, sql, params) {
  await db.query('SAVEPOINT probe');
  let failed = false;
  try { await db.query(sql, params); } catch { failed = true; }
  await db.query('ROLLBACK TO SAVEPOINT probe');
  return failed;
}

const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const newUser = (db, email) => one(db, `INSERT INTO users (id, email, "updatedAt") VALUES (gen_random_uuid(), $1, now()) RETURNING id`, [email]).then((r) => r.id);
const newApp = (db, user, company) => one(db, `INSERT INTO applications (id, "userId", "companyName", "updatedAt") VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`, [user, company]).then((r) => r.id);
const newToken = (db, user) => one(db,
  `INSERT INTO integration_tokens (id, "userId", name, "tokenHash", "displayPrefix", "expiresAt")
   VALUES (gen_random_uuid(), $1, 'laptop', $2, 'ccmcp_abcdef', now() + interval '90 days') RETURNING id`,
  [user, nodeCrypto.randomBytes(32).toString('hex')]).then((r) => r.id);
const SUBMISSION = `INSERT INTO external_submissions (id, "userId", source, "sourceRecordRef", platform, company, "jobTitle", "submittedAt", "tokenId", "matchState", "resolvedBy", "applicationId", "resolvedAt")
  VALUES (gen_random_uuid(), $1, 'AUTOMATION', $2, 'linkedin', 'Acme', 'Engineer', now(), $3, $4, $5, $6, $7) RETURNING id`;
const newSubmission = (db, user, ref, { token = null, state = 'NEEDS_REVIEW', app = null } = {}) =>
  one(db, SUBMISSION, [user, ref, token, state, state === 'NEEDS_REVIEW' ? null : 'AUTOMATIC', app, state === 'NEEDS_REVIEW' ? null : new Date()]).then((r) => r.id);

async function freshLane(url) {
  const db = await connectEmpty(url);
  guardedMigrate(url);
  const { triggers, uniques } = await integrity(db);
  for (const name of NEW_UNIQUES) assert(uniques.includes(name), `missing ${name}`);
  for (const name of NEW_TRIGGERS) assert(triggers.includes(name), `missing trigger ${name}`);

  await db.query('BEGIN');
  const [alice, bob] = [await newUser(db, 'alice@mcp-lane.test'), await newUser(db, 'bob@mcp-lane.test')];
  const [aliceApp, bobApp] = [await newApp(db, alice, 'Acme'), await newApp(db, bob, 'Acme')];
  const [aliceToken, bobToken] = [await newToken(db, alice), await newToken(db, bob)];
  const sub = await newSubmission(db, alice, '2026-10-02/09:00:00', { token: aliceToken, state: 'LINKED', app: aliceApp });
  const checks = {
    foreignApplicationRejected: await rejected(db, SUBMISSION, [alice, '2026-10-02/09:00:01', null, 'LINKED', 'AUTOMATIC', bobApp, new Date()]),
    foreignTokenRejected: await rejected(db, SUBMISSION, [alice, '2026-10-02/09:00:02', bobToken, 'NEEDS_REVIEW', null, null, null]),
    linkToForeignApplicationRejected: await rejected(db, `UPDATE external_submissions SET "applicationId"=$2 WHERE id=$1`, [sub, bobApp]),
    ownerChangeRejected: await rejected(db, `UPDATE external_submissions SET "userId"=$2 WHERE id=$1`, [sub, bob]),
    tokenOwnerChangeRejected: await rejected(db, `UPDATE integration_tokens SET "userId"=$2 WHERE id=$1`, [aliceToken, bob]),
    eventOnForeignApplicationRejected: await rejected(db,
      `INSERT INTO application_events (id, "applicationId", type, "externalSubmissionId") VALUES (gen_random_uuid(), $1, 'AUTOMATION_SUBMITTED', $2)`, [bobApp, sub]),
    duplicateRefRejected: await rejected(db, SUBMISSION, [alice, '2026-10-02/09:00:00', null, 'NEEDS_REVIEW', null, null, null]),
    unresolvedWithResolverRejected: await rejected(db, SUBMISSION, [alice, '2026-10-02/09:00:03', null, 'NEEDS_REVIEW', 'USER', null, new Date()]),
    resolvedWithoutResolverRejected: await rejected(db, SUBMISSION, [alice, '2026-10-02/09:00:04', null, 'IGNORED', null, null, null]),
    badRefRejected: await rejected(db, SUBMISSION, [alice, '2026-10-02 09:00:05', null, 'NEEDS_REVIEW', null, null, null]),
    plaintextTokenRejected: await rejected(db,
      `INSERT INTO integration_tokens (id, "userId", name, "tokenHash", "displayPrefix", "expiresAt") VALUES (gen_random_uuid(), $1, 'x', 'ccmcp_plaintext', 'ccmcp_abcdef', now() + interval '1 day')`, [alice]),
  };
  await db.query(`INSERT INTO application_events (id, "applicationId", type, "externalSubmissionId") VALUES (gen_random_uuid(), $1, 'AUTOMATION_SUBMITTED', $2)`, [aliceApp, sub]);
  checks.secondEventForSubmissionRejected = await rejected(db,
    `INSERT INTO application_events (id, "applicationId", type, "externalSubmissionId") VALUES (gen_random_uuid(), $1, 'AUTOMATION_SUBMITTED', $2)`, [aliceApp, sub]);
  // The SetNull foreign keys must never make deletion fail: application, token, then the whole user.
  await db.query(`DELETE FROM applications WHERE id=$1`, [aliceApp]);
  checks.applicationDeletionKeepsSubmission = (await one(db, `SELECT "applicationId" FROM external_submissions WHERE id=$1`, [sub])).applicationId === null;
  await db.query(`DELETE FROM integration_tokens WHERE id=$1`, [aliceToken]);
  checks.tokenDeletionKeepsSubmission = (await one(db, `SELECT "tokenId" FROM external_submissions WHERE id=$1`, [sub])).tokenId === null;
  const bobSub = await newSubmission(db, bob, '2026-10-02/10:00:00', { token: bobToken, state: 'CREATED', app: bobApp });
  await db.query(`INSERT INTO application_events (id, "applicationId", type, "externalSubmissionId") VALUES (gen_random_uuid(), $1, 'AUTOMATION_SUBMITTED', $2)`, [bobApp, bobSub]);
  await db.query(`DELETE FROM users WHERE id=$1`, [bob]);
  checks.userDeletionCascades = (await one(db,
    `SELECT (SELECT count(*) FROM external_submissions WHERE "userId"=$1) + (SELECT count(*) FROM integration_tokens WHERE "userId"=$1) AS n`, [bob])).n === '0';
  await db.query('ROLLBACK');
  for (const [name, ok] of Object.entries(checks)) assert(ok, `fresh lane check failed: ${name}`);
  await db.end();
  return checks;
}

async function seedLegacy(db) {
  await db.query('BEGIN');
  const owners = [];
  for (let o = 0; o < 3; o++) owners.push(await newUser(db, `legacy-${o}@mcp-lane.test`));
  const apps = [];
  for (let a = 0; a < 60; a++) {
    const owner = owners[a % owners.length];
    apps.push({ owner, id: (await one(db,
      `INSERT INTO applications (id, "userId", "companyName", "jobTitle", "aiStatus", "userStatus", "userStatusRevision", "appliedAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, now() - interval '3 days', now()) RETURNING id`,
      [owner, `Company ${a % 20} ${a % 2 ? 'Inc.' : ''}`.trim(), a % 4 ? `Role ${a % 7}` : null,
        ['APPLIED', 'INTERVIEW', null][a % 3], a % 5 === 0 ? 'OFFER' : null, a % 5 === 0 ? 2 : 0])).id });
  }
  for (let e = 0; e < 600; e++) {
    const app = apps[e % apps.length];
    const linked = e % 3 !== 0;
    const email = (await one(db,
      `INSERT INTO emails (id, "userId", "gmailMessageId", subject, sender, "relevanceState", "matchState", "matchConfirmedBy", "processingState", "applicationId", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, 'synthetic@mcp-lane.test', 'RELEVANT', $4, $5, 'COMPLETED', $6, now()) RETURNING id`,
      [app.owner, `legacy-msg-${e}`, `Synthetic ${e}`, linked ? 'MATCHED' : 'UNMATCHED', linked ? 'AI_AUTO' : null, linked ? app.id : null])).id;
    await db.query(`INSERT INTO ai_processing_results (id, "emailId", provider, model, "contractVersion", "processingStatus", "relevanceDecision", "updatedAt") VALUES (gen_random_uuid(), $1, 'gemini', 'gemini-2.5-flash-lite', 'extraction/v2', 'COMPLETED', 'RELEVANT', now())`, [email]);
    if (!linked) continue;
    await db.query(`INSERT INTO application_events (id, "applicationId", "emailId", type, "newState", description) VALUES (gen_random_uuid(), $1, $2, 'EMAIL_PROCESSED', 'INTERVIEW', 'Received relevant email')`, [app.id, email]);
    if (e % 4 === 0)
      await db.query(`INSERT INTO actions (id, "applicationId", "emailId", type, description, "updatedAt") VALUES (gen_random_uuid(), $1, $2, 'ACTION_REQUIRED', 'Reply', now())`, [app.id, email]);
  }
  // A manual event without an email, which the new column must leave untouched.
  await db.query(`INSERT INTO application_events (id, "applicationId", type, description) VALUES (gen_random_uuid(), $1, 'NOTE_ADDED', 'manual')`, [apps[0].id]);
  await db.query(`INSERT INTO ai_configurations ("userId", provider, "encryptedApiKey", "consentDisclosure", "consentedAt", "updatedAt") VALUES ($1, 'gemini', 'v1:aXY=:Y3Q=', 'gemini-draft-2026-10', now(), now())`, [owners[0]]);
  await db.query('COMMIT');
}

const SNAPSHOT_TABLES = {
  users: 'SELECT * FROM users ORDER BY id',
  applications: 'SELECT * FROM applications ORDER BY id',
  emails: 'SELECT * FROM emails ORDER BY id',
  aiResults: 'SELECT * FROM ai_processing_results ORDER BY id',
  // Pre-existing columns only; the new nullable column is checked separately.
  events: 'SELECT id, "applicationId", "emailId", type, "oldState", "newState", description, provenance, "createdAt" FROM application_events ORDER BY id',
  actions: 'SELECT * FROM actions ORDER BY id',
  aiConfigurations: 'SELECT * FROM ai_configurations ORDER BY "userId"',
};
async function snapshot(db) {
  const out = {};
  for (const [name, sql] of Object.entries(SNAPSHOT_TABLES)) {
    const { rows } = await db.query(sql);
    out[name] = { count: rows.length, digest: nodeCrypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
  }
  return out;
}

async function upgradeLane(url) {
  const db = await connectEmpty(url);
  const legacy = path.join(work, 'prisma-legacy');
  fs.mkdirSync(path.join(legacy, 'migrations'), { recursive: true });
  fs.copyFileSync(path.join(backend, 'prisma/schema.prisma'), path.join(legacy, 'schema.prisma'));
  for (const entry of fs.readdirSync(path.join(backend, 'prisma/migrations')))
    if (entry !== NEW_MIGRATION) fs.cpSync(path.join(backend, 'prisma/migrations', entry), path.join(legacy, 'migrations', entry), { recursive: true });
  guardedMigrate(url, ['--schema', path.join(legacy, 'schema.prisma')]);
  assert.equal((await one(db, `SELECT to_regclass('external_submissions') AS t`)).t, null, 'legacy lane must not have the new tables');

  await seedLegacy(db);
  const before = await snapshot(db);
  const beforeIntegrity = await integrity(db);
  guardedMigrate(url);
  const after = await snapshot(db);
  const afterIntegrity = await integrity(db);
  assert.deepEqual(after, before, 'existing rows or columns changed during the upgrade');
  assert.deepEqual(afterIntegrity.triggers.filter((t) => !NEW_TRIGGERS.includes(t)), beforeIntegrity.triggers, 'existing triggers changed');
  assert.deepEqual(afterIntegrity.uniques.filter((u) => !NEW_UNIQUES.includes(u)), beforeIntegrity.uniques, 'existing unique indexes changed');
  const linkedEvents = (await one(db, `SELECT count(*)::int AS n FROM application_events WHERE "externalSubmissionId" IS NOT NULL`)).n;
  assert.equal(linkedEvents, 0, 'the new event column must be null on every existing row');

  // The upgraded database accepts the feature's rows and still rejects cross-owner links.
  await db.query('BEGIN');
  const [owner, other] = (await db.query(`SELECT id FROM users ORDER BY email LIMIT 2`)).rows.map((r) => r.id);
  const app = (await one(db, `SELECT id FROM applications WHERE "userId"=$1 LIMIT 1`, [owner])).id;
  const foreignApp = (await one(db, `SELECT id FROM applications WHERE "userId"=$1 LIMIT 1`, [other])).id;
  const sub = await newSubmission(db, owner, '2026-10-02/11:00:00', { token: await newToken(db, owner), state: 'LINKED', app });
  await db.query(`INSERT INTO application_events (id, "applicationId", type, "externalSubmissionId") VALUES (gen_random_uuid(), $1, 'AUTOMATION_SUBMITTED', $2)`, [app, sub]);
  const crossOwnerRejected = await rejected(db, SUBMISSION, [owner, '2026-10-02/11:00:01', null, 'LINKED', 'AUTOMATIC', foreignApp, new Date()]);
  await db.query('ROLLBACK');
  assert(crossOwnerRejected, 'cross-owner link must be rejected after the upgrade');
  await db.end();
  return {
    syntheticRows: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.count])),
    unchangedTables: Object.keys(before).length,
    existingTriggersAndUniqueIndexesUnchanged: true,
    newEventColumnNullOnExistingRows: true,
    crossOwnerRejectedAfterUpgrade: true,
  };
}

(async () => {
  const fresh = process.env.FRESH_DATABASE_URL;
  const upgrade = process.env.UPGRADE_DATABASE_URL;
  if (!fresh || !upgrade || fresh === upgrade) throw new Error('Set separate FRESH_DATABASE_URL and UPGRADE_DATABASE_URL');
  const result = { fresh: await freshLane(fresh), upgrade: await upgradeLane(upgrade) };
  console.log(JSON.stringify({ event: 'mcp_migration_preservation_verified', ...result }, null, 2));
})()
  .catch((err) => {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(work, { recursive: true, force: true });
    process.exit(); // a failed assertion can leave a lane connection open
  });
