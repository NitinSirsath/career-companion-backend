# Stabilization release and recovery

## Release boundary

Deploy the matching backend and frontend together. `POST /api/gmail/sync` now queues work and returns `202 { accepted: true }`. `GET /api/applications/:id` is independently scoped; events/actions sublists use `{ items, metadata: { limit, offset, nextOffset } }`. All seven public lists default to and cap at 20. There is no total-count promise. Ordering has an ID tie-breaker; action lists put pending work first. Offset pagination is not a snapshot during concurrent writes. No new search/filter semantics were added.

1. Back up the deployment database and run the preflight queries below against a restored copy first. Review duplicates and cross-owner records individually; migrations must not discard user decisions.
2. Stop and drain **all old API/worker processes**. Mixed old workers bypass the new AI claim boundary. Do not roll back to old workers after new processing starts.
3. Set production configuration below, starting with `AI_DAILY_CALL_LIMIT=0` and Discord delivery disabled. This is an operational rollout choice; the normal default is 100 calls/day.
4. Run `npx prisma migrate deploy` and `npx prisma generate`. The two new migrations add operation/budget records, sync leases, notification claims, domain uniqueness, and ownership triggers. Both run in transactions. Prisma schema diff does not inspect trigger bodies; integration tests cover their behavior.
5. Deploy the coordinated frontend/backend, verify health, Google sign-in/session persistence through the actual proxy, reconnect the same Gmail account, then run a supervised sync. Inspect job, sync, and AI operation state before enabling a small nonzero AI budget. Existing completed AI results must generate no new provider requests.
6. Verify one intentionally new email through classification/extraction/matching/action creation, with an agreed spend limit; repeat sync to verify no new AI calls. Verify Discord only for the configured owner. Live provider verification was not performed by the isolated audit tests.

If a migration fails, keep workers stopped. Reconcile the identified records with their owner, confirm transaction rollback, then use Prisma's failed-migration recovery procedure (`migrate resolve --rolled-back <failed migration>` followed by `migrate deploy`). Do not mark an unapplied migration as applied. Prisma may report only an aborted transaction for an index failure; inspect the preflight results and database migration error before resolving it.

## Sprint 6 rollout and rollback (2026-10-02)

- `20261002090000_add_user_status_revision` adds `applications."userStatusRevision" INTEGER NOT NULL DEFAULT 0`. It is additive: existing rows get 0 and no stored status, timestamp, ID, owner, event, action or AI record changes. Verified on a guarded synthetic upgrade lane (~1,620 emails, 72 applications including legacy user statuses with unknown confirmation time, events/actions/completed AI operations): all pre-existing rows identical after upgrade (equal SHA-256 digests of the JSON-serialized rows) and trigger/unique-index names unchanged, cross-owner links/duplicate effects/owner changes still rejected. This is synthetic evidence, not the preserved user dataset.
- Deploy the backend (migration + API) before the frontend: the new client requires the new response fields and shows a contract error against an older backend instead of guessing.
- Rollback: keep the column and stored corrections. Disable the editor if needed, but keep canonical user-over-AI reads; do not restore AI-first display or delete user decisions. There is no destructive down migration.
- S6-03 delivery: the email worker registers `{ includeMetadata: true, batchSize: 1 }` (installed pg-boss 12.31.0 already defaults to 1) and rejects unexpected multi-job deliveries so every delivered job is retried rather than silently acknowledged. Each job logs an attributable outcome (`completed`, `retry_scheduled`, `failed_terminal`, `failed_exhausted`); the final permitted failure marks the email FAILED. Verified through installed pg-boss on a guarded lane. Matching: a user link whose pre-lock read was overtaken by a completed automatic match previously re-linked the email and left effects on two applications; `applyMatch` now re-checks match state under the email lock and rejects it exactly as the sequential path does. Distinct-email, duplicate, stale-automatic-selection, ambiguity and competing-resolution interleavings are covered in `src/tests/matching-concurrency.test.ts`. Known limit retained: a hard kill during the final email attempt can leave an email PROCESSING for operator review.
- Manual email retry no longer deletes AI operation claims or resets relevance/match state; held claims return 409 `AI_OPERATION_REQUIRES_REVIEW`.

## User-provided AI rollout (ADR-0001, BYO AI)

**What changes:** every AI call uses the job user's own provider key (Gemini, OpenAI or Claude) from the code catalog. There is no server key and no fallback.
- Without usable AI, emails wait as `PENDING`. The job is acknowledged and its delivery withdrawn (pg-boss `cancelled`), so the email can be re-offered at once.
- A provider refusal (key, billing, model, rate limit) uses no email or operation attempt and pauses only that user. A rate limit pauses with a cooldown; a key, billing or model problem waits until the user fixes it.
- An unknown outcome is held (`UNKNOWN`) and pauses that user for 2 minutes, growing to 30, so an outage holds at most one uncertain call per window.
- Held operations are retried only after the user approves one more attempt ("Retry anyway").

**Release steps:**

1. Back up the database. Add `AI_CREDENTIAL_ENCRYPTION_KEY` (new, backed up) and `AI_USER_DAILY_CALL_LIMIT=0` to start. Remove `GEMINI_API_KEY`, `GEMINI_*_MODEL` and `AI_DAILY_CALL_LIMIT`; production refuses to start with them.
2. Stop and drain **all old API/worker processes**. Old workers would call the hosted key and bypass per-user access.
3. Migrate through the guarded runner. `20261002120000_user_provided_ai` is additive:
   - adds `ai_configurations` and `ai_usage_days`;
   - adds `ai_operations.provider`, `.model` and `.approvedRetries`;
   - backfills `provider = 'gemini'` where `attempts > 0` (the only provider ever used).

   Verify it on synthetic lanes with `node scripts/verify-ai-migration.cjs` (see Verification commands).
4. Deploy backend, then frontend (the frontend needs the new response fields).
5. **Providers stay hidden** until each is certified (docs repo `docs/ai/provider-evaluation.md`): passing evaluation, error mapping confirmed with a real key, and owner-approved data-use text. Until then production offers no provider, and every user's emails wait as `PENDING`.
6. Tell users who relied on the hosted key that they must choose a provider. Then raise `AI_USER_DAILY_CALL_LIMIT` (default 500).
7. **Supervised live run per certified provider:** setup, verify (valid and invalid key), sample test, process a few synthetic emails, one refusal and one approved retry.

**Rollback:** do not return to the hosted key. Keep the new tables and the stored configurations. To stop AI work, set `AI_USER_DAILY_CALL_LIMIT=0`. `ai_call_budgets` is no longer used; it is dropped only after one stable release.

**Support diagnosis (no content or keys are ever logged):**

| Event | Meaning |
| --- | --- |
| `job_waiting_for_ai` (reason) | Email waits for AI access |
| `ai_call_deferred` | Cooldown, safety limit or pause hit at claim time |
| `ai_call_failed` (kind, status, providerCode) | Provider refusal or failure |
| `ai_access_checked` (result, kind) | Verification on save or "Check again" |
| `ai_settings_saved` / `ai_settings_removed` | Configuration changes |
| `ai_sample_test` | Sample test outcome and tokens |
| `ai_retry_approved` | User approved one more attempt |
| `ai_credential_unreadable` | Stored key cannot be decrypted (check the encryption key) |

Per-user state lives in `ai_configurations` (access issue, cooldown, revision) and `ai_usage_days` (calls, tokens, verifications).

## Automation submissions through MCP (ADR-0002)

**What changes:** `POST /mcp` accepts per-user integration tokens from the user's own automation and records confirmed submissions (`external_submissions`). Applications are created automatically for these submissions only; Gmail still never creates applications. No AI call, queue or new infrastructure.

**Release steps:**

1. Back up the database. Set `MCP_ALLOWED_HOSTS` to the `Host` the backend actually receives behind CloudFront/ALB (production refuses to start without it). Leave `MCP_ALLOWED_ORIGINS` empty unless a client is known to send an `Origin`. Optionally start with `MCP_DAILY_SUBMISSION_LIMIT=0`.
2. Migrate through the guarded runner. `20261002150000_automation_submissions` is additive:
   - adds `integration_tokens` and `external_submissions`, three enums, and the nullable unique `application_events."externalSubmissionId"`;
   - adds ownership triggers `submission_ownership`, `event_submission_ownership`, `integration_token_ownership`; no existing row changes.

   Verify it on synthetic lanes with `node scripts/verify-mcp-migration.cjs`; re-run the Sprint 6 and BYO AI lane scripts too. AI-18's cleanup migration comes after this one.
3. Route `/mcp` to the backend at the edge (deployment work). Deploy the backend, then the frontend (the frontend requires `submittedVia` and `sourceSubmission`).
4. Raise `MCP_DAILY_SUBMISSION_LIMIT` (default 500) once a supervised run looks right.

**Rollback:** set `MCP_DAILY_SUBMISSION_LIMIT=0` to stop new submissions and revoke tokens if needed. Keep the tables: they hold the evidence behind created or linked applications. There is no destructive down migration.

**Support diagnosis (no payload values or token material are ever logged):**

| Event | Meaning |
| --- | --- |
| `mcp_request` (status, rpcMethod, tool, outcome, userId, tokenId, durationMs) | One line per `/mcp` request. Outcomes: `created`, `linked`, `needs_review`, `already_recorded` (+ `payloadDiffered`), `invalid_input` (+ `invalidFields`, `unknownKeyCount`), `rate_limited`, `unavailable` (+ `errorCategory`), `unauthorized`, `method_not_allowed`, `host_not_allowed` (+ `rejectedHost`), `origin_not_allowed` (+ `rejectedOriginHost`), `body_too_large`, `invalid_json`. A rejected hostname is logged only to configure `MCP_ALLOWED_HOSTS`/`MCP_ALLOWED_ORIGINS`; it is never echoed |
| `integration_token_created` / `integration_token_revoked` | Token lifecycle (IDs only) |
| `submission_resolved` | A user resolved a pending submission |

## Preflight queries (read only)

These must return no rows before `20260926110000_domain_integrity`:

```sql
SELECT "applicationId", "emailId", type, count(*)
FROM application_events WHERE "emailId" IS NOT NULL
GROUP BY "applicationId", "emailId", type HAVING count(*) > 1;

SELECT "applicationId", "emailId", type, count(*)
FROM actions WHERE "emailId" IS NOT NULL
GROUP BY "applicationId", "emailId", type HAVING count(*) > 1;

SELECT e.id FROM emails e JOIN applications a ON a.id = e."applicationId"
WHERE e."userId" <> a."userId";

SELECT x.id FROM actions x JOIN emails e ON e.id = x."emailId"
JOIN applications a ON a.id = x."applicationId" WHERE e."userId" <> a."userId";

SELECT x.id FROM application_events x JOIN emails e ON e.id = x."emailId"
JOIN applications a ON a.id = x."applicationId" WHERE e."userId" <> a."userId";
```

## Configuration

| Variable | Required behavior |
| --- | --- |
| `NODE_ENV=production` | Disables header impersonation independently of its flag. |
| `ENABLE_DEV_AUTH` | Must not be `true` in production; startup rejects it. |
| `SESSION_SECRET`, `OAUTH_STATE_COOKIE_SECRET` | Independent randomly generated values, at least 32 characters, no development fallback. |
| `FRONTEND_URL`, `GOOGLE_REDIRECT_URI`, `GMAIL_REDIRECT_URI` | Explicit HTTPS URLs in production. Register matching OAuth redirects. |
| `TRUST_PROXY_HOPS` | Set only when deployed behind that exact trusted proxy count. Required for secure session cookies behind TLS termination; do not trust arbitrary forwarded headers. |
| `GMAIL_TOKEN_ENCRYPTION_KEY` | Existing AES-256 key; preserve it to read existing encrypted tokens. |
| `AI_USER_DAILY_CALL_LIMIT` | Integer 0–5000, default 500, **per user** per UTC day (BYO AI). Every call sent counts, including refused calls, retries and sample tests. 0 pauses all AI calls for everyone (kill switch). It is Career Companion's own safeguard, not a provider quota or a currency budget. |
| `AI_CREDENTIAL_ENCRYPTION_KEY` | 64 hex characters (32 bytes), dedicated to users' AI provider keys. Required in production and must differ from `GMAIL_TOKEN_ENCRYPTION_KEY` (startup check). Back it up: losing it makes every stored AI key unreadable (users see "Enter your API key again"). |
| `AI_DAILY_CALL_LIMIT`, `GEMINI_API_KEY`, `GEMINI_RELEVANCE_MODEL`, `GEMINI_EXTRACTION_MODEL` | **Removed** (BYO AI). Production startup refuses to start while any of them is set: there is no server AI key, and models come from the code catalog. |
| `DISCORD_USER_ID` | Owner of the existing `DISCORD_WEBHOOK_URL`; no owner means delivery is skipped. Other users never use this webhook. |
| `MCP_ALLOWED_HOSTS` | Required in production (ADR-0002): comma-separated hostnames, no scheme or port, that the `Host` header may name on `/mcp`. Outside production it defaults to `localhost,127.0.0.1,[::1]`. |
| `MCP_ALLOWED_ORIGINS` | Hostnames a present `Origin` may name on `/mcp`. Default empty: requests with any `Origin` are rejected; requests without one pass. |
| `MCP_DAILY_SUBMISSION_LIMIT` | Integer 0–5000, default 500: new automation submissions per user per UTC day. 0 stops all new submissions. Invalid values fail production startup. |

Keep OAuth, database, encryption and webhook credentials server-side. No new infrastructure is required. AI provider keys belong to users and are stored only as AES-256-GCM ciphertext bound to their owner.

## Recovery rules

- AI identity is `(emailId, operation, contract version)`; logical email identity remains `(userId, gmailMessageId)`. Changing the connected mailbox is rejected to preserve that identity. Changing a model or deploying code is not consent to reprocess historical mail.
- `COMPLETED` operations reuse schema-validated results. Completed legacy results are adopted without calling Gemini; legacy partial results without a ledger are held for review. New versions do not automatically reprocess a completed email; intentional replay needs an explicit, separately reviewed operation.
- `PENDING`/`RETRYABLE` operations resume only when the user's AI access is ready: their own key, no cooldown, under the per-user safety limit. **BYO AI:** a provider refusal releases the claim and restores the attempt, so refusals never exhaust attempts; the per-user cooldown and safety limit bound the loop. SDK retries are off; timeouts come from the catalog (30–60 s), output limit 2048 tokens, body input 8000 characters.
- **User-approved retry (BYO AI):** for `UNKNOWN`, unusable output (`FAILED` with `INVALID_OUTPUT`), a stale `PROCESSING` claim (over 15 minutes) or exhausted attempts, the owner may approve exactly one more call (`approvedRetries`). This is the supported path; operators should not reset claims by hand. `INVALID_REQUEST` and legacy partial results remain operator-only.
- `PROCESSING` after a crash, `UNKNOWN`, terminal `FAILED`, and exhausted attempts require reconciliation. Do not clear these claims, reset all email states, or blindly resubmit jobs: the provider may have succeeded or charged before persistence failed. Inspect operation IDs, versions, timestamps, provider records and the stored result first. Restoring a verified completed checkpoint avoids a new call; authorizing a new call requires recording that the duplicate-cost risk was considered. No blanket reset command is provided.
- Email jobs retry at most three times after the initial execution. Budget exhaustion or non-provider failures can exhaust that queue allowance while the operation remains pending/retryable. An operator must inspect and re-enqueue the owner-scoped email after resolving the cause; automatic revival of all failed work is intentionally absent.
- Gmail queues a user-scoped claim, renews a five-minute lease, and bounds each scan to four minutes plus the current request. Sync failure leaves the history checkpoint unchanged; 404 history expiration triggers a bounded full scan of the existing 90-day INBOX scope. Repeated scans reuse stored emails. Each successful scan recovers up to 100 pending insert/enqueue gaps. A stale lease permits another sync; it does not clear AI claims. Very large first scans may require more than one sync.
- Notification claims are committed before sending. A claimed/uncertain delivery is not automatically sent again. Only explicit retryable rejections release its claim (maximum four attempts). Inspect Discord before authorizing any resend. The action-to-queue crash window remains an accepted noncritical notification limitation; no transactional outbox was introduced.

## Privacy and diagnostics

Persisted Gmail metadata: message/thread IDs, sender, subject and timestamps; connection addresses and encrypted OAuth tokens. Snippets, headers beyond selected metadata, and raw bodies are transient. Structured AI extraction and operation checkpoints can contain personal information; they are user-owned through the email FK. Domain records and AI checkpoints remain until parent deletion; no automatic retention period or deletion UI has been invented. Disconnect clears credentials and history/sync claims but retains existing email/domain data. A retention/deletion policy still needs a product decision before a broader public rollout.

Logs identify jobs, email IDs, operation/version/attempt, provider/model, duration, outcome and token counts; they omit bodies, snippets, provider payloads, provider error text and credentials.

**BYO AI storage:**
- A user's AI provider key is stored only as AES-256-GCM ciphertext under a dedicated key, bound to the user ID.
- It is never returned by the API, logged, put in a job payload or kept in the browser.
- Replacing or removing it overwrites or deletes the row. Encrypted copies remain in database backups until they age out.
- `ai_usage_days` holds Career Companion's own per-user counts (calls, tokens, verifications), not provider billing.
- `ai_operations.provider`/`model` record which provider and model produced each result. Daily budgets contain only day/count/cooldown. Diagnose `ai_call_started`, `ai_call_completed`, `ai_result_reused`, `ai_call_blocked`, `ai_call_deferred`, `job_failed`, `gmail_sync_failed`, and notification outcomes together. A provider success followed by checkpoint failure remains visible as a started operation with no completed checkpoint.

## Verification commands

BYO AI migration lanes: `npm run build && FRESH_DATABASE_URL=… UPGRADE_DATABASE_URL=… node scripts/verify-ai-migration.cjs` (two separate, empty, local `career_companion_*test` databases). MCP migration lanes: the same with `node scripts/verify-mcp-migration.cjs`. The smoke can save screenshots of the AI screens with `SMOKE_SCREENSHOTS=<dir>`.

Use the separate database described in the README. Run backend typecheck, lint, tests, build, `prisma validate`, `prisma migrate status`, and migration/schema comparison. Validate both fresh installation and upgrade from the eight baseline migrations, including a legacy completed result and a duplicate fixture that causes migration rollback without data loss.

Migrate only through `node scripts/guarded-migrate.cjs` (see README). Fresh/upgrade preservation: `node scripts/verify-migration-preservation.cjs` with two separate empty lanes.

With both builds complete, run in the frontend:

```bash
npm run sync-contracts   # fails (non-zero) if the backend contracts cannot be found
npm run typecheck
npm run lint
npm test
npm run build
SMOKE_DATABASE_URL="postgresql://…/career_companion_x_smoke_test" node scripts/smoke-stabilization.mjs
```

The smoke needs an exclusive, empty, migrated `career_companion_*smoke_test` database (it takes an advisory lock and refuses non-empty state), Chrome (`CHROME_BIN` outside the default macOS path) and finds the backend via `BACKEND_DIR` or the sibling `career-companion-backend-main`/`career-companion-backend` folder. It runs the real API, PostgreSQL, pg-boss and real Gmail/email workers with in-process deterministic Gmail/Gemini adapters, a small nonzero AI budget through the real ledger, encrypted fixture tokens and a fixture history anchor (it asserts incremental `history.list`). All other backend outbound traffic fails the run; browser requests to other origins are aborted. Real notification delivery is disabled.

Teardown order: close the browser, stop HTTP intake and worker fetch, drain in-flight HTTP requests and worker handlers (fixture adapters/outbound blocking stay active), then delete fixture jobs (by owner and action ID), owners and the exclusively owned AI budget, then close resources and release the lane. In-flight HTTP is tracked until each handler ends its response, not until the client socket closes. Each run proves that a browser-originated and a Node-originated in-flight write and an active worker finish before cleanup, and records residual users/jobs/budgets (must be 0). If draining fails the lane is quarantined: no deletion, and outbound blocking and the lane lock are held until the process exits. `SMOKE_INJECT=scenario-failure` checks teardown after a failed run; `SMOKE_INJECT=http-drain` and `SMOKE_INJECT=worker-drain` check quarantine (reset the lane afterwards). Non-local browser requests other than the known web-font hosts fail the run. This is fixture evidence, not live Gmail or Gemini execution.
### Sprint 7 bounded scan window

The first sync uses the configured lookback. Later syncs cover the time since the last successful sync, with a one-hour overlap and a 30-day cap. The Gmail page retains an unscanned-gap notice when the cap excludes older mail, until a newer capped scan replaces it. A failed attempt does not advance checkpoints or replace the notice. Reconnecting the same mailbox follows the same rule. Stored completed emails and user matches are preserved.

### Action deadlines (Sprint 7)

New deadlines use explicit parsing anchored to the email's received UTC date (one-day sender allowance); relative, numeric non-ISO, invalid and unclear dates remain null. Date-only values carry DATE precision and display without an invented time in the UI and Discord. Existing actions retain their values and null legacy precision; no backfill or AI replay occurs.

### Worker startup (Sprint 7)

Check `/ready` for all workers registered; `/health` only proves the HTTP process is up. Logs include worker_registered, workers_ready, *_worker_start_failed, worker_start_gave_up and queue_error. Startup retries failed workers only, then exits 1. Driver errors include category and allowlisted code, never messages or stacks. Readiness intentionally does not probe database availability after startup.
