import dotenv from 'dotenv';
import path from 'path';
import { assertTestDatabase } from '../utils/testDatabase';

// Load .env.test
dotenv.config({
  path: path.resolve(__dirname, '../..', process.env.TEST_ENV_FILE || '.env.test'),
  override: true,
});

assertTestDatabase(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
