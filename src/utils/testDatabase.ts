export function assertTestDatabase(databaseUrl: string | undefined, testUrl: string | undefined) {
  if (!testUrl || databaseUrl !== testUrl) {
    throw new Error('SAFETY GUARD: DATABASE_URL must equal explicit TEST_DATABASE_URL');
  }
  const url = new URL(testUrl);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !/^career_companion_[a-z0-9_]*test$/.test(database) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    [...url.searchParams.keys()].some((key) => key !== 'schema') ||
    (url.searchParams.has('schema') && url.searchParams.get('schema') !== 'public')
  ) {
    throw new Error(
      'SAFETY GUARD: tests require a dedicated local career_companion_*test database',
    );
  }
}
