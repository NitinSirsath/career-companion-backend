import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { ActionService } from '../services/action';
import { UpdateActionRequestSchema } from '../contracts';

const router = Router();
router.use(requireAuth);

/**
 * GET /api/actions
 * Returns a list of actions for the authenticated user, optionally filtered by status.
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.auth!.user.id;
    const status = req.query.status as string | undefined;

    const actions = await ActionService.getUserActions(userId, status);
    res.status(200).json(actions);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/actions/:id
 * Updates an action (e.g. status completion/dismissal).
 */
router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.auth!.user.id;
    const actionId = req.params.id;
    const data = UpdateActionRequestSchema.parse(req.body);

    const updated = await ActionService.updateActionStatus(userId, actionId, data.status);

    if (!updated) {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Action not found or access denied',
        }
      });
    }

    res.status(200).json(updated);
  } catch (err) {
    next(err);
  }
});

export const actionRouter = router;
