/**
 * AI settings routes for the session user (ADR-0001; BYO AI plan §5).
 *
 *   GET    /api/ai/settings        status and configuration (no key field of any kind)
 *   PUT    /api/ai/settings        create, replace key, change models, switch provider (verifies first)
 *   POST   /api/ai/settings/check  re-verify the saved key ("Check again")
 *   POST   /api/ai/settings/sample-test  run both capabilities on a built-in synthetic email
 *   DELETE /api/ai/settings        remove the configuration and its key
 *
 * The user always comes from the session; no route takes a user or configuration ID. Request
 * bodies are never logged, and validation errors never include submitted values.
 */
import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { SaveAISettingsRequestSchema } from '../contracts/ai';
import { requireAuth } from '../middleware/auth';
import {
  checkSettings,
  readSettings,
  removeSettings,
  runSampleTest,
  saveSettings,
} from '../services/ai/settings';

const router = Router();
router.use(requireAuth);

const EmptyBody = z.strictObject({});

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
  '/settings',
  handle((req) => readSettings(req.auth!.user.id)),
);

router.put(
  '/settings',
  handle((req) => saveSettings(req.auth!.user.id, SaveAISettingsRequestSchema.parse(req.body))),
);

router.post(
  '/settings/check',
  handle((req) => {
    EmptyBody.parse(req.body ?? {});
    return checkSettings(req.auth!.user.id);
  }),
);

router.post(
  '/settings/sample-test',
  handle((req) => {
    EmptyBody.parse(req.body ?? {});
    return runSampleTest(req.auth!.user.id);
  }),
);

router.delete(
  '/settings',
  handle((req) => removeSettings(req.auth!.user.id)),
);

export const aiRouter = router;
