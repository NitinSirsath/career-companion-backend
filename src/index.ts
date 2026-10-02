import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import { validateProductionConfig } from './utils/config';
import { createMcpRouter } from './mcp/router';
import { healthRouter } from './routes/health';

dotenv.config();
validateProductionConfig(process.env);

// ── Startup configuration warnings ───────────────────────────────────────────
// These surface missing required env vars at startup rather than at request time.
if (!process.env.SESSION_SECRET) {
  console.warn(
    '[Config] SESSION_SECRET is not set — using an insecure dev default. ' +
      'Set SESSION_SECRET in .env before running in any shared or production environment.',
  );
}
if (!process.env.FRONTEND_URL) {
  console.warn(
    '[Config] FRONTEND_URL is not set — defaulting to http://localhost:5173 (Vite dev server). ' +
      'Set FRONTEND_URL in .env for production.',
  );
}
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
// Explicit deployment setting; never trust arbitrary forwarded headers by default.
if (process.env.TRUST_PROXY_HOPS) app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS));
const port = process.env.PORT || 3000;

// MCP endpoint (ADR-0002). Mounted FIRST, before CORS, the global JSON parser, cookies and session:
// its own 32 KB body limit must apply, and it accepts only Bearer integration tokens.
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
    console.log(`Backend server is running on port ${port}`);
  });

  const shutdown = async () => {
    shuttingDown = true;
    console.log('Shutting down server...');
    server.close(async () => {
      console.log('HTTP server closed.');
      await stopQueue();
      await prisma.$disconnect();
      console.log('Resources released.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export { app };
