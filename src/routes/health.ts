import { GMAIL_SCHEDULE_QUEUE, isGmailScheduleRegistered } from '../services/gmailSchedule';
import { gmailScheduleConfig } from '../utils/config';
import { Router } from 'express';
import { getStartedQueue, QUEUE_NAMES } from '../services/queue';
export const healthRouter = Router();
healthRouter.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', message: 'Career Companion Backend is healthy.' });
});
healthRouter.get('/ready', (_req, res) => {
  const active = getStartedQueue()?.getWipData() ?? [];
  const workers = Object.fromEntries(
    [...QUEUE_NAMES, ...(gmailScheduleConfig().enabled ? [GMAIL_SCHEDULE_QUEUE] : [])].map(
      (name) => [
        name,
        active.some(
          (worker) =>
            (name !== GMAIL_SCHEDULE_QUEUE || isGmailScheduleRegistered()) &&
            worker.name === name &&
            (worker.state === 'created' || worker.state === 'active'),
        )
          ? 'registered'
          : 'not_registered',
      ],
    ),
  );
  const ready = Object.values(workers).every((state) => state === 'registered');
  res
    .set('Cache-Control', 'no-store')
    .status(ready ? 200 : 503)
    .json({ status: ready ? 'ready' : 'not_ready', workers });
});
