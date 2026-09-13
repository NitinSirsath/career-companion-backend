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
 * POST /api/emails/:id/resolve
 * Resolves an ambiguous match.
 */
router.post('/:id/resolve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.auth!.user.id;
    const emailId = req.params.id;
    const data = ResolveAmbiguityRequestSchema.parse(req.body);

    try {
      await MatcherService.resolveAmbiguousMatch(userId, emailId, data.applicationId);
      res.status(200).json({ success: true });
    } catch (e: any) {
      if (e.message === 'APPLICATION_NOT_FOUND') {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Application not found or access denied.' } });
      } else {
        throw e;
      }
    }
  } catch (err) {
    next(err);
  }
});

export const emailRouter = router;
