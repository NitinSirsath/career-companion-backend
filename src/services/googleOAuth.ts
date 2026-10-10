/**
 * The two Google OAuth grants: login (who the user is) and Gmail (read-only mailbox access).
 * Routes keep the browser side of the flow: state cookies and redirects.
 *
 * The authorization code and the tokens are never logged.
 */
import { google } from 'googleapis';
import { gmailOAuth, googleLoginOAuth, missingGoogleLoginVars } from '../utils/config';
import { decryptToken, loadEncryptionKey } from '../utils/gmailTokenEncryption';
import { logWarn } from '../utils/log';
import {
  createGoogleOAuthClient,
  GOOGLE_OAUTH_TIMEOUT_MS,
  GOOGLE_REVOKE_TIMEOUT_MS,
  gmailCallOptions,
} from './googleTransport';

const LOGIN_SCOPE = ['openid', 'email', 'profile'];
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

// ─── Login ──────────────────────────────────────────────────────────────────

/** Says at startup, not at the first login, that Google login cannot work yet. */
export function warnIfGoogleLoginNotConfigured() {
  const missing = missingGoogleLoginVars();
  if (!missing.length) return;
  logWarn('google_oauth_not_configured', {
    missing,
    message: 'Google login will return 500. Set the Google OAuth variables in .env.',
  });
}

function loginClient() {
  const { clientId, clientSecret, redirectUri } = googleLoginOAuth();
  if (!clientId || !clientSecret) {
    throw new Error(
      `Google Auth is not configured: ${missingGoogleLoginVars().join(', ')} must all be set`,
    );
  }
  return createGoogleOAuthClient({
    clientId,
    clientSecret,
    redirectUri,
    timeoutMs: GOOGLE_OAUTH_TIMEOUT_MS,
  });
}

export function googleLoginUrl(state: string): string {
  return loginClient().generateAuthUrl({
    access_type: 'online', // no refresh token needed for identity
    scope: LOGIN_SCOPE,
    state,
  });
}

/** Exchanges the login code and returns the verified Google identity. */
export async function verifyGoogleLogin(code: string) {
  const client = loginClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) throw new Error('Google identity failed to return id_token');

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: googleLoginOAuth().clientId,
  });
  const payload = ticket.getPayload();
  if (!payload || !payload.sub || !payload.email || payload.email_verified !== true) {
    throw new Error('Google identity failed to return valid ID or email in claims');
  }
  if (!payload.iss || !GOOGLE_ISSUERS.includes(payload.iss)) throw new Error('Invalid issuer');

  return { googleId: payload.sub, email: payload.email, name: payload.name || null };
}

// ─── Gmail ──────────────────────────────────────────────────────────────────

// Built per call, so the server starts without Gmail credentials and only these calls fail.
function gmailClient(timeoutMs = GOOGLE_OAUTH_TIMEOUT_MS) {
  const { clientId, clientSecret, redirectUri } = gmailOAuth();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'Gmail OAuth is not configured: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REDIRECT_URI must all be set',
    );
  }
  return createGoogleOAuthClient({ clientId, clientSecret, redirectUri, timeoutMs });
}

export function gmailConsentUrl(state: string): string {
  // Fail before the user sees Google's consent screen, not after, when the grant cannot be saved.
  loadEncryptionKey();
  return gmailClient().generateAuthUrl({
    access_type: 'offline',
    scope: GMAIL_SCOPE,
    prompt: 'consent', // Always ask for consent, so Google returns a refresh token.
    state,
  });
}

/** Exchanges the consent code for the mailbox address and its tokens. */
export async function exchangeGmailCode(code: string) {
  const client = gmailClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token) {
    throw new Error('Google token exchange did not return an access_token');
  }

  client.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: client });
  const profile = await gmail.users.getProfile({ userId: 'me' }, gmailCallOptions());
  const gmailEmail = profile.data.emailAddress;
  if (!gmailEmail) throw new Error('Could not determine Gmail address from Google profile');

  return {
    gmailEmail,
    grant: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiryDate: tokens.expiry_date,
    },
  };
}

/** Best effort: a failed revoke must not block disconnecting. Takes the stored (encrypted) token. */
export async function revokeGmailAccess(encryptedAccessToken: string): Promise<void> {
  try {
    await gmailClient(GOOGLE_REVOKE_TIMEOUT_MS).revokeToken(decryptToken(encryptedAccessToken));
  } catch (error) {
    logWarn('gmail_revocation_failed', {
      category: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}
