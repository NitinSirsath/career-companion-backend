/**
 * Get an invite for the release (owner, 22 Nov 2026). Signed out: the sign-in page shows the form
 * while the beta is full.
 *
 *   POST /api/invites   save an email and where the person heard about NorthList
 *
 * Limited per network address (middleware/rateLimits.ts `inviteLimits`), on top of the usual limit.
 */
import { Router } from 'express';
import { InviteRequestSchema, type InviteResponse } from '../contracts/invites';
import { inviteLimits } from '../middleware/rateLimits';
import { saveReleaseInvite } from '../services/releaseInvites';

export const invitesRouter = Router();

invitesRouter.post('/', ...inviteLimits, async (req, res, next) => {
  try {
    await saveReleaseInvite(InviteRequestSchema.parse(req.body));
    const answer: InviteResponse = { saved: true };
    res.json(answer);
  } catch (error) {
    next(error);
  }
});
