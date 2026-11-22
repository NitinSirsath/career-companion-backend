/**
 * Review of automation submissions that need a person (ADR-0002 decision 7).
 *
 *   GET  /api/submissions/pending       owner's NEEDS_REVIEW submissions, newest first
 *   GET  /api/submissions/not-submitted owner's jobs the automation did not apply to, newest first
 *   POST /api/submissions/:id/resolve   { action: link, applicationId } | { action: create } | { action: ignore }
 *   POST /api/submissions/portal-accounts/:id/password   the owner's saved portal password (21 Nov 2026)
 *
 * Errors follow the email resolve route: 404 NOT_FOUND (missing or foreign submission),
 * 400 BAD_REQUEST (no longer NEEDS_REVIEW: resolution is final), 403 FORBIDDEN (foreign or
 * absent application).
 */
import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import {
  NotSubmittedJob,
  PendingSubmission,
  PortalPasswordResponse,
  ResolveSubmissionRequestSchema,
} from '../contracts/submission';
import { requireAuth } from '../middleware/auth';
import { listPendingSubmissions, resolveSubmission } from '../services/externalSubmission';
import { listNotSubmittedJobs } from '../services/notSubmittedJob';
import { PortalPasswordUnreadableError, revealPortalPassword } from '../services/portalAccount';
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

router.get('/not-submitted', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { limit, offset } = getPaginationParams(req.query);
    const rows = await listNotSubmittedJobs(req.auth!.user.id, limit, offset);
    const items: NotSubmittedJob[] = rows.map((row) => ({
      ...row,
      loggedAt: row.loggedAt.toISOString(),
      receivedAt: row.receivedAt.toISOString(),
    }));
    res.status(200).json(createPaginatedResponse(items, limit, offset));
  } catch (err) {
    next(err);
  }
});

/**
 * Opens the owner's saved password for one portal account. POST so it is never cached or prefetched;
 * the answer is marked no-store. 404 when the account is not theirs or has no password; 503 when
 * the server cannot open it (key missing or changed). The password is never logged.
 */
router.post(
  '/portal-accounts/:id/password',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = z.uuid().safeParse(req.params.id);
      if (!id.success)
        return res
          .status(404)
          .json({ error: { code: 'NOT_FOUND', message: 'No saved password.' } });
      const password = await revealPortalPassword(req.auth!.user.id, id.data);
      const body: PortalPasswordResponse = { password };
      res.set('Cache-Control', 'no-store').status(200).json(body);
    } catch (err) {
      if (err instanceof PortalPasswordUnreadableError)
        return res.status(503).json({
          error: { code: 'PASSWORD_UNREADABLE', message: 'The saved password cannot be opened.' },
        });
      next(err);
    }
  },
);

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
