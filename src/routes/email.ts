import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { MatcherService } from '../services/matcher';
import { ResolveAmbiguityRequestSchema } from '../contracts/email';

const router = Router();

router.use(requireAuth);

/**
 * GET /api/emails/ambiguous
 * Returns a list of unresolved ambiguous emails.
 */
router.get('/ambiguous', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.auth!.user.id;
    const emails = await MatcherService.getAmbiguousMatches(userId);
    
    // Map to response schema to omit any PII/raw bodies if they existed, though Prisma already doesn't load bodies
    const response = emails.map(email => ({
      id: email.id,
      subject: email.subject,
      sender: email.sender,
      receivedAt: email.receivedAt ? email.receivedAt.toISOString() : null,
      aiProcessingResult: email.aiProcessingResult ? {
        companyName: email.aiProcessingResult.companyName,
        jobTitle: email.aiProcessingResult.jobTitle,
        confidence: email.aiProcessingResult.confidence,
        category: email.aiProcessingResult.category,
      } : null,
    }));

    res.status(200).json(response);
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
    const emails = await MatcherService.getUnmatchedEmails(userId);

    const response = emails.map(email => ({
      id: email.id,
      subject: email.subject,
      sender: email.sender,
      receivedAt: email.receivedAt ? email.receivedAt.toISOString() : null,
      aiProcessingResult: email.aiProcessingResult ? {
        companyName: email.aiProcessingResult.companyName,
        jobTitle: email.aiProcessingResult.jobTitle,
        confidence: email.aiProcessingResult.confidence,
        category: email.aiProcessingResult.category,
      } : null,
    }));

    res.status(200).json(response);
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
    const emailId = req.params.id as string;
    const data = ResolveAmbiguityRequestSchema.parse(req.body);

    try {
      await MatcherService.resolveEmailMatch(userId, emailId, data.applicationId);
      res.status(200).json({ success: true });
    } catch (e) {
      const err = e as Error;
      if (err.message === 'EMAIL_NOT_FOUND') {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Email not found.' } });
      } else if (err.message === 'INVALID_MATCH_STATE') {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Email is not in a resolvable state.' } });
      } else if (err.message === 'APPLICATION_REQUIRED_FOR_UNMATCHED') {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'An application must be selected for unmatched emails.' } });
      } else if (err.message === 'APPLICATION_NOT_FOUND') {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Application not found or access denied.' } });
      } else if (err.message === 'NO_AI_RESULT') {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Email has no AI processing result.' } });
      } else {
        throw e;
      }
    }
  } catch (err) {
    next(err);
  }
});

export const emailRouter = router;
