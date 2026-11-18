/**
 * Admin page routes (owner, 18 Nov 2026). Only for the emails in ADMIN_EMAILS: anyone else, signed
 * in or not, gets 404 (middleware/auth.ts `requireAdmin`).
 *
 *   GET  /api/admin                          accounts, problems and AI use
 *   GET  /api/admin/free-ai-money            what the free AI key spent and has left (OpenRouter)
 *   POST /api/admin/accounts/:id/suspend     suspend, or change the reason
 *   POST /api/admin/accounts/:id/resume      end the suspension
 */
import { Router } from 'express';
import { z } from 'zod';
import { AdminSuspendRequestSchema } from '../contracts/admin';
import { requireAdmin } from '../middleware/auth';
import { readAdminAccount, readAdminOverview, readFreeAIMoney } from '../services/admin';
import { resumeAccount, suspendAccount } from '../services/suspension';

const AccountIdSchema = z.uuid();

export const adminRouter = Router();
adminRouter.use(requireAdmin);

adminRouter.get('/', async (req, res, next) => {
  try {
    res.json(await readAdminOverview(req.auth!.user.id));
  } catch (error) {
    next(error);
  }
});

adminRouter.get('/free-ai-money', async (_req, res, next) => {
  try {
    res.json(await readFreeAIMoney());
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/accounts/:id/suspend', async (req, res, next) => {
  try {
    const adminUserId = req.auth!.user.id;
    const userId = AccountIdSchema.parse(req.params.id);
    const { reason } = AdminSuspendRequestSchema.parse(req.body);
    await suspendAccount(adminUserId, userId, reason);
    res.json({ account: await readAdminAccount(adminUserId, userId) });
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/accounts/:id/resume', async (req, res, next) => {
  try {
    const adminUserId = req.auth!.user.id;
    const userId = AccountIdSchema.parse(req.params.id);
    await resumeAccount(userId);
    res.json({ account: await readAdminAccount(adminUserId, userId) });
  } catch (error) {
    next(error);
  }
});
