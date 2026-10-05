#!/bin/bash
export TEST_DATABASE_URL="postgres://postgres:postgres@localhost:5432/career_companion_local_crash_test?schema=public"
printf 'DATABASE_URL=%s\nTEST_DATABASE_URL=%s\n' "$TEST_DATABASE_URL" "$TEST_DATABASE_URL" > .env.crash.test
npx prisma migrate reset --force --skip-seed
cat scripts/test-gmail-crash.cjs | sed "s/catch(() => {/catch((err) => {/" | sed "s/console.error('Crash fixture failed; inspect the dedicated database before reuse.');/console.error('Crash fixture failed', err);/" > scripts/test-gmail-crash-debug.cjs
node scripts/test-gmail-crash-debug.cjs
node scripts/test-gmail-crash-debug.cjs
