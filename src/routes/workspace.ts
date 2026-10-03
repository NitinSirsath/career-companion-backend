import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { WorkspaceQuerySchema } from '../contracts';
import { getPaginationParams } from '../utils/pagination';
import { readWorkspaceActions, readWorkspaceReview } from '../services/workspace';

export const workspaceRouter = Router();
workspaceRouter.use(requireAuth);
workspaceRouter.get('/actions', async (req, res, next) => {
  try {
    const query = { ...WorkspaceQuerySchema.parse(req.query), ...getPaginationParams(req.query) };
    res.json(await readWorkspaceActions(req.auth!.user.id, query));
  } catch (error) {
    next(error);
  }
});
workspaceRouter.get('/review-summary', async (req, res, next) => {
  try {
    res.json(await readWorkspaceReview(req.auth!.user.id));
  } catch (error) {
    next(error);
  }
});
