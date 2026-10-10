// Guarded Prisma CLI runner. Loads overriding .env.test, compares it
// with an independently exported TEST_DATABASE_URL, runs the existing safety guard, and only
// then spawns the installed Prisma CLI with the validated environment. Requires a fresh build.
const { config } = require('dotenv');
const { spawnSync } = require('node:child_process');
const expectedTarget = process.env.TEST_DATABASE_URL;
if (!expectedTarget)
  throw new Error('Export the reviewed disposable test target before continuing');
const loaded = config({
  path: process.env.TEST_ENV_FILE || '.env.test',
  override: true,
  quiet: true,
});
if (loaded.error) throw new Error('Test configuration could not be loaded; no migration started');
const { assertTestDatabase } = require('../dist/utils/testDatabase');
try {
  assertTestDatabase(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
  if (process.env.TEST_DATABASE_URL !== expectedTarget) throw new Error();
} catch {
  throw new Error('Test database preflight failed; no migration started');
}
process.env.NODE_ENV = 'test';
const prismaCli = require.resolve('prisma/build/index.js');
const commands =
  process.argv.length > 2
    ? [process.argv.slice(2)]
    : [['migrate', 'deploy'], ['migrate', 'status'], ['validate']];
for (const args of commands) {
  const result = spawnSync(process.execPath, [prismaCli, ...args], {
    env: { ...process.env },
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
