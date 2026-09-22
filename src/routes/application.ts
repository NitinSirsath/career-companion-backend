import { Router, Request, Response, NextFunction } from 'express';
import { CreateApplicationRequestSchema } from '../contracts';
import { ApplicationService } from '../services/application';
import { requireAuth } from '../middleware/auth';

import { getPaginationParams, createPaginatedResponse } from '../utils/pagination';

const router = Router();

router.use(requireAuth);

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = CreateApplicationRequestSchema.parse(req.body);
    const userId = req.auth!.user.id;

    const application = await ApplicationService.createApplication(userId, data);
    res.status(201).json(application);
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.auth!.user.id;
    const { limit, offset } = getPaginationParams(req.query);

    const applications = await ApplicationService.listApplications(userId, limit, offset);
    res.status(200).json(createPaginatedResponse(applications, limit, offset));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/applications/:id/events
 * Returns the timeline events for a specific application.
 * Enforces user ownership — returns 403 if the application does not belong to
 * the authenticated user. Events are ordered chronologically (createdAt ASC).
 */
router.get('/:id/events', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.auth!.user.id;
    const id = req.params['id'] as string;

    const events = await ApplicationService.getApplicationEvents(userId, id);

    if (events === null) {
      // Either not found or belongs to another user — return 403 to avoid
      // leaking whether the application ID exists at all.
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Access denied',
        },
      });
    }

    return res.status(200).json(events);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/applications/:id/actions
 * Returns actions for a specific application.
 * Enforces user ownership — returns 403 if not authorized.
 */
router.get('/:id/actions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.auth!.user.id;
    const id = req.params['id'] as string;

    const actions = await ApplicationService.getApplicationActions(userId, id);

    if (actions === null) {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Access denied',
        },
      });
    }

    return res.status(200).json(actions);
  } catch (err) {
    next(err);
  }
});

export const applicationRouter = router;
