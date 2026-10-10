import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import {
  cookieSecret,
  databaseUrl,
  frontendUrl,
  isProduction,
  isTest,
  port,
  sessionSecret,
  startupWarnings,
  trustProxyHops,
  validateProductionConfig,
  validateRequiredSecrets,
} from './utils/config';
import { logEvent, logWarn } from './utils/log';
import { createMcpRouter } from './mcp/router';
import { healthRouter } from './routes/health';
import { requestContext } from './middleware/requestContext';

dotenv.config();
validateProductionConfig();
// Fail at startup, not inside the first request that needs a key. Tests set their own keys.
if (!isTest()) validateRequiredSecrets();
for (const message of startupWarnings()) logWarn('config_warning', { message });

const app = express();
// Explicit deployment setting; never trust arbitrary forwarded headers by default.
const proxyHops = trustProxyHops();
if (proxyHops) app.set('trust proxy', proxyHops);

// Request ID and one line per request, before everything else so every route is covered.
app.use(requestContext);

// MCP endpoint (ADR-0002). Mounted right after the request ID, before CORS, the global JSON
// parser, cookies and session: its own 32 KB body limit must apply, and it accepts only Bearer
// integration tokens.
app.use('/mcp', createMcpRouter());
app.use(healthRouter);

app.use(cors({ credentials: true, origin: frontendUrl() }));
app.use(express.json());
// cookie-parser with a secret enables signed cookies used for OAuth state (CSRF protection).
app.use(cookieParser(cookieSecret()));

// --- Session Setup ---
const PgStore = pgSession(session);
const dbPool = new Pool({
  connectionString: databaseUrl(),
});

app.use(
  session({
    store: new PgStore({
      pool: dbPool,
      tableName: 'session',
    }),
    secret: sessionSecret(),
    resave: false,
    saveUninitialized: false,
    name: 'cc_session',
    cookie: {
      httpOnly: true,
      secure: isProduction(),
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
import { testToolsRouter } from './routes/testTools';
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
// Manual test environment only: answers 404 unless test tools are on (utils/config.ts).
app.use('/api/test-tools', testToolsRouter);

app.use(errorHandler);

import { startWorkers } from './jobs/startWorkers';
import { stopQueue } from './services/queue';
import { prisma } from './db/prisma';

if (!isTest()) {
  let shuttingDown = false;
  void startWorkers(undefined, { isShuttingDown: () => shuttingDown });

  const server = app.listen(port(), () => {
    logEvent('server_started', { port: port() });
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
