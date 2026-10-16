import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import request from 'supertest';
import type { Express } from 'express';
import { beforeAll, expect, it } from 'vitest';
import { submissionDailyLimit } from '../utils/config';
import { PINNED_TEST_ENV } from './helpers/testEnv';

// A developer `.env` with values that would break tests. It is loaded the way both leaky loaders
// load the real one (no override), then the app is imported. The real `.env` is never touched.
const DEV_VALUES: Record<string, string> = {
  MCP_ALLOWED_HOSTS: 'localhost',
  MCP_ALLOWED_ORIGINS: 'evil.example',
  MCP_DAILY_SUBMISSION_LIMIT: '0',
  TRUST_PROXY_HOPS: '2',
  RELEVANCE_CONFIDENCE_THRESHOLD: '0.95',
  AGENDA_EXTRACTION_V3_ENABLED: 'true',
  LOG_LEVEL: 'debug',
};
const pinned = Object.keys(PINNED_TEST_ENV);
let before: Record<string, string | undefined>;
let app: Express;

beforeAll(async () => {
  before = Object.fromEntries(pinned.map((name) => [name, process.env[name]]));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dev-env-'));
  try {
    const file = path.join(folder, '.env');
    fs.writeFileSync(
      file,
      Object.entries(DEV_VALUES)
        .map(([name, value]) => `${name}=${value}\n`)
        .join(''),
    );
    dotenv.config({ path: file, quiet: true });
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
  app = (await import('../index')).app;
});

it('pins every name the dev file sets', () => {
  expect(Object.keys(DEV_VALUES).sort()).toEqual([...pinned].sort());
});

it('keeps the test value of every pinned name', () => {
  for (const name of pinned) {
    expect(before[name], name).toBeDefined();
    expect(process.env[name], name).toBe(before[name]);
  }
});

it('keeps the default daily submission limit and the localhost MCP allowlist', async () => {
  expect(submissionDailyLimit()).toBe(500);
  const res = await request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .send({});
  expect(res.status).toBe(401); // 403 would mean a dev Host allowlist leaked in
});
