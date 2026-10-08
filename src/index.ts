import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import { validateProductionConfig, validateRequiredSecrets } from './utils/config';
import { createMcpRouter } from './mcp/router';
import { healthRouter } from './routes/health';
import { requestContext } from './middleware/requestContext';
import { logEvent, logWarn } from './utils/log';

dotenv.config();
validateProductionConfig(process.env);
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

if (!process.env.SESSION_SECRET) {
  logWarn('config_warning', {
    message:
      '[Config] SESSION_SECRET is not set — using an insecure dev default. Set SESSION_SECRET in .env before running in any shared or production environment.',
  });
}
if (!process.env.FRONTEND_URL) {
  logWarn('config_warning', {
    message:
      '[Config] FRONTEND_URL is not set — defaulting to http://localhost:5173 (Vite dev server). Set FRONTEND_URL in .env for production.',
  });
}

const app = express();
if (process.env.TRUST_PROXY_HOPS) app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS));
const port = process.env.PORT || 3000;

app.use(requestContext);
app.use('/mcp', createMcpRouter());
app.use(healthRouter);

app.use(cors({ credentials: true, origin: process.env.FRONTEND_URL ?? 'http://localhost:5173' }));
app.use(express.json());
app.use(cookieParser(process.env.OAUTH_STATE_COOKIE_SECRET ?? 'dev-cookie-secret-change-in-prod'));

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
      maxAge: 30 * 24 * 60 * 60 * 1000,
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
