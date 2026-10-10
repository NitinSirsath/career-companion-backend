import { CorrectEmailMatchRequestSchema } from '../contracts/email';
import { z } from 'zod';
import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  correctEmailMatch,
  getAmbiguousMatches,
  getUnmatchedEmails,
  resolveEmailMatch,
} from '../services/matcher';
import { ResolveAmbiguityRequestSchema, RetryEmailRequestSchema } from '../contracts/email';

import { getPaginationParams, createPaginatedResponse } from '../utils/pagination';
import { retryEmail } from '../services/email';

const router = Router();

router.use(requireAuth);

router.patch('/:id/match', async (req, res, next) => {
  try {
    const id = z.uuid().parse(req.params.id);
    const body = CorrectEmailMatchRequestSchema.parse(req.body);
    res.json(await correctEmailMatch(req.auth!.user.id, id, body));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/emails/ambiguous
 * Returns a list of unresolved ambiguous emails.
 */
router.get('/ambiguous', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.auth!.user.id;
    const { limit, offset } = getPaginationParams(req.query);
    const emails = await getAmbiguousMatches(userId, limit, offset);

    // Map to response schema to omit any PII/raw bodies if they existed, though Prisma already doesn't load bodies
    const response = emails.map((email) => ({
      id: email.id,
      subject: email.subject,
      sender: email.sender,
      threadId: email.threadId,
      gmailMessageId: email.gmailMessageId,
      receivedAt: email.receivedAt ? email.receivedAt.toISOString() : null,
      aiProcessingResult: email.aiProcessingResult
        ? {
            companyName: email.aiProcessingResult.companyName,
            jobTitle: email.aiProcessingResult.jobTitle,
            confidence: email.aiProcessingResult.confidence,
            category: email.aiProcessingResult.category,
            provider: email.aiProcessingResult.provider,
            model: email.aiProcessingResult.model,
          }
        : null,
    }));

    res.status(200).json(createPaginatedResponse(response, limit, offset));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/emails/unmatched
 * Returns a list of relevant emails with zero candidate applications.
 * These emails are RELEVANT but UNMATCHED and need user-driven linking.
 */
router.get('/unmatched', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.auth!.user.id;
    const { limit, offset } = getPaginationParams(req.query);
    const emails = await getUnmatchedEmails(userId, limit, offset);

    const response = emails.map((email) => ({
      id: email.id,
      subject: email.subject,
      sender: email.sender,
      threadId: email.threadId,
      gmailMessageId: email.gmailMessageId,
      receivedAt: email.receivedAt ? email.receivedAt.toISOString() : null,
      aiProcessingResult: email.aiProcessingResult
        ? {
            companyName: email.aiProcessingResult.companyName,
            jobTitle: email.aiProcessingResult.jobTitle,
            confidence: email.aiProcessingResult.confidence,
            category: email.aiProcessingResult.category,
            provider: email.aiProcessingResult.provider,
            model: email.aiProcessingResult.model,
          }
        : null,
    }));

    res.status(200).json(createPaginatedResponse(response, limit, offset));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/emails/:id/resolve
 * Resolves an ambiguous or unmatched email by linking to an application.
 * For AMBIGUOUS: applicationId can be null (→ IGNORED) or a valid application ID.
 * For UNMATCHED: applicationId must be non-null.
 */
router.post('/:id/resolve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.auth!.user.id;
    const emailId = z.uuid().parse(req.params.id);
    const data = ResolveAmbiguityRequestSchema.parse(req.body);

    try {
      await resolveEmailMatch(userId, emailId, data.applicationId);
      res.status(200).json({ success: true });
    } catch (e) {
      const err = e as Error;
      if (err.message === 'EMAIL_NOT_FOUND') {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Email not found.' } });
      } else if (err.message === 'INVALID_MATCH_STATE') {
        res
          .status(400)
          .json({ error: { code: 'BAD_REQUEST', message: 'Email is not in a resolvable state.' } });
      } else if (err.message === 'APPLICATION_REQUIRED_FOR_UNMATCHED') {
        res.status(400).json({
          error: {
            code: 'BAD_REQUEST',
            message: 'An application must be selected for unmatched emails.',
          },
        });
      } else if (err.message === 'APPLICATION_NOT_FOUND') {
        res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Application not found or access denied.' },
        });
      } else if (err.message === 'NO_AI_RESULT') {
        res
          .status(400)
          .json({ error: { code: 'BAD_REQUEST', message: 'Email has no AI processing result.' } });
      } else {
        throw e;
      }
    }
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/emails/:id/retry
 * Re-offers a failed or stuck email to the email worker. Paid AI operation claims, completed
 * results and user match decisions are never reset here. Acknowledgment does not write processing
 * state: the worker alone moves the email into PROCESSING and its final outcome.
 *
 * Held operations are never replayed automatically (ADR-0001 decision 10). When the outcome was
 * uncertain or unusable, the user may approve exactly one more call by resending with
 * `{ acceptPossibleDuplicateCharge: true }`; without it the response explains the hold
 * (409 AI_RETRY_NEEDS_APPROVAL). Engineering failures and legacy partial results stay with the
 * operator (409 AI_OPERATION_REQUIRES_REVIEW).
 */
router.post('/:id/retry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.auth!.user.id;
    const emailId = z.uuid().parse(req.params.id);
    const { acceptPossibleDuplicateCharge } = RetryEmailRequestSchema.parse(req.body ?? {});

    await retryEmail(userId, emailId, acceptPossibleDuplicateCharge);
    res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
});

export const emailRouter = router;
