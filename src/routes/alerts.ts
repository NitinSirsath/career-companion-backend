/**
 * Push alerts on the session user's devices (owner, 30 Oct 2026).
 *
 *   GET  /api/alerts/key          the public key a browser needs to turn alerts on, or
 *                                 "not available" when the server has no alert keys
 *   POST /api/alerts/devices      turn alerts on for this device and send it the first alert
 *   POST /api/alerts/devices/off  turn alerts off for this device
 *
 * The user always comes from the session. Request bodies are never logged: they hold the
 * device's keys.
 */
import { NextFunction, Request, Response, Router } from 'express';
import { TurnOffAlertsRequestSchema, TurnOnAlertsRequestSchema } from '../contracts/alerts';
import { requireAuth } from '../middleware/auth';
import { alertKey, turnOffAlerts, turnOnAlerts } from '../services/alerts';

const router = Router();
router.use(requireAuth);

function handle(action: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json(await action(req));
    } catch (err) {
      next(err);
    }
  };
}

router.get(
  '/key',
  handle(async () => alertKey()),
);

router.post(
  '/devices',
  handle((req) => turnOnAlerts(req.auth!.user.id, TurnOnAlertsRequestSchema.parse(req.body))),
);

router.post(
  '/devices/off',
  handle((req) => turnOffAlerts(req.auth!.user.id, TurnOffAlertsRequestSchema.parse(req.body))),
);

export const alertsRouter = router;
