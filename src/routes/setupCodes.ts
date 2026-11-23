/**
 * One-click setup of NorthList Apply (owner, 23 Nov 2026): the user's AI swaps a setup code for an
 * integration token. Not signed in: the code is the proof.
 *
 *   POST /api/setup-codes/redeem   a code from an "Open in Codex / Claude Code" link -> a new token
 *
 * Limited per network address (middleware/rateLimits.ts `setupCodeLimits`), on top of the usual limit.
 */
import { Router } from 'express';
import { RedeemSetupCodeRequestSchema } from '../contracts/integrationToken';
import { setupCodeLimits } from '../middleware/rateLimits';
import { redeemSetupCode } from '../services/setupCodes';

export const setupCodesRouter = Router();

setupCodesRouter.post('/redeem', ...setupCodeLimits, async (req, res, next) => {
  try {
    res.json(await redeemSetupCode(RedeemSetupCodeRequestSchema.parse(req.body)));
  } catch (error) {
    next(error);
  }
});
