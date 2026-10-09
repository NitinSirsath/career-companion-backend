/**
 * MCP endpoint configuration (ADR-0002 decision 11; MCP-04).
 *
 *   MCP_ALLOWED_HOSTS     comma-separated hostnames (no scheme or port) the `Host` header may name.
 *                         Outside production it defaults to localhost; production requires it.
 *   MCP_ALLOWED_ORIGINS   comma-separated hostnames a present `Origin` may name. Default empty:
 *                         any `Origin` is rejected; requests without one pass.
 *   MCP_DAILY_SUBMISSION_LIMIT  read per call by the intake service (0–5000, default 500).
 */
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

export function mcpConfig(env: NodeJS.ProcessEnv = process.env) {
  const hosts = parseHostnameList('MCP_ALLOWED_HOSTS', env.MCP_ALLOWED_HOSTS);
  return {
    allowedHosts: hosts.length ? hosts : LOCALHOST,
    allowedOrigins: parseHostnameList('MCP_ALLOWED_ORIGINS', env.MCP_ALLOWED_ORIGINS),
  };
}

/** Production startup checks, called from validateProductionConfig. */
export function validateMcpProductionConfig(env: NodeJS.ProcessEnv) {
  if (!parseHostnameList('MCP_ALLOWED_HOSTS', env.MCP_ALLOWED_HOSTS).length)
    throw new Error('MCP_ALLOWED_HOSTS must list the Host names the backend receives for /mcp');
  parseHostnameList('MCP_ALLOWED_ORIGINS', env.MCP_ALLOWED_ORIGINS);
  const limit = env.MCP_DAILY_SUBMISSION_LIMIT;
  if (limit !== undefined && !(/^\d+$/.test(limit) && Number(limit) <= 5000))
    throw new Error('MCP_DAILY_SUBMISSION_LIMIT must be an integer from 0 to 5000');
}
