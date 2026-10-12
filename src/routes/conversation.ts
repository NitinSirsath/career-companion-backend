/**
 * Job-mail conversations for the session user (the Mails page).
 *
 *   GET   /api/conversations                   one page, filtered and sorted
 *   GET   /api/conversations/:key              one conversation with what the AI read per email
 *   POST  /api/conversations/:key/seen         ends the "new" mark
 *   PATCH /api/conversations/:key/request      the user's answer to the newest request
 *   POST  /api/conversations/:key/application  create or choose the conversation's application
 *
 * No email text is read or returned here; `routes/mailbox.ts` reads it live from Gmail.
 */
import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import {
  ConversationFiltersSchema,
  LinkConversationSchema,
  SetRequestStateSchema,
} from '../contracts/conversation';
import { requireAuth } from '../middleware/auth';
import {
  getConversation,
  listConversations,
  markConversationSeen,
  setRequestState,
} from '../services/conversation';
import { linkConversation } from '../services/conversationApplication';
import { createPaginatedResponse, getPaginationParams } from '../utils/pagination';

const router = Router();
router.use(requireAuth);

const Key = z.string().min(1).max(200);
const EmptyBody = z.strictObject({});

function handle(action: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json(await action(req));
    } catch (err) {
      next(err);
    }
  };
}

router.get(
  '/',
  handle(async (req) => {
    const { limit, offset } = getPaginationParams(req.query);
    const filters = ConversationFiltersSchema.parse(req.query);
    const items = await listConversations(req.auth!.user.id, filters, limit, offset);
    return createPaginatedResponse(items, limit, offset);
  }),
);

router.get(
  '/:key',
  handle((req) => getConversation(req.auth!.user.id, Key.parse(req.params.key))),
);

router.post(
  '/:key/seen',
  handle((req) => {
    EmptyBody.parse(req.body ?? {});
    return markConversationSeen(req.auth!.user.id, Key.parse(req.params.key));
  }),
);

router.patch(
  '/:key/request',
  handle((req) =>
    setRequestState(
      req.auth!.user.id,
      Key.parse(req.params.key),
      SetRequestStateSchema.parse(req.body),
    ),
  ),
);

router.post(
  '/:key/application',
  handle((req) =>
    linkConversation(
      req.auth!.user.id,
      Key.parse(req.params.key),
      LinkConversationSchema.parse(req.body ?? {}),
    ),
  ),
);

export const conversationRouter = router;
