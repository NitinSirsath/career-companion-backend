import { Router, Request, Response, NextFunction } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '../db/prisma';

const router = Router();

const GOOGLE_AUTH_SCOPE = ['openid', 'email', 'profile'];
const AUTH_STATE_COOKIE_NAME = 'google_login_state';
const FRONTEND_LOGIN_PATH = '/login';
const FRONTEND_DASHBOARD_PATH = '/';

/**
 * Warn at startup when required Google OAuth variables are absent.
 * This surfaces the configuration gap early (before any request hits /connect)
 * rather than producing an opaque 500. In ENABLE_DEV_AUTH mode the warning
 * is expected and safe to ignore.
 */
const OAUTH_REQUIRED_VARS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'] as const;
const missingOAuthVars = OAUTH_REQUIRED_VARS.filter((v) => !process.env[v]);
if (missingOAuthVars.length > 0) {
  console.warn(
    `[Auth] Google OAuth is not configured — missing env vars: ${missingOAuthVars.join(', ')}. ` +
      'Google login will return 500. Set ENABLE_DEV_AUTH=true for local dev bypass.'
  );
}

function createOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  // Default matches the Vite dev server port so the redirect works without extra config.
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5173/api/auth/callback';

  if (!clientId || !clientSecret) {
    throw new Error(
      `Google Auth is not configured: ${missingOAuthVars.join(', ')} must all be set`
    );
  }

  return new OAuth2Client(clientId, clientSecret, redirectUri);
}

function getFrontendUrl(): string {
  // Default to the Vite dev server — NOT the backend port — so post-OAuth
  // redirects land on the correct origin in local development.
  return process.env.FRONTEND_URL?.replace(/\/$/, '') ?? 'http://localhost:5173';
}

router.get('/connect', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const oauth2Client = createOAuth2Client();

    const { randomBytes } = await import('crypto');
    const state = randomBytes(32).toString('hex');

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'online', // no refresh token needed for identity
      scope: GOOGLE_AUTH_SCOPE,
      state,
    });

    res.cookie(AUTH_STATE_COOKIE_NAME, state, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 5 * 60 * 1000, // 5 minutes
      signed: true,
      secure: process.env.NODE_ENV === 'production',
    });

    return res.redirect(302, authUrl);
  } catch (err) {
    next(err);
  }
});

router.get('/callback', async (req: Request, res: Response) => {
  const frontendLoginUrl = `${getFrontendUrl()}${FRONTEND_LOGIN_PATH}`;
  const frontendDashboardUrl = `${getFrontendUrl()}${FRONTEND_DASHBOARD_PATH}`;

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

    const oauth2Client = createOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    
    if (!tokens.id_token) {
      throw new Error('Google identity failed to return id_token');
    }

    // Verify identity using google-auth-library supported mechanism
    const ticket = await oauth2Client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.sub || !payload.email) {
      throw new Error('Google identity failed to return valid ID or email in claims');
    }
    
    // Check issuer to be completely strict
    if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
      throw new Error('Invalid issuer');
    }

    const googleId = payload.sub;
    const email = payload.email;
    const name = payload.name || null;

    let user = await prisma.user.findUnique({
      where: { googleId }
    });

    if (!user) {
      user = await prisma.user.findUnique({
        where: { email }
      });

      if (user) {
        // Link existing user to Google
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            googleId,
            name: user.name || name,
          }
        });
      } else {
        // Create new user
        user = await prisma.user.create({
          data: {
            googleId,
            email,
            name,
          }
        });
      }
    } else {
      // Update name if missing
      if (!user.name && name) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { name }
        });
      }
    }

    req.session.userId = user.id;

    // Use save() to wait for session store to persist before redirect
    req.session.save((err) => {
      if (err) {
        throw err;
      }
      return res.redirect(302, frontendDashboardUrl);
    });
  } catch (err) {
    console.error('[Google Auth] Callback error:', (err as Error).message);
    return res.redirect(302, `${frontendLoginUrl}?error=server_error`);
  }
});

import { requireAuth } from '../middleware/auth';

router.get('/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.auth?.user) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.auth.user.id },
      select: {
        id: true,
        email: true,
        name: true,
      }
    });

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
