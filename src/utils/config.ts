import { parseGmailSchedule } from '../services/gmailSchedule';
import { validateMcpProductionConfig } from '../mcp/config';

export function validateProductionConfig(env: NodeJS.ProcessEnv) {
  if (
    env.TRUST_PROXY_HOPS &&
    (!/^[1-9]\d*$/.test(env.TRUST_PROXY_HOPS) ||
      !Number.isSafeInteger(Number(env.TRUST_PROXY_HOPS)))
  ) {
    throw new Error('TRUST_PROXY_HOPS must be a positive integer');
  }
  parseGmailSchedule(env);
  if (env.NODE_ENV !== 'production') return;
  if (env.ENABLE_DEV_AUTH === 'true')
    throw new Error('Development authentication is forbidden in production');
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
  if (!aiKey || !/^[0-9a-f]{64}$/i.test(aiKey))
    throw new Error('AI_CREDENTIAL_ENCRYPTION_KEY must be a 64-character hex string');
  if (aiKey.toLowerCase() === env.GMAIL_TOKEN_ENCRYPTION_KEY?.toLowerCase())
    throw new Error('AI_CREDENTIAL_ENCRYPTION_KEY must differ from GMAIL_TOKEN_ENCRYPTION_KEY');
  // There is no Career Companion AI key: every AI call uses the user's own access (ADR-0001).
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
  const limit = env.AI_USER_DAILY_CALL_LIMIT;
  if (limit !== undefined && !(/^\d+$/.test(limit) && Number(limit) <= 5000))
    throw new Error('AI_USER_DAILY_CALL_LIMIT must be an integer from 0 to 5000');
  // MCP endpoint (ADR-0002): an explicit Host allowlist and a valid daily submission limit.
  validateMcpProductionConfig(env);
}
