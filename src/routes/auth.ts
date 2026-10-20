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
import { findOrCreateGoogleUser, getUserProfile } from '../services/user';
import { AppError } from '../errors';
import { frontendUrl, isProduction } from '../utils/config';
import { logError } from '../utils/log';

const router = Router();

const AUTH_STATE_COOKIE_NAME = 'google_login_state';
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
    const state = randomBytes(32).toString('hex');
    const authUrl = googleLoginUrl(state);

    res.cookie(AUTH_STATE_COOKIE_NAME, state, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 5 * 60 * 1000, // 5 minutes
      signed: true,
      secure: isProduction(),
    });

    return res.redirect(302, authUrl);
  } catch (err) {
    next(err);
  }
});

router.get('/callback', prodModeOnly, async (req: Request, res: Response) => {
  const frontendLoginUrl = `${frontendUrl()}${FRONTEND_LOGIN_PATH}`;
  const frontendDashboardUrl = `${frontendUrl()}${FRONTEND_DASHBOARD_PATH}`;

  try {
    const { code, state, error } = req.query as {
      code?: string;
      state?: string;
      error?: string;
    };

    if (error === 'access_denied') {
      res.clearCookie(AUTH_STATE_COOKIE_NAME);
      return res.redirect(302, `${frontendLoginUrl}?error=denied`);
    }

    const storedState = req.signedCookies?.[AUTH_STATE_COOKIE_NAME];
    res.clearCookie(AUTH_STATE_COOKIE_NAME);

    if (!storedState || !state || storedState !== state) {
      return res.redirect(302, `${frontendLoginUrl}?error=csrf`);
    }

    if (!code) {
      return res.redirect(302, `${frontendLoginUrl}?error=missing_code`);
    }

    const identity = await verifyGoogleLogin(code);
    // A test account signs in on its own page only.
    if (isTestAccountEmail(identity.email))
      return res.redirect(302, `${frontendLoginUrl}?error=test_account`);
    const user = await findOrCreateGoogleUser(identity.googleId, identity.email, identity.name);

    await signIn(req, user.id);
    return res.redirect(302, frontendDashboardUrl);
  } catch (err) {
    logError('google_login_failed', {}, err);
    return res.redirect(302, `${frontendLoginUrl}?error=server_error`);
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
