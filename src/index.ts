import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import { validateProductionConfig, validateRequiredSecrets } from './utils/config';
import { logEvent, logWarn } from './utils/log';
import { createMcpRouter } from './mcp/router';
import { healthRouter } from './routes/health';
import { requestContext } from './middleware/requestContext';

dotenv.config();
validateProductionConfig(process.env);
// Fail at startup, not inside the first request that needs a key. Tests set their own keys.
if (process.env.NODE_ENV !== 'test') validateRequiredSecrets(process.env);

if (
  process.env.ENABLE_DEV_AUTH === 'true' &&
  process.env.NODE_ENV !== 'test' &&
  process.env.NODE_ENV !== 'production'
) {
  logWarn('config_warning', {
    message: 'ENABLE_DEV_AUTH is ignored outside NODE_ENV=test; use Google login.',
  });
}

// ── Startup configuration warnings ───────────────────────────────────────────
// These surface missing required env vars at startup rather than at request time.
if (!process.env.SESSION_SECRET) {
  logWarn('config_warning', {
    message:
      'SESSION_SECRET is not set — using an insecure dev default. ' +
      'Set SESSION_SECRET in .env before running in any shared or production environment.',
  });
}
if (!process.env.FRONTEND_URL) {
  logWarn('config_warning', {
    message:
      'FRONTEND_URL is not set — defaulting to http://localhost:5173 (Vite dev server). ' +
      'Set FRONTEND_URL in .env for production.',
  });
}
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
// Explicit deployment setting; never trust arbitrary forwarded headers by default.
if (process.env.TRUST_PROXY_HOPS) app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS));
const port = process.env.PORT || 3000;

// Request ID and one line per request, before everything else so every route is covered.
app.use(requestContext);

// MCP endpoint (ADR-0002). Mounted right after the request ID, before CORS, the global JSON
// parser, cookies and session: its own 32 KB body limit must apply, and it accepts only Bearer
// integration tokens.
app.use('/mcp', createMcpRouter());
app.use(healthRouter);

// Default to the Vite dev server port so CORS works in local development
// without requiring FRONTEND_URL to be set.
app.use(cors({ credentials: true, origin: process.env.FRONTEND_URL ?? 'http://localhost:5173' }));
app.use(express.json());
// cookie-parser with a secret enables signed cookies used for OAuth state (CSRF protection).
// OAUTH_STATE_COOKIE_SECRET is a required env var when Gmail OAuth routes are used.
app.use(cookieParser(process.env.OAUTH_STATE_COOKIE_SECRET ?? 'dev-cookie-secret-change-in-prod'));

// --- Session Setup ---
const PgStore = pgSession(session);
const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

app.use(
  session({
    store: new PgStore({
      pool: dbPool,
      tableName: 'session',
    }),
    secret: process.env.SESSION_SECRET || 'dev-session-secret-change-in-prod',
    resave: false,
    saveUninitialized: false,
    name: 'cc_session',
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  }),
);

import { authRouter } from './routes/auth';
import { applicationRouter } from './routes/application';
import { gmailRouter } from './routes/gmail';
import { emailRouter } from './routes/email';
import { workspaceRouter } from './routes/workspace';
import { agendaRouter } from './routes/agenda';
import { actionRouter } from './routes/action';
import { aiRouter } from './routes/ai';
import { integrationTokenRouter } from './routes/integrationTokens';
import { submissionRouter } from './routes/submissions';
import { errorHandler } from './middleware/error';

app.use('/api/auth', authRouter);
app.use('/api/applications', applicationRouter);
app.use('/api/gmail', gmailRouter);
app.use('/api/emails', emailRouter);
app.use('/api/actions', actionRouter);
app.use('/api/agenda', agendaRouter);
app.use('/api/workspace', workspaceRouter);
app.use('/api/ai', aiRouter);
app.use('/api/integration-tokens', integrationTokenRouter);
app.use('/api/submissions', submissionRouter);

app.use(errorHandler);

import { startWorkers } from './jobs/startWorkers';
import { stopQueue } from './services/queue';
import { prisma } from './db/prisma';

if (process.env.NODE_ENV !== 'test') {
  let shuttingDown = false;
  void startWorkers(undefined, { isShuttingDown: () => shuttingDown });

  const server = app.listen(port, () => {
    logEvent('server_started', { port });
  });

  const shutdown = async () => {
    shuttingDown = true;
    logEvent('server_stopping');
    server.close(async () => {
      await stopQueue();
      await prisma.$disconnect();
      logEvent('server_stopped');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export { app };
