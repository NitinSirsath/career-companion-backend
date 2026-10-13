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
- `npm run devmode` - Set up and start dev mode (see "Dev mode" below)
- `npm run build` - Build for production using tsc
- `npm run lint` - Run ESLint
- `npm run format` - Run Prettier
- `npm run test` - Run Vitest (requires PostgreSQL to be running)

## Shared Contracts

The `src/contracts` directory contains Zod schemas and types that are shared with the frontend. The frontend repository pulls these files using its own sync script. Do not introduce breaking changes to these contracts without coordinating with the frontend.

## Stabilization and verification

See [STABILIZATION.md](STABILIZATION.md) for migration preflight, production configuration, recovery boundaries, and release verification. The stabilization API changes require the matching frontend release: Gmail sync returns `202 { accepted: true }`; application events and actions return paginated envelopes. All public lists default to and cap at 20 items.

Tests require a **separate local test database**, never the development database. Create an empty database named `career_companion_test` (or `career_companion_*test`). In ignored `.env.test`, set `DATABASE_URL` and `TEST_DATABASE_URL` to the exact same explicit URL for that database, plus test-only development authentication and fixture-only signing/encryption secrets. The guard rejects remote hosts, development database names, URL overrides, and missing/mismatched test URLs before tests touch data. The suite deletes fixture data, so do not put real user records in this database.

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

Local development uses **Google OAuth** for authentication. Copy `.env.example` to `.env`, set the Google OAuth variables in `.env`, and log in through the application before calling protected API routes.

The `X-Development-User` header is retained only for automated tests. It works only when both `NODE_ENV=test` and `ENABLE_DEV_AUTH=true`; it is ignored in local development and production.

### Sign-in with email and password

Next to Google sign-in, a user can sign in with email and password.

- `POST /api/auth/login` `{ email, password }` starts the same session as Google sign-in, under a fresh session ID, and answers the user profile. A wrong password, an unknown email and a user with no password all get the same 401 `INVALID_CREDENTIALS` ("Email or password is wrong.").
- `POST /api/auth/password` `{ currentPassword?, newPassword }` (signed in) sets the first password or changes it. A user with a password must send the current one (403 `WRONG_PASSWORD` otherwise). A change signs the user out of every other session.
- `POST /api/auth/register` `{ email, password, name? }` creates a user: **dev mode only**, 404 in prod mode. In prod mode a user is created only by Google sign-in, so every prod email is one Google has confirmed.
- `GET /api/auth/me` also says `hasPassword` and `hasGoogle`.
- In dev mode Google sign-in is off: `/api/auth/connect` and `/api/auth/callback` answer 404.
- **Passwords:** 10 to 200 characters, stored only as a salted scrypt hash (`utils/passwordHash.ts`), never logged or returned.
- **Guessing limit:** 5 wrong tries for one email within 15 minutes block that email, and 20 wrong tries from one network address block that address, until the tries are 15 minutes old (429 `TOO_MANY_ATTEMPTS` with `details.retryAfterSeconds`). A good sign-in clears the email's wrong tries. Behind a proxy, set `TRUST_PROXY_HOPS` so the address is the client's.
- **Forgot password:** the app sends no email. In prod mode, sign in with Google and set a new password. In dev mode, create another test user.

### Making Authenticated Requests
API calls to protected routes need a logged-in session cookie. For local development, authenticate with Google first and send the resulting `cc_session` cookie with API requests.

#### Example POST Request
```bash
curl -X POST http://localhost:3000/api/applications \
  -H "Content-Type: application/json" \
  -H "Cookie: cc_session=<logged-in-session-cookie>" \
  -d '{"companyName": "Acme Corp", "jobTitle": "Software Engineer"}'
```

#### Example GET Request
```bash
curl -X GET http://localhost:3000/api/applications \
  -H "Cookie: cc_session=<logged-in-session-cookie>"
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
  -H "Cookie: cc_session=<logged-in-session-cookie>" \
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
| `POST /api/ai/waiting/read` | "Read waiting mails now": end a running pause and offer the waiting mail again. Answers with the AI settings. |
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
  - `offer.ts`: offers waiting mail to the worker, also by itself when a pause ends (`ai-resume-job`);
  - `waiting.ts`: "Read waiting mails now";
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

### Correcting email links (Sprint 8)

`PATCH /api/emails/:id/match` accepts an owned target application (or null to
unlink), expectedMatchState and expectedApplicationId. It returns the canonical
email link and affected application IDs. Stale links return MATCH_CONFLICT (409).
Old effects are retired, not deleted; user status overrides stay intact. Retired
action updates return ACTION_RETIRED (409). Gmail message responses expose the
owned application link/source and a computed processingStuck flag; timestamps and
credentials remain private. Unlink keeps future thread mail for manual review.


### Batched initial relevance triage (COM-125)

AI_TRIAGE_BATCH_ENABLED is **off by default**. Unset, empty, or false means off; exactly true enables batched relevance triage. Any other value is rejected at startup. AI_TRIAGE_BATCH_SIZE defaults to 20 and accepts 1–25.

When enabled, new unclassified emails are grouped into per-user triage jobs. The batch contract only sends bounded sender, subject, labels and preview metadata plus per-batch keys; no Gmail or database IDs are sent to the provider. The existing per-email extraction and matching path remains unchanged.

### Sending a reply from the mail details page

`POST /api/mailbox/threads/:threadId/replies` with `{ "replyId": "<uuid>", "text": "…" }` sends a plain-text reply into that Gmail thread, from the user's own Gmail (`services/mailReply.ts`).

- **Permission:** connecting Gmail asks Google for `gmail.readonly` and `gmail.send`. `gmail_connections.canSend` holds what Google really granted, and `GET /api/gmail/status` reports it as `canSend`. A connection made before this change may only read: the send call answers 403 `GMAIL_SEND_NOT_ALLOWED` until the user connects again. `GET /api/gmail/connect?returnTo=/mails/<key>` returns to that mail afterwards. **Add the scope `gmail.send` on the OAuth consent screen of the Google Cloud project.**
- **Who it goes to:** worked out from the thread (`replyTarget` in `services/mailbox.ts`): the newest mail from someone else, its `Reply-To` when it has one. The request carries no address. `GET /api/mailbox/threads/:threadId` reports it as `replyTo`.
- **To everyone on the mail:** with `"toAll": true` the reply also goes, in Cc, to the other people on the answered mail: its To and Cc addresses, each once, without the user's own address and without `replyTo`. The thread read reports them as `replyCc` (empty when nobody else is on the mail). Left out or `false`, the reply goes only to `replyTo`. The request still names no address.
- **Sent once:** the page makes one `replyId` for each reply. It is written to `mail_replies` before the send call, and the same ID is answered from that row without sending. A clear "no" from Gmail (4xx) frees the ID. No answer (5xx, timeout, lost connection) is 502 `MAIL_REPLY_UNCONFIRMED`: the ID stays taken, and the app never sends again by itself.
- **Replied at once:** in a conversation the app holds, the sent message is noted in `outgoing_emails` right away, as the sync does for a reply written in Gmail.
- **Privacy:** the text goes to Gmail and is not stored or logged. `mail_replies` holds IDs and times only.
- **Dev mode:** the same code runs. The sandbox mailbox answers Gmail's send call and keeps the mail in its Sent folder; no real mail is sent.
- **Logs:** `mail_reply_sent`, `mail_reply_not_sent` (`outcome` = the error code), `mail_reply_not_recorded` (the mail went out but its note could not be written; the next sync notes it).

### Dev mode (`APP_MODE=dev`)

One setting switches the app: `APP_MODE=prod` (the default, also when empty) or `APP_MODE=dev`. Dev mode is for manual testing with made-up mail, without a second account or live data. Only the emails are made up: they are read by the AI provider the test user connects, with a real key.

- **One command:** `npm run devmode`. On first run it makes `.env.dev` from `.env.dev.example` and fills in the four secrets. Every run it creates the dev database when it is missing, brings it to the latest structure (`prisma migrate deploy`) and starts the backend. It never deletes data. No Google or Gmail key is needed.
- **Two env files:** `.env` is prod mode (see `.env.example`), `.env.dev` is dev mode. `.env.dev` lists every setting, so nothing is taken from `.env`. To switch mode, start with `npm run dev` or `npm run devmode`.
- **Database rule:** dev mode starts only when `DATABASE_URL` is written out in full (no `${...}`) and its database name ends in `_dev`, for example `career_companion_dev`. Prod mode refuses a database whose name ends in `_dev`. Automated tests keep their `test` databases, so `npm test` can never wipe the dev database. All three use the same schema and migrations.
- **Never in production:** `APP_MODE=dev` with `NODE_ENV=production` stops startup. The checks run again on every use, so changing the environment at run time cannot get around them.
- `GET /api/app-mode` (public) answers `{ "mode": "dev" | "prod" }`. The frontend reads it; it has no mode setting of its own.
- `TEST_TOOLS_ENABLED` and the old test inbox (`/api/test-tools`) are gone: `TEST_TOOLS_ENABLED=true` stops startup with a pointer to `APP_MODE=dev`, and a migration drops `simulated_email_contents` and the made-up `sim-` rows.

#### Mail sandbox

In dev mode every user has a **sandbox mailbox** that stands in for their Gmail account. No Google account or key is used, and nothing ever leaves the app.

- **Send, then sync.** `POST /api/sandbox/messages` puts a mail from any typed address in the user's sandbox inbox. It writes only to `sandbox_messages`. The mail reaches the app when a sync pulls it, with the same code as real Gmail mail: manual sync, scheduled sync, the look-back window, the history checkpoint, "new mails only" and the noting of the user's replies all run unchanged (`services/gmailSync.ts` is not touched).
- **How:** every Gmail call goes through `withGmail` (`services/gmailClient.ts`). In dev mode it hands the caller `services/sandbox/gmail.ts`, which answers the calls the app makes (`getProfile`, `messages.list|get|send`, `history.list`, `threads.list|get`, `labels.list`, `attachments.get`) from the sandbox tables in Gmail's own response shapes. No Google client is built in dev mode. A test fails when the app starts to make a Gmail call the sandbox does not answer.
- **Same shape as Gmail:** a sandbox message has Gmail-style IDs, a history number, labels (`INBOX` + `CATEGORY_PERSONAL`, or `SENT`), the usual headers, and its text as a plain part and an HTML part (`services/sandbox/message.ts`). A reply quotes the mail it answers.
- **Connect:** in dev mode `GET /api/gmail/connect` connects the sandbox mailbox at once and returns to the Gmail page. `/api/gmail/callback` answers 404. Disconnect calls nothing at Google.
- **API** (`/api/sandbox`, 404 before login in prod mode): `GET /threads?folder=inbox|sent`, `GET /threads/:id` (both sides with text and what the app did with each mail), `POST /messages` (new mail to the user; an optional `cc` line puts up to 10 other people on it, so a reply to all can be tried), `POST /threads/:id/replies` (`as: "me" | "them"`; when the other person writes again, the people in Cc stay on the mail), `GET /senders` (addresses used before), `POST /reset` (`{ "confirm": "RESET" }`: empties the mailbox and what the app made from it, keeps the user, the AI settings and the connection).
- **What the app did** with a mail is one of: `NOT_SYNCED`, `WAITING_FOR_AI`, `AI_KEY_MISSING`, `AI_FAILED`, `NOT_JOB_MAIL`, `JOB_MAIL`, and for the user's own mail `REPLY_RECORDED`. Nothing is ever filled in for the AI: with no AI key a synced mail waits and says `AI_KEY_MISSING`.
- Of the user's own sandbox mail the app keeps what it keeps in prod: message ID, thread ID and sent time. The text stays in the sandbox.


