/**
 * Sign-in routes.
 *
 *   GET  /api/auth/connect    start Google sign-in (prod mode only)
 *   GET  /api/auth/callback   finish Google sign-in (prod mode only)
 *   POST /api/auth/login      sign in with email and password
 *   POST /api/auth/test-login sign in to a test account (see services/testAccounts.ts)
 *   POST /api/auth/password   set the first password, or change it
 *   POST /api/auth/register   create a user with a password (dev mode only)
 *   GET  /api/auth/me         the signed-in user
 *   GET|POST /api/auth/logout
 *
 * `?returnTo=` on connect: the app page to open after sign-in (`next` on /login if it fails).
 * Request bodies are never logged, and validation errors never include submitted values.
 */
import { randomBytes } from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import {
  PasswordLoginRequestSchema,
  RegisterRequestSchema,
  SetPasswordRequestSchema,
} from '../contracts/auth';
import { devModeOnly, prodModeOnly } from '../middleware/appMode';
import { requireAuth } from '../middleware/auth';
import {
  googleLoginUrl,
  verifyGoogleLogin,
  warnIfGoogleLoginNotConfigured,
} from '../services/googleOAuth';
import { loginWithPassword, registerUser, setPassword } from '../services/passwordLogin';
import { isTestAccountEmail } from '../services/testAccounts';
import { BetaFullError, findOrCreateGoogleUser, getUserProfile } from '../services/user';
import { AppError } from '../errors';
import { frontendUrl, isProduction } from '../utils/config';
import { logError, logEvent } from '../utils/log';
import { returnPath } from '../utils/returnPath';

const router = Router();

const AUTH_STATE_COOKIE_NAME = 'google_login_state';
const AUTH_RETURN_COOKIE_NAME = 'google_login_return';
const FRONTEND_LOGIN_PATH = '/login';
const FRONTEND_DASHBOARD_PATH = '/';

warnIfGoogleLoginNotConfigured();

/** Starts the session of a user who just proved who they are, under a fresh session ID. */
async function signIn(req: Request, userId: string) {
  await new Promise<void>((resolve, reject) =>
    req.session.regenerate((err) => (err ? reject(err) : resolve())),
  );
  req.session.userId = userId;
  await new Promise<void>((resolve, reject) =>
    req.session.save((err) => (err ? reject(err) : resolve())),
  );
}

/** The login page after a failed sign-in; `next` keeps the page asked for, for the next try. */
function loginErrorUrl(code: string, returnTo: string) {
  const url = `${frontendUrl()}${FRONTEND_LOGIN_PATH}?error=${code}`;
  return returnTo === FRONTEND_DASHBOARD_PATH ? url : `${url}&next=${encodeURIComponent(returnTo)}`;
}

function handle(status: number, action: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json(await action(req));
    } catch (err) {
      next(err);
    }
  };
}

router.get('/connect', prodModeOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const returnTo = returnPath(req.query.returnTo, FRONTEND_DASHBOARD_PATH);
    const state = randomBytes(32).toString('hex');
    const authUrl = googleLoginUrl(state);

    const cookie = {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 5 * 60 * 1000, // 5 minutes
      signed: true,
      secure: isProduction(),
    } as const;
    res.cookie(AUTH_STATE_COOKIE_NAME, state, cookie);
    // Kept for the same few minutes; an earlier try's page must not outlive it.
    if (returnTo === FRONTEND_DASHBOARD_PATH) res.clearCookie(AUTH_RETURN_COOKIE_NAME);
    else res.cookie(AUTH_RETURN_COOKIE_NAME, returnTo, cookie);

    return res.redirect(302, authUrl);
  } catch (err) {
    next(err);
  }
});

router.get('/callback', prodModeOnly, async (req: Request, res: Response) => {
  // Checked again on the way back, and single use like the state.
  const returnTo = returnPath(
    req.signedCookies?.[AUTH_RETURN_COOKIE_NAME],
    FRONTEND_DASHBOARD_PATH,
  );
  res.clearCookie(AUTH_RETURN_COOKIE_NAME);

  try {
    const { code, state, error } = req.query as {
      code?: string;
      state?: string;
      error?: string;
    };

    if (error === 'access_denied') {
      res.clearCookie(AUTH_STATE_COOKIE_NAME);
      return res.redirect(302, loginErrorUrl('denied', returnTo));
    }

    const storedState = req.signedCookies?.[AUTH_STATE_COOKIE_NAME];
    res.clearCookie(AUTH_STATE_COOKIE_NAME);

    if (!storedState || !state || storedState !== state) {
      return res.redirect(302, loginErrorUrl('csrf', returnTo));
    }

    if (!code) {
      return res.redirect(302, loginErrorUrl('missing_code', returnTo));
    }

    const identity = await verifyGoogleLogin(code);
    // A test account signs in on its own page only.
    if (isTestAccountEmail(identity.email))
      return res.redirect(302, loginErrorUrl('test_account', returnTo));
    const user = await findOrCreateGoogleUser(identity.googleId, identity.email, identity.name);

    await signIn(req, user.id);
    return res.redirect(302, `${frontendUrl()}${returnTo}`);
  } catch (err) {
    if (err instanceof BetaFullError) {
      logEvent('new_account_refused', { reason: 'beta_full' });
      return res.redirect(302, loginErrorUrl('beta_full', returnTo));
    }
    logError('google_login_failed', {}, err);
    return res.redirect(302, loginErrorUrl('server_error', returnTo));
  }
});

router.post(
  '/login',
  handle(200, async (req) => {
    const input = PasswordLoginRequestSchema.parse(req.body);
    if (isTestAccountEmail(input.email))
      throw new AppError(403, 'USE_TEST_LOGIN', 'Test accounts sign in on the test sign-in page.');
    const userId = await loginWithPassword(input, req.ip ?? '');
    await signIn(req, userId);
    return getUserProfile(userId);
  }),
);

router.post(
  '/test-login',
  handle(200, async (req) => {
    const input = PasswordLoginRequestSchema.parse(req.body);
    if (!isTestAccountEmail(input.email))
      throw new AppError(403, 'NOT_TEST_ACCOUNT', 'This page is for test accounts only.');
    const userId = await loginWithPassword(input, req.ip ?? '');
    await signIn(req, userId);
    return getUserProfile(userId);
  }),
);

router.post(
  '/register',
  devModeOnly,
  handle(201, async (req) => {
    const userId = await registerUser(RegisterRequestSchema.parse(req.body));
    await signIn(req, userId);
    return getUserProfile(userId);
  }),
);

router.post(
  '/password',
  requireAuth,
  handle(200, async (req) => {
    const userId = req.auth!.user.id;
    await setPassword(userId, SetPasswordRequestSchema.parse(req.body), {
      ip: req.ip ?? '',
      sessionId: req.sessionID,
    });
    return getUserProfile(userId);
  }),
);

router.get('/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.auth?.user) {
      return res
        .status(401)
        .json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    }

    const user = await getUserProfile(req.auth.user.id);

    if (!user) {
      // Session exists but user was deleted
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'User not found' } });
    }

    return res.status(200).json(user);
  } catch (err) {
    next(err);
  }
});

const logoutHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    req.session.destroy((err) => {
      if (err) {
        return next(err);
      }
      res.clearCookie('cc_session');
      return res.status(200).json({ loggedOut: true });
    });
  } catch (err) {
    next(err);
  }
};

router.get('/logout', logoutHandler);
router.post('/logout', logoutHandler);

export const authRouter = router;
