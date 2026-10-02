import { CorrectEmailMatchRequestSchema } from '../contracts/email';
import { z } from 'zod';
import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { MatcherService, MatchCorrectionError } from '../services/matcher';
import { ResolveAmbiguityRequestSchema, RetryEmailRequestSchema } from '../contracts/email';

import { getPaginationParams, createPaginatedResponse } from '../utils/pagination';

const router = Router();

router.use(requireAuth);

router.patch('/:id/match', async (req, res, next) => {
  try {
    const id = z.uuid().parse(req.params.id);
    const body = CorrectEmailMatchRequestSchema.parse(req.body);
    res.json(await MatcherService.correctEmailMatch(req.auth!.user.id, id, body));
  } catch (error) {
    if (error instanceof MatchCorrectionError) {
      const status =
        error.code === 'NOT_FOUND' || error.code === 'APPLICATION_NOT_FOUND' ? 404 : 409;
      return res
        .status(status)
        .json({
          error: {
            code: error.code,
            message:
              status === 404
                ? 'Email or application no longer available'
                : 'This email link changed or cannot be corrected. Refresh before trying again.',
          },
        });
    }
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
    const emails = await MatcherService.getAmbiguousMatches(userId, limit, offset);

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
    const emails = await MatcherService.getUnmatchedEmails(userId, limit, offset);

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
      await MatcherService.resolveEmailMatch(userId, emailId, data.applicationId);
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

    const { prisma } = await import('../db/prisma');
    const { enqueueEmailProcessingJob } = await import('../jobs/emailProcessingJob');
    const { holdOf } = await import('../services/ai/heldOperations');
    const { getAccessState } = await import('../services/ai/access');

    const email = await prisma.email.findFirst({
      where: { id: emailId, userId },
      select: {
        processingState: true,
        aiProcessingResult: { select: { processingStatus: true } },
        aiOperations: {
          select: {
            id: true,
            operation: true,
            version: true,
            status: true,
            attempts: true,
            approvedRetries: true,
            errorCode: true,
            startedAt: true,
            provider: true,
            model: true,
          },
        },
      },
    });
    if (!email) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Email not found.' } });
      return;
    }

    if (email.processingState === 'COMPLETED') {
      res
        .status(400)
        .json({ error: { code: 'BAD_REQUEST', message: 'Email is already completed.' } });
      return;
    }

    const now = new Date();
    const held = email.aiOperations.flatMap((op) => {
      const hold = holdOf(op, now);
      return hold ? [{ op, approvable: hold.approvable }] : [];
    });
    const legacyPartial =
      !!email.aiProcessingResult &&
      email.aiProcessingResult.processingStatus !== 'COMPLETED' &&
      email.aiOperations.length === 0;
    if (legacyPartial || held.some((h) => !h.approvable)) {
      res.status(409).json({
        error: {
          code: 'AI_OPERATION_REQUIRES_REVIEW',
          message: 'This email has an AI operation that needs review before it can be retried.',
        },
      });
      return;
    }

    let approval: number | undefined;
    if (held.length) {
      const config = await prisma.aIConfiguration.findUnique({
        where: { userId },
        select: { provider: true },
      });
      if (!acceptPossibleDuplicateCharge) {
        res.status(409).json({
          error: {
            code: 'AI_RETRY_NEEDS_APPROVAL',
            message:
              'The earlier AI attempt may already have been charged. Approve one more attempt to retry.',
            details: {
              operations: held.map(({ op, approvable }) => ({
                operation: op.operation,
                reason: approvable,
                provider: op.provider,
                model: op.model,
                attemptedAt: op.startedAt ? op.startedAt.toISOString() : null,
              })),
              currentProvider: config?.provider ?? null,
            },
          },
        });
        return;
      }
      const access = await getAccessState(userId, now);
      if (access.state !== 'READY') {
        res.status(409).json({
          error: {
            code: 'AI_ACCESS_UNAVAILABLE',
            message: 'Fix AI access before approving a retry.',
            details: {
              state: access.state,
              reason: access.reason,
              resumesAt: access.resumesAt ? access.resumesAt.toISOString() : null,
            },
          },
        });
        return;
      }
      // Compare-and-set on what the user saw: a concurrent approval or claim changes the row.
      approval = Math.max(...held.map(({ op }) => op.approvedRetries)) + 1;
      const approved = await prisma
        .$transaction(async (tx) => {
          for (const { op } of held) {
            const changed = await tx.aIOperation.updateMany({
              where: {
                id: op.id,
                status: op.status,
                attempts: op.attempts,
                approvedRetries: op.approvedRetries,
              },
              data: { status: 'RETRYABLE', retryAfter: null, approvedRetries: { increment: 1 } },
            });
            if (changed.count !== 1) throw new Error('AI_OPERATION_CHANGED');
          }
          return true;
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.message === 'AI_OPERATION_CHANGED') return false;
          throw err;
        });
      if (!approved) {
        res.status(409).json({
          error: {
            code: 'AI_OPERATION_CHANGED',
            message: 'This email changed. Refresh and try again.',
          },
        });
        return;
      }
      for (const { op } of held)
        console.log(
          JSON.stringify({
            event: 'ai_retry_approved',
            userId,
            emailId,
            operation: op.operation,
            version: op.version,
            previousStatus: op.status,
            previousProvider: op.provider,
            currentProvider: config?.provider ?? null,
          }),
        );
    }

    const jobId = await enqueueEmailProcessingJob(userId, emailId, approval);
    if (!jobId) {
      res.status(409).json({
        error: {
          code: 'RETRY_RECENTLY_QUEUED',
          message: 'A processing attempt was queued recently. Try again in a few minutes.',
        },
      });
      return;
    }

    res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
});

export const emailRouter = router;
