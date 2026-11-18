/**
 * Messages from the Admin page, for the signed-in user (owner, 18 Nov 2026).
 *
 *   GET  /api/messages               the messages still shown, newest first
 *   POST /api/messages/:id/dismiss   close one on every device
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { dismissMessage, listMyMessages } from '../services/ownerMessages';

const MessageIdSchema = z.uuid();

export const messagesRouter = Router();
messagesRouter.use(requireAuth);

messagesRouter.get('/', async (req, res, next) => {
  try {
    res.json(await listMyMessages(req.auth!.user.id));
  } catch (error) {
    next(error);
  }
});

messagesRouter.post('/:id/dismiss', async (req, res, next) => {
  try {
    await dismissMessage(req.auth!.user.id, MessageIdSchema.parse(req.params.id));
    res.json({ dismissed: true });
  } catch (error) {
    next(error);
  }
});
