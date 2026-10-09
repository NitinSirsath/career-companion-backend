import { inspect } from 'util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CredentialUnreadableError,
  loadAICredentialKey,
  openApiKey,
  sealApiKey,
} from '../services/ai/credentials';
import { validateProductionConfig, validateRequiredSecrets } from '../utils/config';

const KEY = 'sk-test-SENTINEL-credential-0123456789';
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const original = process.env.AI_CREDENTIAL_ENCRYPTION_KEY;

afterEach(() => {
  process.env.AI_CREDENTIAL_ENCRYPTION_KEY = original;
});

describe('AI credential sealing', () => {
  it('round-trips for the owner and never contains the plaintext', () => {
    const sealed = sealApiKey(OWNER, KEY);
    expect(sealed).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(sealed).not.toContain('SENTINEL');
    expect(Buffer.from(sealed.split(':')[2], 'base64').toString('latin1')).not.toContain(
      'SENTINEL',
    );
    expect(openApiKey(OWNER, sealed)).toBe(KEY);
  });

  it('uses a fresh IV each time', () => {
    expect(sealApiKey(OWNER, KEY)).not.toBe(sealApiKey(OWNER, KEY));
  });

  it("cannot be opened as another user's key (bound by AAD)", () => {
    expect(() => openApiKey(OTHER, sealApiKey(OWNER, KEY))).toThrow(CredentialUnreadableError);
  });

  it.each([
    ['tampered ciphertext', (s: string) => s.slice(0, -4) + (s.endsWith('AAAA') ? 'BBBB' : 'AAAA')],
    ['truncated', (s: string) => s.slice(0, 12)],
    ['wrong format', (s: string) => s.replace(/^v1:/, 'v0:')],
    ['extra segment', (s: string) => `${s}:x`],
    ['plain text', () => KEY],
  ])('rejects %s without revealing anything', (_label, mutate) => {
    const error = (() => {
      try {
        openApiKey(OWNER, mutate(sealApiKey(OWNER, KEY)));
      } catch (err) {
        return err;
      }
    })();
    expect(error).toBeInstanceOf(CredentialUnreadableError);
    expect(`${inspect(error)} ${JSON.stringify(error)}`).not.toContain('SENTINEL');
  });

  it('fails clearly when the encryption key is missing, malformed or rotated away', () => {
    const sealed = sealApiKey(OWNER, KEY);
    process.env.AI_CREDENTIAL_ENCRYPTION_KEY = '';
    expect(() => loadAICredentialKey()).toThrow('64-character hex');
    process.env.AI_CREDENTIAL_ENCRYPTION_KEY = 'zz'.repeat(32);
    expect(() => sealApiKey(OWNER, KEY)).toThrow('64-character hex');
    process.env.AI_CREDENTIAL_ENCRYPTION_KEY = 'ab'.repeat(32);
    expect(() => openApiKey(OWNER, sealed)).toThrow(CredentialUnreadableError);
  });
});

describe('production configuration for AI credentials', () => {
  const base = {
    NODE_ENV: 'production',
    SESSION_SECRET: 's'.repeat(40),
    OAUTH_STATE_COOKIE_SECRET: 'o'.repeat(40),
    FRONTEND_URL: 'https://app.example.com',
    GOOGLE_REDIRECT_URI: 'https://app.example.com/api/auth/callback',
    GMAIL_REDIRECT_URI: 'https://app.example.com/api/gmail/callback',
    GMAIL_TOKEN_ENCRYPTION_KEY: 'a1'.repeat(32),
    AI_CREDENTIAL_ENCRYPTION_KEY: 'b2'.repeat(32),
    MCP_ALLOWED_HOSTS: 'app.example.com', // required in production since ADR-0002
  };

  it('accepts a dedicated AI key', () => {
    expect(() => validateProductionConfig(base)).not.toThrow();
  });

  it.each([
    [
      'missing',
      { AI_CREDENTIAL_ENCRYPTION_KEY: undefined },
      'AI_CREDENTIAL_ENCRYPTION_KEY must be',
    ],
    [
      'malformed',
      { AI_CREDENTIAL_ENCRYPTION_KEY: 'short' },
      'AI_CREDENTIAL_ENCRYPTION_KEY must be',
    ],
    ['shared with Gmail', { AI_CREDENTIAL_ENCRYPTION_KEY: 'A1'.repeat(32) }, 'must differ'],
  ])('rejects a %s AI key', (_label, change, message) => {
    expect(() => validateProductionConfig({ ...base, ...change })).toThrow(message);
  });

  it.each([
    ['a hosted Gemini key', { GEMINI_API_KEY: 'x' }, 'GEMINI_API_KEY is no longer used'],
    [
      'a hosted model override',
      { GEMINI_EXTRACTION_MODEL: 'x' },
      'GEMINI_EXTRACTION_MODEL is no longer used',
    ],
    [
      'the old global limit',
      { AI_DAILY_CALL_LIMIT: '100' },
      'replaced by AI_USER_DAILY_CALL_LIMIT',
    ],
    ['an invalid per-user limit', { AI_USER_DAILY_CALL_LIMIT: '9000' }, 'from 0 to 5000'],
    ['a non-numeric per-user limit', { AI_USER_DAILY_CALL_LIMIT: '-1' }, 'from 0 to 5000'],
  ])('refuses to start with %s', (_label, change, message) => {
    expect(() => validateProductionConfig({ ...base, ...change })).toThrow(message);
  });

  it('accepts the per-user limit, including 0 as the kill switch', () => {
    expect(() =>
      validateProductionConfig({ ...base, AI_USER_DAILY_CALL_LIMIT: '0' }),
    ).not.toThrow();
    expect(() =>
      validateProductionConfig({ ...base, AI_USER_DAILY_CALL_LIMIT: '500' }),
    ).not.toThrow();
  });
});

describe('required startup secrets', () => {
  const valid = {
    GMAIL_TOKEN_ENCRYPTION_KEY: 'a1'.repeat(32),
    AI_CREDENTIAL_ENCRYPTION_KEY: 'b2'.repeat(32),
  };

  it('rejects a missing secret and names the variable', () => {
    expect(() =>
      validateRequiredSecrets({ ...valid, AI_CREDENTIAL_ENCRYPTION_KEY: undefined }),
    ).toThrow('AI_CREDENTIAL_ENCRYPTION_KEY is missing or not 64 hex characters');
  });

  it('rejects a malformed secret', () => {
    expect(() =>
      validateRequiredSecrets({ ...valid, GMAIL_TOKEN_ENCRYPTION_KEY: 'short' }),
    ).toThrow('GMAIL_TOKEN_ENCRYPTION_KEY is missing or not 64 hex characters');
  });

  it('rejects shared encryption keys', () => {
    expect(() =>
      validateRequiredSecrets({
        GMAIL_TOKEN_ENCRYPTION_KEY: 'a1'.repeat(32),
        AI_CREDENTIAL_ENCRYPTION_KEY: 'A1'.repeat(32),
      }),
    ).toThrow('AI_CREDENTIAL_ENCRYPTION_KEY must differ from GMAIL_TOKEN_ENCRYPTION_KEY');
  });
});
