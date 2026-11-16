import type { Request, Response } from 'express';
import {
  ipKeyGenerator,
  rateLimit,
  type AugmentedRequest,
  type Options,
  type RateLimitInfo,
} from 'express-rate-limit';
import { rateLimitsOn } from '../utils/config';
import { logWarn } from '../utils/log';

/**
 * Request limits, counted in this server's memory (the API runs as one server). Over a limit the
 * answer is 429 with the seconds to wait; the app shows its message. `RATE_LIMITS=off` turns them
 * all off. `/health` and `/ready` have none: they are answered before these run.
 */

const MINUTE_MS = 60_000;

/** Signed in: per user. The app's own polling stays far below this. */
export const SIGNED_IN_PER_MINUTE = 600;
/** Not signed in: per network address. */
export const SIGNED_OUT_PER_MINUTE = 120;
/** Password and Google sign-in: per network address. */
export const SIGN_IN_PER_MINUTE = 20;
/** NorthList Apply: per network address before the token check, then per token. */
export const MCP_ADDRESS_PER_MINUTE = 120;
export const MCP_TOKEN_PER_MINUTE = 60;

/** The routes that start or check a sign-in, below `/api/auth`. */
const SIGN_IN_ROUTES = new Set([
  'POST /login',
  'POST /test-login',
  'POST /register',
  'POST /password',
  'GET /connect',
  'GET /callback',
]);

export const addressKey = (req: Request) => `address:${ipKeyGenerator(req.ip ?? '')}`;

function retryAfterSeconds(info: RateLimitInfo | undefined): number {
  const resetAt = info?.resetTime?.getTime() ?? Date.now() + MINUTE_MS;
  return Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
}

/** One log line per key and window: the first request over the limit. */
function noteFirstRefusal(name: string, info: RateLimitInfo | undefined, req: Request) {
  if (info && info.used === info.limit + 1)
    logWarn('rate_limited', {
      limit: name,
      perMinute: info.limit,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      userId: req.session?.userId,
    });
}

const TOO_MANY = 'Too many requests. Wait a minute and try again.';

/** The usual answer over a limit; `/mcp` gives its own JSON-RPC one. */
function refuseJson(_req: Request, res: Response, seconds: number) {
  res.status(429).json({
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: TOO_MANY,
      details: { retryAfterSeconds: seconds },
    },
  });
}

export function limiter(
  name: string,
  options: Pick<Options, 'limit' | 'keyGenerator'> & {
    applies?: (req: Request) => boolean;
    refuse?: (req: Request, res: Response, seconds: number) => void;
  },
) {
  return rateLimit({
    windowMs: MINUTE_MS,
    limit: options.limit,
    keyGenerator: options.keyGenerator,
    skip: (req) => !rateLimitsOn() || (options.applies ? !options.applies(req) : false),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req: Request, res: Response, _next, used: Options) => {
      const info = (req as AugmentedRequest)[used.requestPropertyName];
      const seconds = retryAfterSeconds(info);
      noteFirstRefusal(name, info, req);
      res.setHeader('Retry-After', String(seconds));
      (options.refuse ?? refuseJson)(req, res, seconds);
    },
  });
}

/** Mounted on `/api/auth`, before its routes: only the sign-in routes count. */
export const signInLimit = limiter('sign_in', {
  limit: SIGN_IN_PER_MINUTE,
  keyGenerator: addressKey,
  applies: (req) => SIGN_IN_ROUTES.has(`${req.method} ${req.path}`),
});

/** Mounted on `/api`, after the session: per user when signed in, else per network address. */
export const apiLimit = limiter('api', {
  limit: (req) => (req.session?.userId ? SIGNED_IN_PER_MINUTE : SIGNED_OUT_PER_MINUTE),
  keyGenerator: (req) =>
    req.session?.userId ? `user:${req.session.userId}` : addressKey(req as Request),
});
