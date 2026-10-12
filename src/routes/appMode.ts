/**
 * App mode (see the app mode section of utils/config.ts).
 *
 *   GET /api/app-mode   { mode: 'dev' | 'prod' }
 *
 * Public: the login page needs it before anyone is signed in. It tells nothing else.
 */
import { Request, Response, Router } from 'express';
import type { AppModeResponse } from '../contracts/appMode';
import { appMode } from '../utils/config';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  const body: AppModeResponse = { mode: appMode() };
  res.set('Cache-Control', 'no-store').status(200).json(body);
});

export const appModeRouter = router;
