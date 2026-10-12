import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parse } from 'dotenv';
import request from 'supertest';
import { app } from '../index';
import { AppModeResponseSchema } from '../contracts/appMode';
import {
  appMode,
  databaseName,
  devMode,
  isDevDatabase,
  isTestDatabase,
  parseAPP_MODE,
  validateProductionConfig,
} from '../utils/config';

const DEV_DB = 'postgresql://u:p@localhost:5432/career_companion_dev?schema=public';
const TEST_DB = 'postgresql://u:p@localhost:5432/career_companion_ci_test?schema=public';
const LIVE_DB = 'postgresql://u:p@db.internal:5432/career_companion_db?schema=public';

const envFile = (name: string) =>
  parse(fs.readFileSync(path.resolve(__dirname, '../..', name), 'utf8'));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('app mode setting', () => {
  it('accepts only empty, prod or dev', () => {
    expect(parseAPP_MODE(undefined)).toBe('prod');
    expect(parseAPP_MODE('')).toBe('prod');
    expect(parseAPP_MODE('prod')).toBe('prod');
    expect(parseAPP_MODE('dev')).toBe('dev');
    expect(() => parseAPP_MODE('development')).toThrow('APP_MODE must be');
    expect(() => parseAPP_MODE('true')).toThrow('APP_MODE must be');
  });

  it('knows the dev database by a name that ends in _dev, from a URL written out in full', () => {
    expect(databaseName(DEV_DB)).toBe('career_companion_dev');
    expect(isDevDatabase(DEV_DB)).toBe(true);
    expect(isDevDatabase(LIVE_DB)).toBe(false);
    expect(isDevDatabase(TEST_DB)).toBe(false);
    expect(isDevDatabase('postgresql://u:p@localhost:5432/dev_career_companion')).toBe(false);
    expect(isDevDatabase('postgresql://u:p@localhost:5432/career_companion_devdata')).toBe(false);
    expect(
      databaseName('postgresql://${POSTGRES_USER}:x@localhost:${POSTGRES_PORT}/${POSTGRES_DB}'),
    ).toBeNull();
    expect(isDevDatabase(undefined)).toBe(false);
    // The automated-test database is never the dev database, so `npm test` cannot wipe it.
    expect(isTestDatabase(DEV_DB)).toBe(false);
  });
});

describe('app mode at startup', () => {
  it('starts dev mode only on the dev database', () => {
    expect(() => validateProductionConfig({ APP_MODE: 'dev', DATABASE_URL: DEV_DB })).not.toThrow();
    for (const DATABASE_URL of [LIVE_DB, TEST_DB, undefined])
      expect(() => validateProductionConfig({ APP_MODE: 'dev', DATABASE_URL })).toThrow(
        'ends in "_dev"',
      );
  });

  it('never starts dev mode in production', () => {
    expect(() =>
      validateProductionConfig({ APP_MODE: 'dev', DATABASE_URL: DEV_DB, NODE_ENV: 'production' }),
    ).toThrow('APP_MODE=dev is forbidden with NODE_ENV=production');
  });

  it('never starts prod mode on the dev database', () => {
    expect(() => validateProductionConfig({ DATABASE_URL: DEV_DB })).toThrow('belongs to dev mode');
    expect(() => validateProductionConfig({ APP_MODE: 'prod', DATABASE_URL: DEV_DB })).toThrow(
      'belongs to dev mode',
    );
    expect(() => validateProductionConfig({ DATABASE_URL: LIVE_DB })).not.toThrow();
  });

  it('refuses an unknown value and the replaced test-tools flag', () => {
    expect(() => validateProductionConfig({ APP_MODE: 'yes', DATABASE_URL: DEV_DB })).toThrow(
      'APP_MODE must be',
    );
    expect(() =>
      validateProductionConfig({ TEST_TOOLS_ENABLED: 'true', DATABASE_URL: LIVE_DB }),
    ).toThrow('replaced by APP_MODE=dev');
  });

  it('lets automated tests run dev mode on their fixture database only', () => {
    expect(() =>
      validateProductionConfig({ NODE_ENV: 'test', APP_MODE: 'dev', DATABASE_URL: TEST_DB }),
    ).not.toThrow();
    expect(() =>
      validateProductionConfig({ NODE_ENV: 'test', APP_MODE: 'dev', DATABASE_URL: LIVE_DB }),
    ).toThrow('ends in "_dev"');
  });
});

describe('app mode at run time', () => {
  it('is dev only with the setting, the dev database and no production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DATABASE_URL', DEV_DB);
    vi.stubEnv('APP_MODE', 'dev');
    expect(devMode()).toBe(true);
    expect(appMode()).toBe('dev');
    vi.stubEnv('APP_MODE', '');
    expect(devMode()).toBe(false);
    expect(appMode()).toBe('prod');
    vi.stubEnv('APP_MODE', 'yes');
    expect(devMode()).toBe(false);
    vi.stubEnv('APP_MODE', 'dev');
    vi.stubEnv('DATABASE_URL', LIVE_DB);
    expect(devMode()).toBe(false);
    vi.stubEnv('DATABASE_URL', DEV_DB);
    vi.stubEnv('NODE_ENV', 'production');
    expect(devMode()).toBe(false);
  });

  it('tells the mode to anyone, and nothing else', async () => {
    const prod = await request(app).get('/api/app-mode');
    expect(prod.status).toBe(200);
    expect(prod.headers['cache-control']).toBe('no-store');
    expect(prod.body).toEqual({ mode: 'prod' });
    vi.stubEnv('APP_MODE', 'dev');
    const dev = await request(app).get('/api/app-mode');
    expect(AppModeResponseSchema.parse(dev.body)).toEqual({ mode: 'dev' });
  });
});

describe('env files', () => {
  const prod = envFile('.env.example');
  const dev = envFile('.env.dev.example');

  it('the dev file is a complete dev-mode setup with no Google key', () => {
    expect(dev.APP_MODE).toBe('dev');
    expect(() => validateProductionConfig(dev)).not.toThrow();
    for (const name of [
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'GMAIL_CLIENT_ID',
      'GMAIL_CLIENT_SECRET',
    ])
      expect(dev[name]).toBe('');
  });

  it('the dev file sets every setting of the prod file, so nothing leaks in from .env', () => {
    const missing = Object.keys(prod).filter(
      (name) => !name.startsWith('POSTGRES_') && !(name in dev),
    );
    expect(missing).toEqual([]);
  });

  it('the prod file is for prod mode and no longer names the test-tools flag', () => {
    expect(parseAPP_MODE(prod.APP_MODE)).toBe('prod');
    expect('TEST_TOOLS_ENABLED' in prod).toBe(false);
  });
});
