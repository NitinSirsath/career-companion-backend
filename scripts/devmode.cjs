// One command for dev mode (`npm run devmode`). On first run it makes .env.dev from
// .env.dev.example with fresh secrets. Every run it creates the dev database when it is missing,
// brings it to the latest structure and starts the backend. It never deletes data.
const { randomBytes } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('dotenv');
const { Client } = require('pg');

// The mode and database rules live in src/utils/config.ts; this script only asks them.
require('ts-node').register({ transpileOnly: true });
const { databaseName, isDevDatabase, parseAPP_MODE } = require('../src/utils/config');

const root = path.resolve(__dirname, '..');
const envFile = path.join(root, '.env.dev');
const SECRETS = [
  'SESSION_SECRET',
  'OAUTH_STATE_COOKIE_SECRET',
  'GMAIL_TOKEN_ENCRYPTION_KEY',
  'AI_CREDENTIAL_ENCRYPTION_KEY',
];

function stop(message) {
  console.error(`devmode: ${message}`);
  process.exit(1);
}

function ensureEnvFile() {
  if (fs.existsSync(envFile)) return;
  let text = fs.readFileSync(path.join(root, '.env.dev.example'), 'utf8');
  for (const name of SECRETS)
    text = text.replace(
      new RegExp(`^${name}=.*$`, 'm'),
      `${name}=${randomBytes(32).toString('hex')}`,
    );
  fs.writeFileSync(envFile, text, { mode: 0o600 });
  console.log('devmode: created .env.dev with fresh secrets');
}

function readEnv() {
  const env = parse(fs.readFileSync(envFile, 'utf8'));
  let mode;
  try {
    mode = parseAPP_MODE(env.APP_MODE);
  } catch (err) {
    stop(err.message);
  }
  if (mode !== 'dev') stop('.env.dev must say APP_MODE=dev');
  if (!isDevDatabase(env.DATABASE_URL))
    stop(
      'DATABASE_URL in .env.dev must be written out in full and name a database that ends in "_dev"',
    );
  return env;
}

async function ensureDatabase(url) {
  const name = databaseName(url);
  const server = new URL(url);
  server.pathname = '/postgres';
  server.search = '';
  const client = new Client({ connectionString: server.toString() });
  try {
    await client.connect();
  } catch {
    stop(
      `cannot reach PostgreSQL at ${server.host}. Start it (npm run db:up) or correct DATABASE_URL in .env.dev`,
    );
  }
  try {
    const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (found.rowCount) return;
    await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    console.log(`devmode: created database ${name}`);
  } finally {
    await client.end();
  }
}

function migrate(env) {
  const result = spawnSync(
    process.execPath,
    [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
    { cwd: root, env, stdio: 'inherit' },
  );
  if (result.error || result.status !== 0) stop('the database could not be brought up to date');
}

function start(env, preload) {
  const server = spawn(
    process.execPath,
    [
      require.resolve('ts-node-dev/lib/bin.js'),
      '--respawn',
      '--transpile-only',
      ...(preload ? ['-r', preload] : []),
      'src/index.ts',
    ],
    { cwd: root, env, stdio: 'inherit' },
  );
  // ts-node-dev stops the server it runs only on SIGTERM, so Ctrl+C is passed on as SIGTERM.
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill('SIGTERM'));
  server.on('exit', (code) => process.exit(code ?? 0));
}

/**
 * Sets up and starts dev mode. `preload` is a module the server loads before the app; only the
 * fake-AI-errors command passes one, so `npm run devmode` itself stays real AI only.
 */
async function runDevMode(preload) {
  ensureEnvFile();
  // .env.dev wins over the shell, so an exported DATABASE_URL can never redirect dev mode.
  const env = { ...process.env, ...readEnv() };
  await ensureDatabase(env.DATABASE_URL);
  migrate(env);
  start(env, preload);
}

if (require.main === module) runDevMode().catch((err) => stop(err.message));

module.exports = { runDevMode };
