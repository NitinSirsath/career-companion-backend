import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { DashboardQuerySchema } from '../contracts';
import { readDashboard } from '../services/dashboard';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);
dashboardRouter.get('/', async (req, res, next) => {
  try {
    res.json(await readDashboard(req.auth!.user.id, DashboardQuerySchema.parse(req.query)));
  } catch (error) {
    next(error);
  }
});
