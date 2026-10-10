# Backend Repository Guidance

This repository contains the Career Companion Node.js/Express/TypeScript backend.

Before changing API routes, API clients or API-facing behavior, read the canonical cross-cutting API contracts:
https://github.com/NitinSirsath/career-companion-docs/blob/main/docs/architecture/api-contracts.md

Feature-local requirements remain in the relevant feature specification and Linear issue.

Run the test suite with:
npm test   (runs `vitest run`)

## Logs

- Use `logEvent`, `logWarn`, `logError` and `logDebug` from `src/utils/log.ts`. Raw `console.*` fails lint.
- Log events, not data: IDs, counts and outcomes. Never API responses, request bodies, email content, keys or tokens.
- On a failure, pass the error as the third argument of `logError`, so the line shows what broke and where.
- Temporary debugging: `logDebug` (shown only with `LOG_LEVEL=debug`) or a file in the git-ignored `scratch/` folder. Never commit a `console.log`.

## Code standards (read before writing code)

Full standards, with a file to copy for each job:
https://github.com/NitinSirsath/career-companion-docs/blob/main/docs/engineering/code-standards.md

- Routes (`src/routes/`): validate input with the contract schema, call one service, send the result. No database queries in routes. Copy `routes/ai.ts`.
- Services (`src/services/`): business rules as plain exported functions. Don't add classes with static methods.
- Jobs (`src/jobs/`): register the pg-boss worker and call a service. No database queries in job files. Copy `jobs/notificationJob.ts`.
- Queueing: services put work on the queue with the `enqueue…` functions in `src/services/enqueue.ts`. They never import from `src/jobs/`; lint fails on it.
- Errors: for an expected failure (not found, conflict, not allowed, invalid), a service throws `AppError(status, code, message, details?)` from `src/errors.ts`, and `middleware/error.ts` sends it. Don't add error classes, and don't catch errors in routes to build a response. Gmail sync and AI provider errors stay as they are.
- Contracts: change `src/contracts/` here; the frontend copies them with `npm run sync-contracts`.
- Config: only `src/utils/config.ts` reads `process.env`. Add a getter there for a new variable.
- Build only what the ticket needs. No parameters only for tests (like `now = new Date()`); tests use `vi.setSystemTime()`.
- One home per rule or constant: search before writing a helper.
- No nested ternaries, no `any`, avoid `!`. Comments say why; no ticket IDs in code.
- Size is guidance: a function over ~80 lines or a file over ~500 lines is a sign to split. Explain exceptions in the PR.
- If code you must change breaks these standards, fix that part first in a separate refactor commit.
- Formatting: Prettier (`.prettierrc`). Run `npm run format` before committing; CI fails on unformatted code.
- Baseline: new violations fail lint. When you fix old code, run `npx eslint src/ scripts/ prisma/seed.ts --prune-suppressions` and commit the smaller file. Never add entries.
- Before "done": npm run typecheck && npm run lint && npm run format:check && npm test. List exceptions in the PR.
