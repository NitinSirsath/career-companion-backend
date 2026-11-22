/**
 * Admin page routes (owner, 18 Nov 2026). Only for the emails in ADMIN_EMAILS: anyone else, signed
 * in or not, gets 404 (middleware/auth.ts `requireAdmin`).
 *
 *   GET  /api/admin                          accounts, problems and AI use
 *   GET  /api/admin/free-ai-money            what the free AI key spent and has left (OpenRouter)
 *   POST /api/admin/accounts/:id/suspend     suspend, or change the reason
 *   POST /api/admin/accounts/:id/resume      end the suspension
 *   GET  /api/admin/messages                 the last messages sent, and devices with alerts on
 *   POST /api/admin/messages                 send a message to everyone or one account
 *   POST /api/admin/messages/:id/remove      stop showing a message
 *   GET  /api/admin/invites                  requests for an invite to the release, newest first
 */
import { Router } from 'express';
import { z } from 'zod';
import { AdminSuspendRequestSchema } from '../contracts/admin';
import { SendOwnerMessageRequestSchema } from '../contracts/messages';
import { requireAdmin } from '../middleware/auth';
import { readAdminAccount, readAdminOverview, readFreeAIMoney } from '../services/admin';
import { adminListMessages, removeOwnerMessage, sendOwnerMessage } from '../services/ownerMessages';
import { listReleaseInvites } from '../services/releaseInvites';
import { resumeAccount, suspendAccount } from '../services/suspension';

const IdSchema = z.uuid();

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
    const userId = IdSchema.parse(req.params.id);
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
    const userId = IdSchema.parse(req.params.id);
    await resumeAccount(userId);
    res.json({ account: await readAdminAccount(adminUserId, userId) });
  } catch (error) {
    next(error);
  }
});

adminRouter.get('/invites', async (_req, res, next) => {
  try {
    res.json({ invites: await listReleaseInvites() });
  } catch (error) {
    next(error);
  }
});

adminRouter.get('/messages', async (_req, res, next) => {
  try {
    res.json(await adminListMessages());
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/messages', async (req, res, next) => {
  try {
    const message = await sendOwnerMessage(SendOwnerMessageRequestSchema.parse(req.body));
    res.status(201).json({ message });
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/messages/:id/remove', async (req, res, next) => {
  try {
    res.json({ message: await removeOwnerMessage(IdSchema.parse(req.params.id)) });
  } catch (error) {
    next(error);
  }
});
