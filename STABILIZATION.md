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
| `AI_DAILY_CALL_LIMIT` | Integer 0–10000, default 100 across all users per UTC day. Each attempt reserves one call; 0 blocks new calls. This is a call ceiling, not a currency budget. |
| `DISCORD_USER_ID` | Owner of the existing `DISCORD_WEBHOOK_URL`; no owner means delivery is skipped. Other users never use this webhook. |

Keep Gemini, OAuth, database and webhook credentials server-side. No new infrastructure or providers are required.

## Recovery rules

- AI identity is `(emailId, operation, contract version)`; logical email identity remains `(userId, gmailMessageId)`. Changing the connected mailbox is rejected to preserve that identity. Changing a model or deploying code is not consent to reprocess historical mail.
- `COMPLETED` operations reuse schema-validated results. Completed legacy results are adopted without calling Gemini; legacy partial results without a ledger are held for review. New versions do not automatically reprocess a completed email; intentional replay needs an explicit, separately reviewed operation.
- `PENDING`/`RETRYABLE` operations may resume only after budget/cooldown permits. Explicit 429/503 rejections have at most three attempts per operation, with durable cooldown. SDK attempts are one; request timeout is 30 seconds, output limit 2048 tokens, body input 8000 characters.
- `PROCESSING` after a crash, `UNKNOWN`, terminal `FAILED`, and exhausted attempts require reconciliation. Do not clear these claims, reset all email states, or blindly resubmit jobs: the provider may have succeeded or charged before persistence failed. Inspect operation IDs, versions, timestamps, provider records and the stored result first. Restoring a verified completed checkpoint avoids a new call; authorizing a new call requires recording that the duplicate-cost risk was considered. No blanket reset command is provided.
- Email jobs retry at most three times after the initial execution. Budget exhaustion or non-provider failures can exhaust that queue allowance while the operation remains pending/retryable. An operator must inspect and re-enqueue the owner-scoped email after resolving the cause; automatic revival of all failed work is intentionally absent.
- Gmail queues a user-scoped claim, renews a five-minute lease, and bounds each scan to four minutes plus the current request. Sync failure leaves the history checkpoint unchanged; 404 history expiration triggers a bounded full scan of the existing 90-day INBOX scope. Repeated scans reuse stored emails. Each successful scan recovers up to 100 pending insert/enqueue gaps. A stale lease permits another sync; it does not clear AI claims. Very large first scans may require more than one sync.
- Notification claims are committed before sending. A claimed/uncertain delivery is not automatically sent again. Only explicit retryable rejections release its claim (maximum four attempts). Inspect Discord before authorizing any resend. The action-to-queue crash window remains an accepted noncritical notification limitation; no transactional outbox was introduced.

## Privacy and diagnostics

Persisted Gmail metadata: message/thread IDs, sender, subject and timestamps; connection addresses and encrypted OAuth tokens. Snippets, headers beyond selected metadata, and raw bodies are transient. Structured AI extraction and operation checkpoints can contain personal information; they are user-owned through the email FK. Domain records and AI checkpoints remain until parent deletion; no automatic retention period or deletion UI has been invented. Disconnect clears credentials and history/sync claims but retains existing email/domain data. A retention/deletion policy still needs a product decision before a broader public rollout.

Logs identify jobs, email IDs, operation/version/attempt, duration, outcome and token counts; they omit bodies, snippets, provider payloads and credentials. Daily budgets contain only day/count/cooldown. Diagnose `ai_call_started`, `ai_call_completed`, `ai_result_reused`, `ai_call_blocked`, `ai_call_deferred`, `job_failed`, `gmail_sync_failed`, and notification outcomes together. A provider success followed by checkpoint failure remains visible as a started operation with no completed checkpoint.

## Verification commands

Use the separate database described in the README. Run backend typecheck, lint, tests, build, `prisma validate`, `prisma migrate status`, and migration/schema comparison. Validate both fresh installation and upgrade from the eight baseline migrations, including a legacy completed result and a duplicate fixture that causes migration rollback without data loss.

With sibling repositories and both builds complete, run in the frontend:

```bash
npm run typecheck
npm run lint
npm test
npm run build
node scripts/smoke-stabilization.mjs
```

The smoke script uses the backend `.env.test`, its database guard, Chrome (set `CHROME_BIN` outside the default macOS path), fixture users and real API/queue persistence. Workers are disabled and browser requests to external origins are blocked. It verifies the queued sync/polling UI using a controlled completion fixture, not live Gmail or Gemini execution.
