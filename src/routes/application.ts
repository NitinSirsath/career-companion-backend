import { archiveApplication } from '../services/archive';
import { createFollowUp } from '../services/action';
import { CreateFollowUpSchema, ArchiveApplicationSchema } from '../contracts';
import { z } from 'zod';
import { Router, Request, Response, NextFunction } from 'express';
import {
  ApplicationFiltersSchema,
  CreateApplicationRequestSchema,
  UpdateApplicationStatusRequestSchema,
} from '../contracts';
import {
  createApplication,
  getApplication,
  getApplicationActions,
  getApplicationEvents,
  listApplications,
  updateUserStatus,
} from '../services/application';
import { requireAuth } from '../middleware/auth';
import { ApplicationSubmission, SubmittedAnswerSchema } from '../contracts/submission';
import { listApplicationSubmissions } from '../services/externalSubmission';

import { getPaginationParams, createPaginatedResponse } from '../utils/pagination';
import { logEvent } from '../utils/log';

const router = Router();

router.use(requireAuth);

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = CreateApplicationRequestSchema.parse(req.body);
    const userId = req.auth!.user.id;

    const application = await createApplication(userId, data);
    res.status(201).json(application);
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.auth!.user.id;
    const { limit, offset } = getPaginationParams(req.query);

    const applications = await listApplications(
      userId,
      limit,
      offset,
      ApplicationFiltersSchema.parse(req.query),
    );
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

    const events = await getApplicationEvents(userId, id, limit, offset);

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

    const actions = await getApplicationActions(userId, id, limit, offset);

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
 * GET /api/applications/:id/submissions
 * Everything the automation reported for this application (ADR-0002, amended 21 Oct 2026),
 * newest first. 403 when the application is missing or belongs to another user, as for events.
 */
router.get('/:id/submissions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await listApplicationSubmissions(req.auth!.user.id, z.uuid().parse(req.params.id));
    if (rows === null)
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
    const items: ApplicationSubmission[] = rows.map(({ submittedAnswers, ...row }) => ({
      ...row,
      matchState: row.matchState as ApplicationSubmission['matchState'],
      submittedAt: row.submittedAt.toISOString(),
      receivedAt: row.receivedAt.toISOString(),
      // Stored JSON is re-checked; anything that is not a question-answer pair is left out.
      submittedAnswers: z
        .array(SubmittedAnswerSchema)
        .catch([])
        .parse(submittedAnswers ?? []),
    }));
    return res.status(200).json({ items });
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
    const { application, changed } = await updateUserStatus(userId, id, body);
    logEvent('application_status_corrected', {
      applicationId: id,
      changed,
      revision: application.userStatusRevision,
    });
    return res.status(200).json(application);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/actions', async (req, res, next) => {
  try {
    res
      .status(201)
      .json(
        await createFollowUp(
          req.auth!.user.id,
          z.uuid().parse(req.params.id),
          CreateFollowUpSchema.parse(req.body),
        ),
      );
  } catch (error) {
    next(error);
  }
});
router.patch('/:id/archive', async (req, res, next) => {
  try {
    res.json(
      await archiveApplication(
        req.auth!.user.id,
        z.uuid().parse(req.params.id),
        ArchiveApplicationSchema.parse(req.body),
      ),
    );
  } catch (error) {
    next(error);
  }
});
router.get('/:id', async (req, res, next) => {
  try {
    const application = await getApplication(req.auth!.user.id, z.uuid().parse(req.params.id));
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
