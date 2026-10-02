// MCP-04: endpoint configuration and production startup checks (ADR-0002 decision 11).
import { describe, expect, it } from 'vitest';
import { mcpConfig, parseHostnameList } from '../mcp/config';
import { validateProductionConfig } from '../utils/config';

const production = {
  NODE_ENV: 'production',
  SESSION_SECRET: 's'.repeat(40),
  OAUTH_STATE_COOKIE_SECRET: 'o'.repeat(40),
  FRONTEND_URL: 'https://app.example.com',
  GOOGLE_REDIRECT_URI: 'https://app.example.com/api/auth/callback',
  GMAIL_REDIRECT_URI: 'https://app.example.com/api/gmail/callback',
  GMAIL_TOKEN_ENCRYPTION_KEY: 'a1'.repeat(32),
  AI_CREDENTIAL_ENCRYPTION_KEY: 'b2'.repeat(32),
  MCP_ALLOWED_HOSTS: 'api.example.com, internal-alb.example.com',
};

describe('mcpConfig', () => {
  it('defaults to localhost hosts and no allowed origins outside production', () => {
    expect(mcpConfig({})).toEqual({ allowedHosts: ['localhost', '127.0.0.1', '[::1]'], allowedOrigins: [] });
  });

  it('parses comma-separated hostnames, trimmed and lowercased', () => {
    expect(mcpConfig({ MCP_ALLOWED_HOSTS: ' API.example.com ,localhost', MCP_ALLOWED_ORIGINS: 'ide.example' })).toEqual({
      allowedHosts: ['api.example.com', 'localhost'],
      allowedOrigins: ['ide.example'],
    });
  });

  it.each(['https://api.example.com', 'api.example.com:443', 'api.example.com/mcp', 'bad host'])('rejects %j', (value) => {
    expect(() => parseHostnameList('MCP_ALLOWED_HOSTS', value)).toThrow('hostnames only');
  });
});

describe('production startup', () => {
  it('accepts an explicit host allowlist and a valid limit', () => {
    expect(() => validateProductionConfig(production)).not.toThrow();
    expect(() => validateProductionConfig({ ...production, MCP_DAILY_SUBMISSION_LIMIT: '0' })).not.toThrow();
    expect(() => validateProductionConfig({ ...production, MCP_DAILY_SUBMISSION_LIMIT: '5000' })).not.toThrow();
  });

  it.each([
    ['no host allowlist', { MCP_ALLOWED_HOSTS: undefined }, 'MCP_ALLOWED_HOSTS must list'],
    ['an empty host allowlist', { MCP_ALLOWED_HOSTS: ' , ' }, 'MCP_ALLOWED_HOSTS must list'],
    ['a host with a scheme', { MCP_ALLOWED_HOSTS: 'https://api.example.com' }, 'hostnames only'],
    ['an origin with a scheme', { MCP_ALLOWED_ORIGINS: 'https://ide.example' }, 'hostnames only'],
    ['a limit over 5000', { MCP_DAILY_SUBMISSION_LIMIT: '5001' }, 'from 0 to 5000'],
    ['a negative limit', { MCP_DAILY_SUBMISSION_LIMIT: '-1' }, 'from 0 to 5000'],
    ['a non-numeric limit', { MCP_DAILY_SUBMISSION_LIMIT: 'lots' }, 'from 0 to 5000'],
  ])('refuses to start with %s', (_label, change, message) => {
    expect(() => validateProductionConfig({ ...production, ...change })).toThrow(message);
  });

  it('does not require MCP settings outside production', () => {
    expect(() => validateProductionConfig({ NODE_ENV: 'development' })).not.toThrow();
  });
});
