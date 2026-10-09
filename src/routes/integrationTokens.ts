/**
 * Integration token routes for the session user (ADR-0002 decision 10; MCP-02).
 *
 *   POST   /api/integration-tokens       create; the only response with the plaintext token
 *   GET    /api/integration-tokens       list, newest first, offset pagination
 *   DELETE /api/integration-tokens/:id   revoke (keeps the row for the audit trail)
 *
 * The user always comes from the session. An integration token is never accepted here.
 */
import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { CreateIntegrationTokenRequestSchema } from '../contracts/integrationToken';
import { requireAuth } from '../middleware/auth';
import {
  createIntegrationToken,
  listIntegrationTokens,
  revokeIntegrationToken,
} from '../services/integrationTokens';
import { createPaginatedResponse, getPaginationParams } from '../utils/pagination';

const router = Router();
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

router.post(
  '/',
  handle(201, (req) =>
    createIntegrationToken(req.auth!.user.id, CreateIntegrationTokenRequestSchema.parse(req.body)),
  ),
);

router.get(
  '/',
  handle(200, async (req) => {
    const { limit, offset } = getPaginationParams(req.query);
    const items = await listIntegrationTokens(req.auth!.user.id, limit, offset);
    return createPaginatedResponse(items, limit, offset);
  }),
);

router.delete(
  '/:id',
  handle(200, (req) => revokeIntegrationToken(req.auth!.user.id, z.uuid().parse(req.params.id)),
);

export const integrationTokenRouter = router;
