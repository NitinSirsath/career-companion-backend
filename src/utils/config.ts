/**
 * The only file that reads `process.env`. Each variable has one parser and one small getter.
 * Getters read at call time, so tests can change a variable between calls. Add a getter here
 * for a new variable; `.env.example` explains what each one is for.
 */

// ─── Runtime ────────────────────────────────────────────────────────────────

export const isProduction = () => process.env.NODE_ENV === 'production';
export const isTest = () => process.env.NODE_ENV === 'test';

export const port = () => process.env.PORT || 3000;
export const databaseUrl = () => process.env.DATABASE_URL;

/** Where the web app runs: the CORS origin and the target of redirects after Google consent. */
export const frontendUrl = () =>
  process.env.FRONTEND_URL?.replace(/\/$/, '') ?? 'http://localhost:5173';

export function parseTRUST_PROXY_HOPS(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error('TRUST_PROXY_HOPS must be a positive integer');
  return Number(value);
}
export const trustProxyHops = () => parseTRUST_PROXY_HOPS(process.env.TRUST_PROXY_HOPS);

export function logLevel(): 'debug' | 'info' | 'warn' | 'error' {
  const value = process.env.LOG_LEVEL?.trim().toLowerCase() || 'info';
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value;
  throw new Error('LOG_LEVEL must be debug, info, warn or error');
}

export function readableLogs(): boolean {
  return !isProduction() && !isTest();
}

// ─── Login and sessions ─────────────────────────────────────────────────────

export const sessionSecret = () =>
  process.env.SESSION_SECRET || 'dev-session-secret-change-in-prod';
export const cookieSecret = () =>
  process.env.OAUTH_STATE_COOKIE_SECRET ?? 'dev-cookie-secret-change-in-prod';

/** The `X-Development-User` login exists only for automated tests. */
export const devAuthEnabled = () => isTest() && process.env.ENABLE_DEV_AUTH === 'true';

const GOOGLE_LOGIN_VARS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
] as const;
export const missingGoogleLoginVars = () => GOOGLE_LOGIN_VARS.filter((name) => !process.env[name]);

export const googleLoginOAuth = () => ({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  // The default matches the Vite dev server port, so the redirect works without extra setup.
  redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5173/api/auth/callback',
});

// ─── Gmail ──────────────────────────────────────────────────────────────────

export const gmailOAuth = () => ({
  clientId: process.env.GMAIL_CLIENT_ID,
  clientSecret: process.env.GMAIL_CLIENT_SECRET,
  redirectUri: process.env.GMAIL_REDIRECT_URI,
});

/** Raw value; `utils/gmailTokenEncryption.ts` checks it and turns it into the key. */
export const gmailTokenEncryptionKey = () => process.env.GMAIL_TOKEN_ENCRYPTION_KEY;

export function parseGmailSchedule(env: NodeJS.ProcessEnv) {
  const enabled = env.GMAIL_SCHEDULED_SYNC_ENABLED ?? 'true';
  if (!['true', 'false'].includes(enabled))
    throw new Error('GMAIL_SCHEDULED_SYNC_ENABLED must be true or false');
  const timezone = env.GMAIL_SCHEDULED_SYNC_TZ ?? 'Asia/Kolkata';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error('GMAIL_SCHEDULED_SYNC_TZ must be a valid IANA timezone');
  }
  return { enabled: enabled === 'true', timezone };
}
// Read once: the schedule is registered at startup and must not change under a running worker.
let gmailSchedule: ReturnType<typeof parseGmailSchedule> | undefined;
export const gmailScheduleConfig = () => (gmailSchedule ??= parseGmailSchedule(process.env));

// ─── AI ─────────────────────────────────────────────────────────────────────

/** Raw value; `services/ai/credentials.ts` checks it and turns it into the key. */
export const aiCredentialEncryptionKey = () => process.env.AI_CREDENTIAL_ENCRYPTION_KEY;

export function parseAI_TRIAGE_BATCH_ENABLED(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('AI_TRIAGE_BATCH_ENABLED must be empty, false, or true');
}
export const triageBatchEnabled = () =>
  parseAI_TRIAGE_BATCH_ENABLED(process.env.AI_TRIAGE_BATCH_ENABLED);

export function parseAI_TRIAGE_BATCH_SIZE(value: string | undefined): number {
  if (value === undefined || value === '') return 20;
  if (!/^\d+$/.test(value)) throw new Error('AI_TRIAGE_BATCH_SIZE must be an integer from 1 to 25');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 25)
    throw new Error('AI_TRIAGE_BATCH_SIZE must be an integer from 1 to 25');
  return parsed;
}
export const triageBatchSize = () => parseAI_TRIAGE_BATCH_SIZE(process.env.AI_TRIAGE_BATCH_SIZE);

export function parseRELEVANCE_CONFIDENCE_THRESHOLD(value: string | undefined): number {
  const threshold = Number(value ?? 0.7);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    throw new Error('RELEVANCE_CONFIDENCE_THRESHOLD must be a number from 0 to 1');
  return threshold;
}
export const relevanceThreshold = () =>
  parseRELEVANCE_CONFIDENCE_THRESHOLD(process.env.RELEVANCE_CONFIDENCE_THRESHOLD);

export const DEFAULT_USER_DAILY_CALL_LIMIT = 500;

/** AI calls per user per UTC day, 0–5000. 0 pauses all AI calls. */
export function parseAI_USER_DAILY_CALL_LIMIT(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_USER_DAILY_CALL_LIMIT;
  if (!/^\d+$/.test(value) || Number(value) > 5000)
    throw new Error('Invalid AI_USER_DAILY_CALL_LIMIT: must be an integer from 0 to 5000');
  return Number(value);
}
export const userDailyCallLimit = () =>
  parseAI_USER_DAILY_CALL_LIMIT(process.env.AI_USER_DAILY_CALL_LIMIT);

/** Off until extraction/v3 is qualified. Turning it off only stops new selection and projection. */
export const agendaExtractionV3Enabled = () => process.env.AGENDA_EXTRACTION_V3_ENABLED === 'true';

// ─── Discord notifications ──────────────────────────────────────────────────

export const discordWebhookUrl = () => process.env.DISCORD_WEBHOOK_URL;

/** The one user whose actions are sent to the Discord webhook; unset means nobody. */
export function discordUserId(): string | undefined {
  return process.env.DISCORD_USER_ID || undefined;
}

// ─── Automation submissions through MCP ─────────────────────────────────────

const LOCALHOST = ['localhost', '127.0.0.1', '[::1]'];
const HOSTNAME = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/i;

export function parseHostnameList(name: string, raw: string | undefined): string[] {
  const items = (raw ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  for (const item of items)
    if (!HOSTNAME.test(item))
      throw new Error(`${name} must list hostnames only, without scheme, port or path`);
  return items.map((h) => h.toLowerCase());
}

/**
 * Hostnames (no scheme or port) the `Host` header may name for /mcp: localhost unless set.
 * A present `Origin` must name a listed origin; with none listed, any `Origin` is rejected.
 */
export function mcpConfig(env: NodeJS.ProcessEnv = process.env) {
  const hosts = parseHostnameList('MCP_ALLOWED_HOSTS', env.MCP_ALLOWED_HOSTS);
  return {
    allowedHosts: hosts.length ? hosts : LOCALHOST,
    allowedOrigins: parseHostnameList('MCP_ALLOWED_ORIGINS', env.MCP_ALLOWED_ORIGINS),
  };
}

export const DEFAULT_DAILY_SUBMISSION_LIMIT = 500;

/** New submissions per user per UTC day, 0–5000. 0 stops all new submissions. */
export function parseMCP_DAILY_SUBMISSION_LIMIT(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_DAILY_SUBMISSION_LIMIT;
  if (!/^\d+$/.test(value) || Number(value) > 5000)
    throw new Error('Invalid MCP_DAILY_SUBMISSION_LIMIT: must be an integer from 0 to 5000');
  return Number(value);
}
export const submissionDailyLimit = () =>
  parseMCP_DAILY_SUBMISSION_LIMIT(process.env.MCP_DAILY_SUBMISSION_LIMIT);

// ─── Test tools (manual test environment only) ──────────────────────────────
// The test inbox and reset are on only when TEST_TOOLS_ENABLED=true AND the database name
// contains "test", so a copied flag can never turn them on against a live database.

export function parseTEST_TOOLS_ENABLED(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('TEST_TOOLS_ENABLED must be empty, false, or true');
}

/** The database name in DATABASE_URL, or null when it is missing or not a plain URL. */
export function databaseName(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return decodeURIComponent(new URL(url).pathname.slice(1)) || null;
  } catch {
    return null;
  }
}

export const isTestDatabase = (url: string | undefined): boolean =>
  /test/i.test(databaseName(url) ?? '');

/** Checked again on every use, so changing the environment at runtime cannot bypass startup. */
export function testToolsEnabled(): boolean {
  try {
    return (
      parseTEST_TOOLS_ENABLED(process.env.TEST_TOOLS_ENABLED) &&
      isTestDatabase(process.env.DATABASE_URL)
    );
  } catch {
    return false;
  }
}

function validateTestTools(env: NodeJS.ProcessEnv) {
  if (parseTEST_TOOLS_ENABLED(env.TEST_TOOLS_ENABLED) && !isTestDatabase(env.DATABASE_URL))
    throw new Error(
      'TEST_TOOLS_ENABLED=true needs a DATABASE_URL, written out in full, whose database name contains "test". Test tools never run on live data.',
    );
}

// ─── Startup checks ─────────────────────────────────────────────────────────

const HEX_KEY = /^[0-9a-f]{64}$/i;

export function validateRequiredSecrets(env: NodeJS.ProcessEnv = process.env) {
  for (const key of ['GMAIL_TOKEN_ENCRYPTION_KEY', 'AI_CREDENTIAL_ENCRYPTION_KEY'] as const) {
    if (!env[key] || !HEX_KEY.test(env[key])) {
      throw new Error(
        `${key} is missing or not 64 hex characters. Generate one with the command in .env.example.`,
      );
    }
  }
  if (
    env.GMAIL_TOKEN_ENCRYPTION_KEY!.toLowerCase() ===
    env.AI_CREDENTIAL_ENCRYPTION_KEY!.toLowerCase()
  ) {
    throw new Error('AI_CREDENTIAL_ENCRYPTION_KEY must differ from GMAIL_TOKEN_ENCRYPTION_KEY');
  }
}

/** Refuses to start on a value that would fail later. Most checks apply to production only. */
export function validateProductionConfig(env: NodeJS.ProcessEnv = process.env) {
  parseTRUST_PROXY_HOPS(env.TRUST_PROXY_HOPS);
  parseGmailSchedule(env);
  parseAI_TRIAGE_BATCH_ENABLED(env.AI_TRIAGE_BATCH_ENABLED);
  parseAI_TRIAGE_BATCH_SIZE(env.AI_TRIAGE_BATCH_SIZE);
  validateTestTools(env);
  if (env.NODE_ENV !== 'production') return;
  if (env.ENABLE_DEV_AUTH === 'true')
    throw new Error('Development authentication is forbidden in production');
  validateProductionSecrets(env);
  validateProductionAI(env);
  // MCP endpoint (ADR-0002): an explicit Host allowlist and a valid daily submission limit.
  if (!parseHostnameList('MCP_ALLOWED_HOSTS', env.MCP_ALLOWED_HOSTS).length)
    throw new Error('MCP_ALLOWED_HOSTS must list the Host names the backend receives for /mcp');
  parseHostnameList('MCP_ALLOWED_ORIGINS', env.MCP_ALLOWED_ORIGINS);
  parseMCP_DAILY_SUBMISSION_LIMIT(env.MCP_DAILY_SUBMISSION_LIMIT);
}

function validateProductionSecrets(env: NodeJS.ProcessEnv) {
  for (const key of ['SESSION_SECRET', 'OAUTH_STATE_COOKIE_SECRET'] as const) {
    if (!env[key] || env[key]!.length < 32 || env[key]!.startsWith('dev-')) {
      throw new Error(`${key} must be a strong production secret`);
    }
  }
  for (const key of ['FRONTEND_URL', 'GOOGLE_REDIRECT_URI', 'GMAIL_REDIRECT_URI'] as const) {
    if (!env[key] || new URL(env[key]!).protocol !== 'https:')
      throw new Error(`${key} must use HTTPS in production`);
  }
  // User-provided AI keys are sealed with their own key, never the Gmail token key (ADR-0001).
  const aiKey = env.AI_CREDENTIAL_ENCRYPTION_KEY;
  if (!aiKey || !HEX_KEY.test(aiKey))
    throw new Error('AI_CREDENTIAL_ENCRYPTION_KEY must be a 64-character hex string');
  if (aiKey.toLowerCase() === env.GMAIL_TOKEN_ENCRYPTION_KEY?.toLowerCase())
    throw new Error('AI_CREDENTIAL_ENCRYPTION_KEY must differ from GMAIL_TOKEN_ENCRYPTION_KEY');
}

// There is no Career Companion AI key: every AI call uses the user's own access (ADR-0001).
function validateProductionAI(env: NodeJS.ProcessEnv) {
  for (const key of [
    'GEMINI_API_KEY',
    'GEMINI_RELEVANCE_MODEL',
    'GEMINI_EXTRACTION_MODEL',
  ] as const)
    if (env[key] !== undefined)
      throw new Error(
        `${key} is no longer used: AI runs on each user's own provider and catalog models`,
      );
  if (env.AI_DAILY_CALL_LIMIT !== undefined)
    throw new Error(
      'AI_DAILY_CALL_LIMIT (global) was replaced by AI_USER_DAILY_CALL_LIMIT (per user)',
    );
  parseAI_USER_DAILY_CALL_LIMIT(env.AI_USER_DAILY_CALL_LIMIT);
}

/** Settings that still work when missing, but only for local development. */
export function startupWarnings(): string[] {
  const warnings: string[] = [];
  if (process.env.ENABLE_DEV_AUTH === 'true' && !isTest() && !isProduction())
    warnings.push('ENABLE_DEV_AUTH is ignored outside NODE_ENV=test; use Google login.');
  if (!process.env.SESSION_SECRET)
    warnings.push(
      'SESSION_SECRET is not set — using an insecure dev default. ' +
        'Set SESSION_SECRET in .env before running in any shared or production environment.',
    );
  if (!process.env.FRONTEND_URL)
    warnings.push(
      'FRONTEND_URL is not set — defaulting to http://localhost:5173 (Vite dev server). ' +
        'Set FRONTEND_URL in .env for production.',
    );
  return warnings;
}
