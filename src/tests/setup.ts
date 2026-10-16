import dotenv from 'dotenv';
import path from 'path';
import { assertTestDatabase } from '../utils/testDatabase';
import { pinTestEnv } from './helpers/testEnv';

// Load .env.test
const loaded = dotenv.config({
  path: path.resolve(__dirname, '../..', process.env.TEST_ENV_FILE || '.env.test'),
  override: true,
});
// For the pinned names `.env.test` wins, then the pinned value; a developer `.env` never does.
pinTestEnv(loaded.parsed ?? {});

assertTestDatabase(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
