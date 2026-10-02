# Career Companion Backend

This is the backend repository for Career Companion.

## Foundation

- Node.js
- Express
- TypeScript
- Zod
- PostgreSQL
- Prisma

## Setup

1. Make sure Node.js and Docker are installed.
2. Run `npm install` to install dependencies.
3. Ensure `.env` is created based on `.env.example`.

## Database Workflow (COM-12)

This project uses PostgreSQL via Docker Compose for local development.

**Start the database:**
```bash
npm run db:up
```

**Run migrations (creates tables):**
```bash
npm run db:migrate
```

**Generate Prisma Client (run after migrations or schema changes):**
```bash
npm run db:generate
```

**Run Development Seed (idempotent user creation):**
```bash
npm run db:seed
```

**Stop the database:**
```bash
npm run db:down
```

**Reset the database (drops all data and reapplies migrations):**
```bash
npm run db:reset
```

## Running the Server

Run `npm run dev` to start the development server.

## Scripts

- `npm run dev` - Start dev server with nodemon/ts-node-dev
- `npm run build` - Build for production using tsc
- `npm run lint` - Run ESLint
- `npm run format` - Run Prettier
- `npm run test` - Run Vitest (requires PostgreSQL to be running)

## Shared Contracts

The `src/contracts` directory contains Zod schemas and types that are shared with the frontend. The frontend repository pulls these files using its own sync script. Do not introduce breaking changes to these contracts without coordinating with the frontend.

## Stabilization and verification

See [STABILIZATION.md](STABILIZATION.md) for migration preflight, production configuration, recovery boundaries, and release verification. The stabilization API changes require the matching frontend release: Gmail sync returns `202 { accepted: true }`; application events and actions return paginated envelopes. All public lists default to and cap at 20 items.

Tests require a **separate local test database**, never the development database. Create an empty database named `career_companion_test` (or `career_companion_*test`). In ignored `.env.test`, set `DATABASE_URL` and `TEST_DATABASE_URL` to the exact same explicit URL for that database, plus development authentication and fixture-only signing/encryption secrets. The guard rejects remote hosts, development database names, URL overrides, and missing/mismatched test URLs before tests touch data. The suite deletes fixture data, so do not put real user records in this database.

Generate and build first (the guard is loaded from `dist`), then migrate the dedicated test database **only through the guarded runner**. It loads `.env.test` with override, requires it to match the independently exported `TEST_DATABASE_URL`, runs the safety guard, and only then spawns the Prisma CLI. A raw `prisma migrate deploy` is not guarded.

```bash
npm run db:generate
npm run typecheck
npm run lint
npm run build
TEST_DATABASE_URL="postgresql://…/career_companion_x_test" node scripts/guarded-migrate.cjs
npm test
```

`scripts/guarded-migrate.cjs` runs `migrate deploy`, `migrate status` and `validate` by default, or the Prisma arguments you pass. `TEST_ENV_FILE` selects another ignored env file (for example a separate smoke lane). Fresh/upgrade preservation lanes: `FRESH_DATABASE_URL=… UPGRADE_DATABASE_URL=… node scripts/verify-migration-preservation.cjs` (two separate, empty, local `career_companion_*test` databases; synthetic data only).

Vitest loads `.env.test` with override enabled; confirm it contains that same test URL. Do not use `db:reset` for verification. The frontend smoke script also enforces this database guard and requires both repositories to be built.

## Application API & Development Authentication (COM-13)

For Sprint 1 local development, this repository uses a **Development-Only Authentication Boundary**. 
This is a fallback for local testing. Google OAuth is the primary and fully-implemented mechanism for authentication.

### Making Authenticated Requests
To authenticate as the development user, you must include the `X-Development-User` header with the user's email (default seeded user: `dev@career-companion.local`) in your requests. Also ensure `ENABLE_DEV_AUTH=true` is set in your `.env`.

#### Example POST Request
```bash
curl -X POST http://localhost:3000/api/applications \
  -H "Content-Type: application/json" \
  -H "X-Development-User: dev@career-companion.local" \
  -d '{"companyName": "Acme Corp", "jobTitle": "Software Engineer"}'
```

#### Example GET Request
```bash
curl -X GET http://localhost:3000/api/applications \
  -H "X-Development-User: dev@career-companion.local"
```

### Error Response Shape
All API errors follow a consistent, typed shape to make it easier for clients to consume:
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request data",
    "details": [...]
  }
}
```
Standard error codes include `VALIDATION_ERROR`, `UNAUTHORIZED`, `NOT_FOUND`, `STATUS_CONFLICT` and `INTERNAL_SERVER_ERROR`. A 500 on a write means the outcome is uncertain; clients reconcile by reading.

### Application status and evidence (Sprint 6)

Every application response (create 201, list, detail, status PATCH) includes the stored `aiStatus`, `userStatus`, `userStatusSetAt`, `userStatusRevision` and derived `effectiveStatus` (`userStatus ?? aiStatus`), `statusSource` (`USER` | `AI` | `UNKNOWN`) and `hasStatusConflict`. `recentEvent` (or null) and each item of `GET /api/applications/:id/events` include `recordedAt` (ISO, same instant as `createdAt`) and `sourceEmail` (`{ id, subject, sender, receivedAt }` for an owned source email, else null). Events stay in recording order; email date is not an event occurrence time.

```bash
curl -X PATCH http://localhost:3000/api/applications/<id>/status \
  -H "Content-Type: application/json" \
  -H "X-Development-User: dev@career-companion.local" \
  -d '{"userStatus": "INTERVIEW", "expectedUserStatusRevision": 0}'
```

- Body is strict: exactly `userStatus` (one of the seven statuses, or `null` to clear) and `expectedUserStatusRevision` (non-negative integer). Any other field is 400 `VALIDATION_ERROR`.
- The revision is compared before no-op detection: a stale revision is 409 `STATUS_CONFLICT` even if the value already matches. A current same-value request returns 200 unchanged. A change or clear increments the revision once; clear also nulls `userStatusSetAt`.
- Missing and foreign applications return the same 404 `NOT_FOUND`. Never retry a PATCH automatically; after 409 or an uncertain result, read the application and let the user decide.
- Corrections never change `aiStatus`, events, actions, jobs, notifications or AI operation/budget records. AI processing never changes the manual fields.

### User-provided AI (ADR-0001)

Every AI call uses the session or job user's own provider key, from a curated code catalog (`src/contracts/aiCatalog.ts`, synced to the frontend). There is no server AI key. Providers stay `hidden`, so they are not offered in production, until they are certified (docs repo `docs/ai/provider-evaluation.md`).

| Endpoint | Purpose |
| --- | --- |
| `GET /api/ai/settings` | Status and configuration. It never includes the key in any form. |
| `PUT /api/ai/settings` | Create, replace key, change models or switch provider. Verifies first. 422 `AI_ACCESS_REJECTED` saves nothing. |
| `POST /api/ai/settings/check` | Re-verify the saved key ("Check again"). |
| `POST /api/ai/settings/sample-test` | Run both capabilities on a built-in synthetic email. |
| `DELETE /api/ai/settings` | Remove the configuration and its key. |
| `POST /api/emails/:id/retry` | Gains `{ acceptPossibleDuplicateCharge: true }` for approving one more attempt after 409 `AI_RETRY_NEEDS_APPROVAL`. |

**Configuration**
- New: `AI_CREDENTIAL_ENCRYPTION_KEY` (64 hex, different from the Gmail key) and `AI_USER_DAILY_CALL_LIMIT` (per user per day, default 500, 0 = pause).
- Removed: `GEMINI_*` and `AI_DAILY_CALL_LIMIT`.

See [STABILIZATION.md](STABILIZATION.md) for rollout and support.

**Code**
- `src/services/ai/`:
  - `contracts.ts`: provider-neutral prompts and schemas;
  - `providers/`: one adapter per protocol behind `createProviderClient`;
  - `access.ts`: per-user access resolution;
  - `operations.ts`: the ledger;
  - `usage.ts`: safety limit, counts, cooldown;
  - `credentials.ts`: key sealing;
  - `settings.ts`: the settings API.
- `src/eval/ai/`: the manual evaluation runner (`npm run ai:eval`). See its README.

**Tests:** tests use fake provider clients and fixture keys only. Real keys are used only in supervised evaluation and release runs.

### Automation submissions through MCP (ADR-0002)

The user's own job-application automation (an AI agent that is an MCP client) reports each confirmed submission to Career Companion. Career Companion never applies to jobs and never reads the user's machine.

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /mcp` | `Authorization: Bearer ccmcp_…` integration token only | Streamable HTTP MCP server with one write-only, idempotent tool, `record_application_submission`. GET/DELETE → 405. |
| `POST /api/integration-tokens` | session | Create a token (`{ name, expiresInDays? }`, default 90, max 365, at most 5 active). The only response that carries the plaintext. |
| `GET /api/integration-tokens` | session | List (offset envelope), with `status: active \| expired \| revoked`; never the hash or plaintext. |
| `DELETE /api/integration-tokens/:id` | session | Revoke at once; the row is kept. |
| `GET /api/submissions/pending` | session | Submissions that need review (offset envelope). |
| `POST /api/submissions/:id/resolve` | session | `{ action: "link", applicationId } \| { action: "create" } \| { action: "ignore" }`. Final. 404 / 400 / 403 like the email resolve route. |

Tool results (`structuredContent`): `{ result: created | linked | needs_review | already_recorded, recordId }`. Tool errors (`isError`, JSON text): `invalid_input` with field names (do not retry), `rate_limited` (next UTC day), `unavailable` (later). Bad, expired or revoked tokens get HTTP 401 before any MCP processing.

**Configuration** (also in `.env.example`; production checks in `validateProductionConfig`):
- `MCP_ALLOWED_HOSTS`: hostnames (no scheme or port) the `Host` header may name. Defaults to localhost outside production; production refuses to start without it.
- `MCP_ALLOWED_ORIGINS`: hostnames a present `Origin` may name. Default empty (any `Origin` rejected; none passes).
- `MCP_DAILY_SUBMISSION_LIMIT`: new submissions per user per UTC day, 0–5000, default 500; 0 stops new submissions.

**Code**
- `src/mcp/`: `router.ts` (mounted first in `index.ts`, before CORS/JSON/cookies/session; 32 KB body limit; Host/Origin/Bearer checks; one `mcp_request` log line per request), `server.ts` (tool, portable advertised schema, error mapping), `config.ts`, `callLog.ts`. Built on `@modelcontextprotocol/server` 2.2.0 and `/node` 2.1.0 (pinned). `@modelcontextprotocol/express` is deliberately not used: it re-types `req.auth` app-wide.
- `src/services/integrationTokens.ts`, `src/services/externalSubmission.ts` (strict schema, URL canonicalization, matching, per-user advisory lock, review).
- Migration `20261002150000_automation_submissions` (additive, with ownership triggers). Lanes: `npm run build && FRESH_DATABASE_URL=… UPGRADE_DATABASE_URL=… node scripts/verify-mcp-migration.cjs`.
- Client check against a running server (official SDK client; token from the environment, never printed): `CC_MCP_TOKEN=… node scripts/mcp-client-check.cjs http://localhost:3000/mcp [--send-fixture <json>]`.

**Tests:** `mcp-data-model`, `integration-tokens`, `external-submission`, `mcp-endpoint` (official SDK client against the real app), `mcp-config`, `submission-review`, `application-submission-evidence`. The SDK client (`@modelcontextprotocol/client` 2.2.0) is a dev dependency.

### Worker readiness

Workers retry registration with bounded backoff (about two minutes of waits, plus connection timeouts), then exit with code 1 if they cannot start. Start PostgreSQL first; restart the backend after an exhausted startup (`npm run dev` otherwise waits for a file change). `GET /health` is HTTP liveness only. `curl -i http://localhost:3000/ready` returns 200 only when every worker is registered, and 503 during startup or when a registration is missing. Readiness uses in-memory registration state; it does not prove ongoing database/provider health.

### Automatic Gmail sync (Sprint 7)

With the backend running, connected accounts sync at 00:00 and 18:00 in
`GMAIL_SCHEDULED_SYNC_TZ` (default `Asia/Kolkata`). Startup checks for a missed slot;
pg-boss also catches a missed slot after suspension. Successful/recent and busy
accounts are skipped. Set `GMAIL_SCHEDULED_SYNC_ENABLED=false` and restart to
remove the durable schedule before rolling back scheduling code. Status reports
`nextScheduledSyncAt` only after local schedule registration. Real two-day
Gmail observation remains pending; automated checks use fixture mail.
