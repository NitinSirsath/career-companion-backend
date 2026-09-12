import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({ credentials: true, origin: process.env.FRONTEND_URL ?? 'http://localhost:3000' }));
app.use(express.json());
// cookie-parser with a secret enables signed cookies used for OAuth state (CSRF protection).
// OAUTH_STATE_COOKIE_SECRET is a required env var when Gmail OAuth routes are used.
app.use(cookieParser(process.env.OAUTH_STATE_COOKIE_SECRET ?? 'dev-cookie-secret-change-in-prod'));

import { applicationRouter } from './routes/application';
import { gmailRouter } from './routes/gmail';
import { errorHandler } from './middleware/error';

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Career Companion Backend is healthy.' });
});

app.use('/api/applications', applicationRouter);
app.use('/api/gmail', gmailRouter);

app.use(errorHandler);

if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`Backend server is running on port ${port}`);
  });
}

export { app };
