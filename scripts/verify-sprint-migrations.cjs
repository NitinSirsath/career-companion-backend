// Additive sprint preservation: two new, empty, explicitly supplied guarded fixture databases.
// Snapshot every existing column before deployment, including durable AI/MCP identities.
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { assertTestDatabase } = require('../dist/utils/testDatabase');
const root = path.resolve(__dirname, '..'),
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sprint-preservation-'));
const cutoff = process.env.FIRST_NEW_MIGRATION || '20261003100000_job_search_agenda';
function migrate(url, schema) {
  const file = path.join(work, 'fixture.env');
  fs.writeFileSync(
    file,
    `DATABASE_URL=${JSON.stringify(url)}\nTEST_DATABASE_URL=${JSON.stringify(url)}\n`,
    { mode: 0o600 },
  );
  const result = spawnSync(
    process.execPath,
    ['scripts/guarded-migrate.cjs', 'migrate', 'deploy', ...(schema ? ['--schema', schema] : [])],
    {
      cwd: root,
      env: { ...process.env, TEST_ENV_FILE: file, TEST_DATABASE_URL: url },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) throw Error(result.stderr || 'Guarded migration failed');
}
async function empty(url) {
  assertTestDatabase(url, url);
  const db = new Client({ connectionString: url });
  await db.connect();
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0]
      .n,
    0,
    'Refuse nonempty fixture',
  );
  return db;
}
const one = async (db, sql, args) => (await db.query(sql, args)).rows[0];
async function seed(db) {
  const hasAgenda = (await one(db, "SELECT to_regclass('agenda_items') AS name")).name !== null;
  for (let n = 0; n < 12; n++) {
    const u = (
      await one(
        db,
        'INSERT INTO users (id,email,"updatedAt") VALUES(gen_random_uuid(),$1,now()) RETURNING id',
        [`sprint-${n}@fixture.test`],
      )
    ).id;
    const a = (
      await one(
        db,
        'INSERT INTO applications(id,"userId","companyName","userStatus","userStatusRevision","updatedAt") VALUES(gen_random_uuid(),$1,\'Fixture\',\'OFFER\',4,now()) RETURNING id',
        [u],
      )
    ).id;
    const e = (
      await one(
        db,
        'INSERT INTO emails(id,"userId","gmailMessageId","applicationId","matchState","updatedAt") VALUES(gen_random_uuid(),$1,$2,$3,\'MATCHED\',now()) RETURNING id',
        [u, `mail-${n}`, a],
      )
    ).id;
    await db.query(
      'INSERT INTO ai_processing_results(id,"emailId",provider,model,"contractVersion","processingStatus","updatedAt") VALUES(gen_random_uuid(),$1,\'fixture\',\'fixture\',\'extraction/v2\',\'COMPLETED\',now())',
      [e],
    );
    await db.query(
      'INSERT INTO ai_operations(id,"emailId",operation,version,status,attempts,"updatedAt") VALUES(gen_random_uuid(),$1,\'extraction\',\'extraction/v2\',$2,1,now())',
      [e, n % 2 ? 'UNKNOWN' : 'COMPLETED'],
    );
    await db.query(
      'INSERT INTO actions(id,"applicationId","emailId",type,description,status,"updatedAt") VALUES(gen_random_uuid(),$1,$2,\'FOLLOW_UP_REQUIRED\',\'Synthetic follow-up\',\'COMPLETED\',now())',
      [a, e],
    );
    if (hasAgenda)
      await db.query(
        `INSERT INTO agenda_items(id,"userId","applicationId","emailId","candidateKey","extractionVersion",suggestion,"userTiming",precision,date,state,revision,"updatedAt") VALUES(gen_random_uuid(),$1,$2,$3,'v3:0','extraction/v3',$4,$5,'DATE','2026-10-04','CONFIRMED',3,now())`,
        [
          u,
          a,
          e,
          JSON.stringify({
            key: 'v3:0',
            kind: 'INTERVIEW',
            change: 'SCHEDULED',
            rawWhen: '2026-10-04',
            date: '2026-10-04',
            time: null,
            sourceTimeZone: null,
            evidence: null,
            temporal: {
              precision: 'DATE',
              date: '2026-10-04',
              time: null,
              sourceTimeZone: null,
              instant: null,
            },
          }),
          JSON.stringify({
            precision: 'DATE',
            date: '2026-10-04',
            time: null,
            sourceTimeZone: null,
            instant: null,
          }),
        ],
      );
    await db.query(
      'INSERT INTO application_events(id,"applicationId","emailId",type) VALUES(gen_random_uuid(),$1,$2,\'EMAIL_PROCESSED\')',
      [a, e],
    );
    await db.query(
      `INSERT INTO external_submissions(id,"userId",source,"sourceRecordRef",platform,company,"jobTitle","submittedAt","matchState","applicationId","resolvedBy","resolvedAt") VALUES(gen_random_uuid(),$1,'AUTOMATION',$2,'linkedin','Fixture','Engineer',now(),'LINKED',$3,'AUTOMATIC',now())`,
      [u, `2026-10-03/10:00:${String(n).padStart(2, '0')}`, a],
    );
  }
}
async function snapshot(db, columns) {
  const result = {};
  for (const [table, cols] of Object.entries(columns)) {
    const rows = (
      await db.query(`SELECT ${cols.map((c) => '"' + c + '"').join(',')} FROM "${table}"`)
    ).rows;
    result[table] = rows.map((row) => JSON.stringify(row)).sort();
  }
  return result;
}
(async () => {
  const fresh = process.env.FRESH_DATABASE_URL,
    upgrade = process.env.UPGRADE_DATABASE_URL;
  assert(fresh && upgrade && fresh !== upgrade);
  const f = await empty(fresh);
  migrate(fresh);
  await f.end();
  const db = await empty(upgrade);
  try {
    const legacy = path.join(work, 'prisma');
    fs.mkdirSync(path.join(legacy, 'migrations'), { recursive: true });
    fs.copyFileSync(path.join(root, 'prisma/schema.prisma'), path.join(legacy, 'schema.prisma'));
    for (const name of fs.readdirSync(path.join(root, 'prisma/migrations')))
      if (name === 'migration_lock.toml' || name < cutoff)
        fs.cpSync(
          path.join(root, 'prisma/migrations', name),
          path.join(legacy, 'migrations', name),
          { recursive: true },
        );
    migrate(upgrade, path.join(legacy, 'schema.prisma'));
    await seed(db);
    const columns = {};
    for (const row of (
      await db.query(
        "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name<>'_prisma_migrations' ORDER BY ordinal_position",
      )
    ).rows)
      (columns[row.table_name] ??= []).push(row.column_name);
    const before = await snapshot(db, columns);
    migrate(upgrade);
    assert.deepEqual(await snapshot(db, columns), before);
    const defaults = await one(
      db,
      `SELECT count(*)::int AS n FROM actions WHERE origin IS NOT NULL OR "actionRevision"<>0 OR "clientRequestId" IS NOT NULL OR "snoozedUntil" IS NOT NULL`,
    );
    assert.equal(defaults.n, 0, 'Existing actions were reinterpreted');
    console.log(
      JSON.stringify({
        event: 'sprint_migration_preserved',
        cutoff,
        fresh: true,
        unchangedTables: Object.keys(before).length,
        syntheticRows: Object.values(before).reduce((sum, rows) => sum + rows.length, 0),
      }),
    );
  } finally {
    await db.end();
  }
})()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(work, { recursive: true, force: true }));
