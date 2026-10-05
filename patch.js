const fs = require('fs');
let yml = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
yml = yml.replace(
  '          node scripts/test-gmail-crash.cjs\n          node scripts/test-gmail-crash.cjs',
  '          node scripts/test-gmail-crash.cjs\n          docker exec "$POSTGRES_CONTAINER" dropdb -U cc_ci career_companion_ci_crash_test\n          docker exec "$POSTGRES_CONTAINER" createdb -U cc_ci career_companion_ci_crash_test\n          node scripts/test-gmail-crash.cjs'
);
fs.writeFileSync('.github/workflows/ci.yml', yml);
