import { randomBytes } from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  googleLoginUrl,
  verifyGoogleLogin,
  warnIfGoogleLoginNotConfigured,
} from '../services/googleOAuth';
import { findOrCreateGoogleUser, getUserProfile } from '../services/user';
import { frontendUrl, isProduction } from '../utils/config';
import { logError } from '../utils/log';

const router = Router();
 
const AUTH_STATE_COOKIE_NAME = 'google_login_state';
const FRONTEND_LOGIN_PATH = '/login';
const FRONTEND_DASHBOARD_PATH = '/';
 
warnIfGoogleLoginNotConfigured();

router.get('/connect', async (req: Request, res: Response, next: NextFunction) => {
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

router.get('/callback', async (req: Request, res: Response) => {
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
    const user = await findOrCreateGoogleUser(identity.googleId, identity.email, identity.name);

    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );
    req.session.userId = user.id;
    await new Promise<void>((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve())),
    );
    return res.redirect(302, frontendDashboardUrl);
  } catch (err) {
    logError('google_login_failed', {}, err);
    return res.redirect(302, `${frontendLoginUrl}?error=server_error`);
  }
});

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
