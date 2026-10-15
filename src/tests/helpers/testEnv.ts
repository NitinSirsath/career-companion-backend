/**
 * Variables the code reads that `.env.test` does not set. A developer's backend `.env` is read
 * after the test setup by two loaders (`dotenv.config()` in `src/index.ts`, and the Prisma client
 * when it was generated while a `.env` existed). Neither replaces a variable that already
 * exists, so the setup gives each name a value: its `.env.test` value if it has one, else the
 * value below, which acts like the code default. Shell exports and the backend `.env` are
 * ignored for these names. When the code starts reading a new variable that `.env.test` does
 * not set, add it here.
 */
export const PINNED_TEST_ENV: Record<string, string> = {
  MCP_ALLOWED_HOSTS: '', // localhost, 127.0.0.1 and [::1]
  MCP_ALLOWED_ORIGINS: '', // no Origin allowed
  MCP_DAILY_SUBMISSION_LIMIT: '500',
  TRUST_PROXY_HOPS: '', // acts as unset
  RELEVANCE_CONFIDENCE_THRESHOLD: '0.7', // not '': Number('') is 0
  AGENDA_EXTRACTION_V3_ENABLED: '', // off
  LOG_LEVEL: '', // info
};

/** `fromEnvTest`: the values `.env.test` sets. The name must exist, even empty, to stay pinned. */
export function pinTestEnv(fromEnvTest: Record<string, string>) {
  for (const [name, value] of Object.entries(PINNED_TEST_ENV))
    process.env[name] = fromEnvTest[name] ?? value;
}
