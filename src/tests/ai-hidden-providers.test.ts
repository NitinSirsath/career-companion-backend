import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_CATALOG, type CatalogProvider } from '../contracts/aiCatalog';
import { isOffered, offeredProvider } from '../services/ai/access';
import {
  parseAI_SHOW_HIDDEN_PROVIDERS,
  startupWarnings,
  validateProductionConfig,
} from '../utils/config';

const hidden = AI_CATALOG.find((provider) => provider.status === 'hidden')!;
const supported: CatalogProvider = { ...hidden, status: 'supported' };
const WARNING =
  'AI_SHOW_HIDDEN_PROVIDERS is on: uncertified AI providers are offered. Test deploys only.';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AI_SHOW_HIDDEN_PROVIDERS setting', () => {
  it('is off when empty, on only for true', () => {
    expect(parseAI_SHOW_HIDDEN_PROVIDERS(undefined)).toBe(false);
    expect(parseAI_SHOW_HIDDEN_PROVIDERS('')).toBe(false);
    expect(parseAI_SHOW_HIDDEN_PROVIDERS('true')).toBe(true);
  });

  it('stops startup on any other value', () => {
    for (const value of ['false', 'TRUE', '1', 'yes'])
      expect(() => parseAI_SHOW_HIDDEN_PROVIDERS(value)).toThrow(
        'AI_SHOW_HIDDEN_PROVIDERS must be empty or true',
      );
    expect(() => validateProductionConfig({ AI_SHOW_HIDDEN_PROVIDERS: 'yes' })).toThrow(
      'AI_SHOW_HIDDEN_PROVIDERS must be empty or true',
    );
  });
});

describe('providers offered in production', () => {
  it('are only the supported ones by default', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AI_SHOW_HIDDEN_PROVIDERS', '');
    expect(isOffered(hidden)).toBe(false);
    expect(isOffered(supported)).toBe(true);
    expect(offeredProvider(hidden.id)).toBeUndefined();
  });

  it('include the hidden ones on a test deploy that sets the switch', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AI_SHOW_HIDDEN_PROVIDERS', 'true');
    expect(isOffered(hidden)).toBe(true);
    expect(offeredProvider(hidden.id)?.id).toBe(hidden.id);
    // Every provider but the free AI, which needs its own key on the server.
    expect(AI_CATALOG.filter(isOffered)).toHaveLength(AI_CATALOG.length - 1);
  });

  it('are all of them outside production, with or without the switch', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AI_SHOW_HIDDEN_PROVIDERS', '');
    expect(isOffered(hidden)).toBe(true);
  });
});

describe('startup warning', () => {
  it('names the switch while it is on in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AI_SHOW_HIDDEN_PROVIDERS', 'true');
    expect(startupWarnings()).toContain(WARNING);
  });

  it('stays quiet when it is off, and outside production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AI_SHOW_HIDDEN_PROVIDERS', '');
    expect(startupWarnings()).not.toContain(WARNING);
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AI_SHOW_HIDDEN_PROVIDERS', 'true');
    expect(startupWarnings()).not.toContain(WARNING);
  });
});
