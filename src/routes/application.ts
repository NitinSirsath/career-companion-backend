import { z } from 'zod';
import { Router, Request, Response, NextFunction } from 'express';
import { CreateApplicationRequestSchema, UpdateApplicationStatusRequestSchema } from '../contracts';
import {
  ApplicationService,
  ApplicationNotFoundError,
  StatusConflictError,
} from '../services/application';
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
    const id = z.uuid().parse(req.params.id);
    const { limit, offset } = getPaginationParams(req.query);

    const events = await ApplicationService.getApplicationEvents(userId, id, limit, offset);

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

    return res.status(200).json(createPaginatedResponse(events, limit, offset));
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
    const id = z.uuid().parse(req.params.id);
    const { limit, offset } = getPaginationParams(req.query);

    const actions = await ApplicationService.getApplicationActions(userId, id, limit, offset);

    if (actions === null) {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Access denied',
        },
      });
    }

    return res.status(200).json(createPaginatedResponse(actions, limit, offset));
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/applications/:id/status
 * Owned manual status set/change/clear guarded by expectedUserStatusRevision.
 * 200 full canonical application · 400 VALIDATION_ERROR · 404 NOT_FOUND (missing or foreign)
 * · 409 STATUS_CONFLICT (stale revision; reload before a deliberate retry).
 */
router.patch('/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.auth!.user.id;
    const id = z.uuid().parse(req.params.id);
    const body = UpdateApplicationStatusRequestSchema.parse(req.body);
    const { application, changed } = await ApplicationService.updateUserStatus(userId, id, body);
    console.log(
      JSON.stringify({
        event: 'application_status_corrected',
        applicationId: id,
        changed,
        revision: application.userStatusRevision,
      }),
    );
    return res.status(200).json(application);
  } catch (err) {
    if (err instanceof ApplicationNotFoundError)
      return res.status(404).json({ error: { code: err.code, message: err.message } });
    if (err instanceof StatusConflictError)
      return res.status(409).json({ error: { code: err.code, message: err.message } });
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const application = await ApplicationService.getApplication(
      req.auth!.user.id,
      z.uuid().parse(req.params.id),
    );
    if (!application)
      return res
        .status(404)
        .json({ error: { code: 'NOT_FOUND', message: 'Application not found' } });
    return res.json(application);
  } catch (err) {
    next(err);
  }
});

export const applicationRouter = router;
