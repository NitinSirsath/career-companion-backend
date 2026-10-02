/**
 * POST /mcp — the Streamable HTTP MCP endpoint (ADR-0002 decisions 1, 10, 11, 13; MCP-04).
 *
 * Mounted in index.ts BEFORE every global middleware (CORS, JSON parser, cookies, session), so:
 *   - the route-local 32 KB JSON limit is the one that applies;
 *   - no session is ever read here: only a Bearer integration token authenticates;
 *   - no CORS headers are added, so a web page cannot read responses.
 *
 * Order: one log line per request → POST only (405) → Host allowlist (403) → Origin allowlist
 * (403; requests without Origin pass) → Bearer token (401) → 32 KB JSON → MCP handler.
 *
 * Built on the SDK's runtime-neutral core (`@modelcontextprotocol/server` + `/node`), not the
 * Express add-on, which re-types `req.auth` for the whole app. The verified AuthInfo is handed to
 * the SDK on a small request view; the app-wide `req.auth` (session user) is never touched.
 */
import express, { NextFunction, Request, Response, Router } from 'express';
import {
  AuthInfo,
  OAuthError,
  OAuthErrorCode,
  bearerAuthChallengeResponse,
  createMcpHandler,
  validateHostHeader,
  validateOriginHeader,
  verifyBearerToken,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { TOKEN_SCOPE, verifyIntegrationToken } from '../services/integrationTokens';
import { McpCallRecord, currentCall, rpcMethodOf, runWithCall, writeCallLog } from './callLog';
import { mcpConfig } from './config';
import { createMcpServer } from './server';

export const MCP_BODY_LIMIT = 32 * 1024;
const REQUIRED_SCOPES = [TOKEN_SCOPE];

const verifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const verified = await verifyIntegrationToken(token);
    if (!verified) throw new OAuthError(OAuthErrorCode.InvalidToken, 'The token is invalid, expired or revoked');
    return {
      // The plaintext is not carried past verification.
      token: verified.tokenId,
      clientId: verified.tokenId,
      scopes: [verified.scope],
      expiresAt: Math.floor(verified.expiresAt.getTime() / 1000),
      extra: { userId: verified.userId, tokenId: verified.tokenId },
    };
  },
};

/** A hostname for the log: hostname characters only, bounded; anything else is summarised. */
const loggableHostname = (hostname: string | undefined) =>
  hostname && /^[A-Za-z0-9.:[\]-]{1,253}$/.test(hostname) ? hostname.toLowerCase() : 'unparseable';

const jsonRpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

const callOf = (res: Response) => res.locals.mcpCall as McpCallRecord;

function reject(res: Response, status: number, outcome: string, message: string) {
  callOf(res).outcome = outcome;
  res.status(status).json(jsonRpcError(-32000, message));
}

async function sendWebResponse(res: Response, response: globalThis.Response) {
  res.status(response.status);
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.send(Buffer.from(await response.arrayBuffer()));
}

export function createMcpRouter(config = mcpConfig()) {
  const router = Router();
  const mcpHandler = createMcpHandler((ctx) => createMcpServer(ctx.authInfo), {
    onerror: (err) => {
      const call = currentCall();
      if (call && !call.errorCategory) call.errorCategory = err.name;
    },
  });
  const nodeHandler = toNodeHandler(mcpHandler, {
    maxRequestBodySize: MCP_BODY_LIMIT,
    onerror: (err) => {
      const call = currentCall();
      if (call) call.errorCategory = err.name;
    },
  });

  router.use((req: Request, res: Response, next: NextFunction) => {
    const record: McpCallRecord = { startedAt: Date.now() };
    res.locals.mcpCall = record;
    res.on('finish', () => writeCallLog(record, res.statusCode));
    next();
  });

  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'POST') return next();
    res.setHeader('Allow', 'POST');
    reject(res, 405, 'method_not_allowed', 'Method not allowed.');
  });

  router.use((req: Request, res: Response, next: NextFunction) => {
    // The rejected hostname is logged (never echoed) so an allowlist can be configured from it.
    const host = validateHostHeader(req.headers.host, config.allowedHosts);
    if (!host.ok) {
      callOf(res).rejectedHost = loggableHostname(host.hostname);
      return reject(res, 403, 'host_not_allowed', 'Host not allowed.');
    }
    const origin = validateOriginHeader(req.headers.origin, config.allowedOrigins);
    if (!origin.ok) {
      callOf(res).rejectedOriginHost = loggableHostname(origin.hostname);
      return reject(res, 403, 'origin_not_allowed', 'Origin not allowed.');
    }
    next();
  });

  router.use(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authInfo = await verifyBearerToken(req.headers.authorization, { verifier, requiredScopes: REQUIRED_SCOPES });
      const extra = authInfo.extra as { userId: string; tokenId: string };
      Object.assign(callOf(res), { userId: extra.userId, tokenId: extra.tokenId });
      res.locals.mcpAuth = authInfo;
      next();
    } catch (err) {
      const call = callOf(res);
      call.outcome = 'unauthorized';
      if (!(err instanceof OAuthError)) call.errorCategory = err instanceof Error ? err.name : 'UnknownError';
      await sendWebResponse(res, bearerAuthChallengeResponse(err, { requiredScopes: REQUIRED_SCOPES }));
    }
  });

  router.use(express.json({ limit: MCP_BODY_LIMIT }));

  router.post('/', (req: Request, res: Response) => {
    const call = callOf(res);
    call.rpcMethod = rpcMethodOf(req.body);
    // Credentials stay out of the SDK: authentication is already done.
    const headers = { ...req.headers };
    delete headers.authorization;
    delete headers.cookie;
    const view = {
      method: req.method,
      url: req.originalUrl,
      headers,
      auth: res.locals.mcpAuth as AuthInfo,
      [Symbol.asyncIterator]: () => req[Symbol.asyncIterator](),
    };
    // Re-enter the call's context: body parsing ran on the socket's own async context.
    return runWithCall(call, () => nodeHandler(view, res, req.body));
  });

  router.use((req: Request, res: Response) => reject(res, 404, 'not_found', 'Not found.'));

  // Router-level errors (body limit, malformed JSON): JSON-RPC errors, never a stack trace.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  router.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const type = (err as { type?: unknown })?.type;
    if (res.headersSent) return;
    if (type === 'entity.too.large') return reject(res, 413, 'body_too_large', 'Request body too large.');
    if (type === 'entity.parse.failed') {
      callOf(res).outcome = 'invalid_json';
      return res.status(400).json(jsonRpcError(-32700, 'Parse error.'));
    }
    const status = (err as { status?: unknown })?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) return reject(res, status, 'bad_request', 'Bad request.');
    callOf(res).errorCategory = err instanceof Error ? err.name : 'UnknownError';
    reject(res, 500, 'error', 'Internal error.');
  });

  return router;
}
