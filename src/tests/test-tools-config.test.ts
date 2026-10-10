import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  databaseName,
  isTestDatabase,
  parseTEST_TOOLS_ENABLED,
  testToolsEnabled,
  validateProductionConfig,
} from '../utils/config';

const TEST_DB = 'postgresql://u:p@localhost:5432/career_companion_testenv?schema=public';
const LIVE_DB = 'postgresql://u:p@db.internal:5432/career_companion_db?schema=public';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('test tools configuration', () => {
  it('accepts only empty, false or true', () => {
    expect(parseTEST_TOOLS_ENABLED(undefined)).toBe(false);
    expect(parseTEST_TOOLS_ENABLED('')).toBe(false);
    expect(parseTEST_TOOLS_ENABLED('false')).toBe(false);
    expect(parseTEST_TOOLS_ENABLED('true')).toBe(true);
    expect(() => parseTEST_TOOLS_ENABLED('yes')).toThrow('TEST_TOOLS_ENABLED');
  });

  it('reads the database name only from a URL written out in full', () => {
    expect(databaseName(TEST_DB)).toBe('career_companion_testenv');
    expect(
      databaseName('postgresql://${POSTGRES_USER}:x@localhost:${POSTGRES_PORT}/${POSTGRES_DB}'),
    ).toBeNull();
    expect(databaseName(undefined)).toBeNull();
    expect(isTestDatabase(TEST_DB)).toBe(true);
    expect(isTestDatabase(LIVE_DB)).toBe(false);
  });

  it('refuses to start with test tools on a database whose name has no "test"', () => {
    expect(() =>
      validateProductionConfig({ TEST_TOOLS_ENABLED: 'true', DATABASE_URL: LIVE_DB }),
    ).toThrow('contains "test"');
    expect(() => validateProductionConfig({ TEST_TOOLS_ENABLED: 'true' })).toThrow(
      'contains "test"',
    );
    expect(() =>
      validateProductionConfig({ TEST_TOOLS_ENABLED: 'true', DATABASE_URL: TEST_DB }),
    ).not.toThrow();
    expect(() => validateProductionConfig({ DATABASE_URL: LIVE_DB })).not.toThrow();
  });

  it('refuses to start with an unknown flag value', () => {
    expect(() =>
      validateProductionConfig({ TEST_TOOLS_ENABLED: 'yes', DATABASE_URL: TEST_DB }),
    ).toThrow('TEST_TOOLS_ENABLED must be');
  });

  it('is on only with the flag and a test database', () => {
    vi.stubEnv('DATABASE_URL', TEST_DB);
    vi.stubEnv('TEST_TOOLS_ENABLED', 'true');
    expect(testToolsEnabled()).toBe(true);
    vi.stubEnv('TEST_TOOLS_ENABLED', '');
    expect(testToolsEnabled()).toBe(false);
    vi.stubEnv('TEST_TOOLS_ENABLED', 'yes');
    expect(testToolsEnabled()).toBe(false);
    vi.stubEnv('TEST_TOOLS_ENABLED', 'true');
    vi.stubEnv('DATABASE_URL', LIVE_DB);
    expect(testToolsEnabled()).toBe(false);
  });
});
