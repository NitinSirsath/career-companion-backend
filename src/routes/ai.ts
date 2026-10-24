/**
 * AI settings routes for the session user (ADR-0001; BYO AI plan §5).
 *
 *   GET    /api/ai/settings                     the active setup and every connected provider
 *                                               (no key field of any kind)
 *   PUT    /api/ai/providers/:provider          connect a provider, replace its key or change its
 *                                               models (verifies first)
 *   POST   /api/ai/providers/:provider/activate make a connected provider the active one
 *   POST   /api/ai/providers/:provider/check    check a connected provider's key again
 *   DELETE /api/ai/providers/:provider          remove its key; ?then= names the next active one
 *   POST   /api/ai/settings/sample-test         run both capabilities on a built-in synthetic email
 *   POST   /api/ai/waiting/read                 during a pause, send one waiting mail first as a
 *                                               test; otherwise offer the waiting mail again
 *
 * The user always comes from the session; no route takes a user or configuration ID. Request
 * bodies are never logged, and validation errors never include submitted values.
 */
import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { RemoveAIProviderQuerySchema, SaveAIProviderRequestSchema } from '../contracts/ai';
import { requireAuth } from '../middleware/auth';
import {
  activateProvider,
  checkProvider,
  removeProvider,
  saveProvider,
} from '../services/ai/connections';
import { readingStatus } from '../services/ai/readingStatus';
import { readSettings, runSampleTest } from '../services/ai/settings';
import { readWaitingNow } from '../services/ai/waiting';

const router = Router();
router.use(requireAuth);

const EmptyBody = z.strictObject({});
const ProviderParam = z.object({ provider: z.string().min(1).max(64) });

function handle(action: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json(await action(req));
    } catch (err) {
      next(err);
    }
  };
}

const providerOf = (req: Request) => ProviderParam.parse(req.params).provider;

router.get(
  '/settings',
  handle((req) => readSettings(req.auth!.user.id)),
);

router.put(
  '/providers/:provider',
  handle((req) =>
    saveProvider(req.auth!.user.id, providerOf(req), SaveAIProviderRequestSchema.parse(req.body)),
  ),
);

router.post(
  '/providers/:provider/activate',
  handle((req) => {
    EmptyBody.parse(req.body ?? {});
    return activateProvider(req.auth!.user.id, providerOf(req));
  }),
);

router.post(
  '/providers/:provider/check',
  handle((req) => {
    EmptyBody.parse(req.body ?? {});
    return checkProvider(req.auth!.user.id, providerOf(req));
  }),
);

router.delete(
  '/providers/:provider',
  handle((req) =>
    removeProvider(
      req.auth!.user.id,
      providerOf(req),
      RemoveAIProviderQuerySchema.parse(req.query).then,
    ),
  ),
);

router.post(
  '/settings/sample-test',
  handle((req) => {
    EmptyBody.parse(req.body ?? {});
    return runSampleTest(req.auth!.user.id);
  }),
);

router.get(
  '/reading',
  handle((req) => readingStatus(req.auth!.user.id)),
);

router.post(
  '/waiting/read',
  handle((req) => {
    EmptyBody.parse(req.body ?? {});
    return readWaitingNow(req.auth!.user.id);
  }),
);

export const aiRouter = router;
