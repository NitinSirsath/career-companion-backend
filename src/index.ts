import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({ credentials: true, origin: process.env.FRONTEND_URL ?? 'http://localhost:3000' }));
app.use(express.json());
// cookie-parser with a secret enables signed cookies used for OAuth state (CSRF protection).
// OAUTH_STATE_COOKIE_SECRET is a required env var when Gmail OAuth routes are used.
app.use(cookieParser(process.env.OAUTH_STATE_COOKIE_SECRET ?? 'dev-cookie-secret-change-in-prod'));

// --- Session Setup ---
const PgStore = pgSession(session);
const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL
});

app.use(
  session({
    store: new PgStore({
      pool: dbPool,
      tableName: 'session'
    }),
    secret: process.env.SESSION_SECRET || 'dev-session-secret-change-in-prod',
    resave: false,
    saveUninitialized: false,
    name: 'cc_session',
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    }
  })
);

import { authRouter } from './routes/auth';
import { applicationRouter } from './routes/application';
import { gmailRouter } from './routes/gmail';
import { emailRouter } from './routes/email';
import { actionRouter } from './routes/action';
import { errorHandler } from './middleware/error';

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Career Companion Backend is healthy.' });
});

app.use('/api/auth', authRouter);
app.use('/api/applications', applicationRouter);
app.use('/api/gmail', gmailRouter);
app.use('/api/emails', emailRouter);
app.use('/api/actions', actionRouter);

app.use(errorHandler);

import { startEmailProcessingWorker } from './jobs/emailProcessingJob';
import { stopQueue } from './services/queue';
import { prisma } from './db/prisma';

if (process.env.NODE_ENV !== 'test') {
  startEmailProcessingWorker().catch(err => {
    console.error('Failed to start worker', err);
  });
  
  const server = app.listen(port, () => {
    console.log(`Backend server is running on port ${port}`);
  });

  const shutdown = async () => {
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
