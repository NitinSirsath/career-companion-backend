import { SyncQueueError } from '../services/gmailSyncErrors';
/**
 * Gmail OAuth routes.
 *
 * Endpoints:
 *   GET  /api/gmail/status       — connection status for authenticated user
 *   GET  /api/gmail/connect      — initiate OAuth flow (redirect to Google); in dev mode,
 *                                  connect the sandbox mailbox at once. `?returnTo=` names
 *                                  the mail page to come back to instead of the Gmail page
 *   GET  /api/gmail/callback     — Google OAuth callback handler
 *   POST /api/gmail/disconnect   — revoke and clear GmailConnection
 *
 * Security principles:
 * - OAuth state is a cryptographically random value stored in a signed, short-lived,
 *   HttpOnly, SameSite=Lax cookie. It is cleared after a single use (CSRF protection).
 * - The authorization code (query param `code`) is NEVER logged.
 * - accessToken and refreshToken are NEVER returned in API responses.
 * - All routes require an authenticated user session; automated tests may use the test-only dev auth boundary.
 * - Gmail OAuth is a secondary authorization grant, not user authentication.
 */

import { randomBytes } from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { prodModeOnly } from '../middleware/appMode';
import { requireAuth } from '../middleware/auth';
import { getPaginationParams, createPaginatedResponse } from '../utils/pagination';
import { GmailSettingsPatchSchema } from '../contracts/gmail';
import { devMode, frontendUrl, isProduction } from '../utils/config';
import { logError } from '../utils/log';
import { listEmails } from '../services/email';
import {
  clearGmailConnection,
  connectSandboxMailbox,
  connectedAccessToken,
  readGmailStatus,
  saveGmailGrant,
  setSyncLookbackDays,
} from '../services/gmailConnection';
import { startManualSync } from '../services/gmailSyncRequests';
import { exchangeGmailCode, gmailConsentUrl, revokeGmailAccess } from '../services/googleOAuth';
import { GmailAuthError, SyncInProgressError } from '../services/gmailSync';

const router = Router();

// ─── Helpers ────────────────────────────────────────────────────────────────

const STATE_COOKIE_NAME = 'gmail_oauth_state';
const RETURN_COOKIE_NAME = 'gmail_oauth_return';
const FRONTEND_GMAIL_PATH = '/gmail';
const OAUTH_COOKIE_MAX_AGE_MS = 5 * 60 * 1000; // enough time to complete the OAuth flow

/**
 * Where to send the user after connecting: the mail they came from, or the Gmail page. Only a
 * mail details path of this app is accepted, so the value can never lead to another site.
 */
const MAIL_PAGE = /^\/mails\/(gmail\/)?[A-Za-z0-9_-]{1,128}$/;
const returnPath = (value: unknown): string =>
  typeof value === 'string' && MAIL_PAGE.test(value) ? value : FRONTEND_GMAIL_PATH;

// ─── Protect all routes with dev auth ───────────────────────────────────────

router.use(requireAuth);

// ─── GET /api/gmail/status ───────────────────────────────────────────────────

router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    return res.status(200).json(await readGmailStatus(req.auth!.user.id));
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/gmail/connect ──────────────────────────────────────────────────

router.get('/connect', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const returnTo = returnPath(req.query.returnTo);
    // Dev mode has no Google account: the sandbox mailbox is connected at once.
    if (devMode()) {
      await connectSandboxMailbox(req.auth!.user.id);
      return res.redirect(302, `${frontendUrl()}${returnTo}`);
    }

    // Generate a cryptographically random CSRF state token (32 bytes = 64 hex chars).
    const state = `${req.auth!.user.id}.${randomBytes(32).toString('hex')}`;
    const authUrl = gmailConsentUrl(state);

    // Store state in a signed, short-lived, HttpOnly, SameSite=Lax cookie.
    // The cookie secret comes from OAUTH_STATE_COOKIE_SECRET.
    // cookie-parser's signedCookies support is used for tamper detection.
    const cookie = {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: OAUTH_COOKIE_MAX_AGE_MS,
      signed: true,
      secure: isProduction(),
    } as const;
    res.cookie(STATE_COOKIE_NAME, state, cookie);
    // Kept for the same few minutes; an earlier try's page must not outlive it.
    if (returnTo === FRONTEND_GMAIL_PATH) res.clearCookie(RETURN_COOKIE_NAME);
    else res.cookie(RETURN_COOKIE_NAME, returnTo, cookie);

    return res.redirect(302, authUrl);
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/gmail/callback ─────────────────────────────────────────────────

router.get('/callback', prodModeOnly, async (req: Request, res: Response) => {
  const frontendGmailUrl = `${frontendUrl()}${FRONTEND_GMAIL_PATH}`;

  try {
    const userId = req.auth!.user.id;
    const { code, state, error } = req.query as {
      code?: string;
      state?: string;
      error?: string;
    };

    // ── Handle user denial ────────────────────────────────────────────────
    if (error === 'access_denied') {
      // Clear state cookie regardless.
      res.clearCookie(STATE_COOKIE_NAME);
      res.clearCookie(RETURN_COOKIE_NAME);
      return res.redirect(302, `${frontendGmailUrl}?gmailError=denied`);
    }

    // ── CSRF state validation ─────────────────────────────────────────────
    const storedState = req.signedCookies?.[STATE_COOKIE_NAME];

    // Clear the state cookie immediately — it is single-use.
    res.clearCookie(STATE_COOKIE_NAME);
    const returnTo = returnPath(req.signedCookies?.[RETURN_COOKIE_NAME]);
    res.clearCookie(RETURN_COOKIE_NAME);

    if (!storedState || !state || storedState !== state || !state.startsWith(`${userId}.`)) {
      // Do NOT log `state` param — it could reveal correlation data.
      return res.status(400).json({
        error: {
          code: 'CSRF_INVALID',
          message: 'OAuth state is invalid or expired. Please try connecting Gmail again.',
        },
      });
    }

    if (!code) {
      return res.status(400).json({
        error: {
          code: 'MISSING_CODE',
          message: 'No authorization code received from Google.',
        },
      });
    }

    // ── Exchange code for tokens ──────────────────────────────────────────
    // SECURITY: `code` is NEVER logged, even at debug level.
    const { gmailEmail, grant } = await exchangeGmailCode(code);

    // ── Save the grant ────────────────────────────────────────────────────
    // SECURITY: the service encrypts the tokens before it stores them.
    const saved = await saveGmailGrant(userId, gmailEmail, grant);
    if (!saved) return res.redirect(302, `${frontendGmailUrl}?gmailError=account_change`);

    return res.redirect(302, `${frontendUrl()}${returnTo}`);
  } catch (err) {
    // Do not expose error details to the browser — redirect with a generic error.
    logError('gmail_oauth_failed', {}, err);
    return res.redirect(302, `${frontendGmailUrl}?gmailError=server_error`);
  }
});

// ─── POST /api/gmail/disconnect ──────────────────────────────────────────────

router.post('/disconnect', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.auth!.user.id;

    const accessToken = await connectedAccessToken(userId);
    if (accessToken === null) return res.status(200).json({ disconnected: true });

    // The token is cleared from the database whether or not Google accepted the revoke.
    await revokeGmailAccess(accessToken);
    await clearGmailConnection(userId);

    return res.status(200).json({ disconnected: true });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/gmail/settings ───────────────────────────────────────────────

router.patch('/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.auth!.user.id;
    const parsed = GmailSettingsPatchSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: { code: 'INVALID_LOOKBACK', message: 'syncLookbackDays must be 1, 7, 14, or 30' },
      });
    }

    const { syncLookbackDays } = parsed.data;
    await setSyncLookbackDays(userId, syncLookbackDays);

    return res.status(200).json({ success: true, syncLookbackDays });
  } catch (err) {
    next(err);
  }
});

export const gmailRouter = router;

// ─── POST /api/gmail/sync ────────────────────────────────────────────────────

router.post('/sync', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.auth!.user.id;

    const result = await startManualSync(userId);
    return res.status(202).json(result);
  } catch (err) {
    if (err instanceof SyncInProgressError) {
      return res.status(409).json({ error: { code: 'SYNC_IN_PROGRESS', message: err.message } });
    }

    // Return a safe, descriptive 503 when Gmail rejects our credentials.
    // This tells the frontend to prompt the user to reconnect Gmail rather
    // than showing a generic "unexpected error" for an auth failure.
    if (err instanceof GmailAuthError || err instanceof SyncQueueError) {
      return res.status(503).json({
        error: {
          code: err.code,
          message: err.message,
        },
      });
    }
    next(err);
  }
});

// ─── GET /api/gmail/messages ─────────────────────────────────────────────────

router.get('/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.auth!.user.id;
    const { limit, offset } = getPaginationParams(req.query);
    const relevance = req.query.relevance as string | undefined;

    const items = await listEmails(userId, relevance, limit, offset);
    return res.status(200).json(createPaginatedResponse(items, limit, offset));
  } catch (err) {
    next(err);
  }
});
