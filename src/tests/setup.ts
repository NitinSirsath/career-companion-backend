import dotenv from 'dotenv';
import path from 'path';
import { assertTestDatabase } from '../utils/testDatabase';

// Load .env.test
dotenv.config({ path: path.resolve(__dirname, '../../.env.test'), override: true });

assertTestDatabase(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
