/**
 * Review of automation submissions that need a person (ADR-0002 decision 7; MCP-05).
 *
 *   GET  /api/submissions/pending       owner's NEEDS_REVIEW submissions, newest first
 *   POST /api/submissions/:id/resolve   { action: link, applicationId } | { action: create } | { action: ignore }
 *
 * Errors follow the email resolve route: 404 NOT_FOUND (missing or foreign submission),
 * 400 BAD_REQUEST (no longer NEEDS_REVIEW: resolution is final), 403 FORBIDDEN (foreign or
 * absent application).
 */
import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { PendingSubmission, ResolveSubmissionRequestSchema } from '../contracts/submission';
import { requireAuth } from '../middleware/auth';
import { listPendingSubmissions, resolveSubmission } from '../services/externalSubmission';
import { createPaginatedResponse, getPaginationParams } from '../utils/pagination';
import { logEvent } from '../utils/log';

const router = Router();
router.use(requireAuth);

router.get('/pending', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { limit, offset } = getPaginationParams(req.query);
    const rows = await listPendingSubmissions(req.auth!.user.id, limit, offset);
    const items: PendingSubmission[] = rows.map((row) => ({
      ...row,
      submittedAt: row.submittedAt.toISOString(),
      receivedAt: row.receivedAt.toISOString(),
    }));
    res.status(200).json(createPaginatedResponse(items, limit, offset));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/resolve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.auth!.user.id;
    const id = z.uuid().parse(req.params.id);
    const resolution = ResolveSubmissionRequestSchema.parse(req.body);
    const resolved = await resolveSubmission(userId, id, resolution);
    logEvent('submission_resolved', { userId, submissionId: id, matchState: resolved.matchState });
    res.status(200).json(resolved);
  } catch (err) {
    next(err);
  }
});

export const submissionRouter = router;
