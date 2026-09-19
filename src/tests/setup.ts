import dotenv from 'dotenv';
import path from 'path';

// Load .env.test
dotenv.config({ path: path.resolve(__dirname, '../../.env.test'), override: true });

if (!process.env.DATABASE_URL?.includes('test')) {
  throw new Error('SAFETY GUARD: DATABASE_URL does not contain "test". Refusing to run tests against potentially real database.');
}
