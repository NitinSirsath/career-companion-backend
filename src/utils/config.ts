export function validateProductionConfig(env: NodeJS.ProcessEnv) {
  if (
    env.TRUST_PROXY_HOPS &&
    (!/^[1-9]\d*$/.test(env.TRUST_PROXY_HOPS) ||
      !Number.isSafeInteger(Number(env.TRUST_PROXY_HOPS)))
  ) {
    throw new Error('TRUST_PROXY_HOPS must be a positive integer');
  }
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
}
