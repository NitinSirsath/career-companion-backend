/**
 * Companies whose new mail the app does not read (the Restricted list on the Mails page).
 *
 *   GET    /api/blocked-senders       every blocked company domain, newest first
 *   DELETE /api/blocked-senders/:id   unblock: new mail comes in again
 *
 * A block is made from a conversation (`routes/conversation.ts`).
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { listBlockedSenders, unblockSender } from '../services/blockedSenders';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    res.json(await listBlockedSenders(req.auth!.user.id));
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    res.json(await unblockSender(req.auth!.user.id, z.uuid().parse(req.params.id)));
  } catch (error) {
    next(error);
  }
});

export const blockedSenderRouter = router;
