import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

import { applicationRouter } from './routes/application';
import { errorHandler } from './middleware/error';

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Career Companion Backend is healthy.' });
});

app.use('/api/applications', applicationRouter);

app.use(errorHandler);

if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`Backend server is running on port ${port}`);
  });
}

export { app };
