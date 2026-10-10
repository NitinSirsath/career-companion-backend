/**
 * Test tools API (manual test environment only; see the test tools section of utils/config.ts).
 *
 *   GET  /api/test-tools/status   { enabled: true }
 *   POST /api/test-tools/emails   deliver one test email
 *   POST /api/test-tools/reset    delete this user's test data ({ confirm: 'RESET' })
 *
 * When test tools are off, every path answers 404 before authentication.
 */
import { NextFunction, Request, Response, Router } from 'express';
import { DeliverTestEmailRequestSchema, ResetTestDataRequestSchema } from '../contracts/testTools';
import { AppError } from '../errors';
import { requireAuth } from '../middleware/auth';
import { deliverTestEmail, resetTestData } from '../services/testTools/inbox';
import { testToolsEnabled } from '../utils/config';

const router = Router();

router.use((_req: Request, _res: Response, next: NextFunction) => {
  next(testToolsEnabled() ? undefined : new AppError(404, 'NOT_FOUND', 'Not found'));
});
router.use(requireAuth);

function handle(status: number, action: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json(await action(req));
    } catch (err) {
      next(err);
    }
  };
}

router.get('/status', (_req: Request, res: Response) => {
  res.status(200).json({ enabled: true });
});

router.post(
  '/emails',
  handle(201, (req) =>
    deliverTestEmail(req.auth!.user.id, DeliverTestEmailRequestSchema.parse(req.body)),
  ),
);

router.post(
  '/reset',
  handle(200, (req) => {
    ResetTestDataRequestSchema.parse(req.body);
    return resetTestData(req.auth!.user.id);
  }),
);

export const testToolsRouter = router;
