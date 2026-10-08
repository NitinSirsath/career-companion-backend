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
