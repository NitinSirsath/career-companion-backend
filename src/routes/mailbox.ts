/**
 * The session user's Gmail, read live (the Mails page).
 *
 *   GET /api/mailbox/threads                                       one page of the inbox
 *   GET /api/mailbox/threads/:threadId                             one thread with its text
 *   GET /api/mailbox/messages/:messageId/attachments/:partId       one attached file
 *   POST /api/mailbox/threads/:threadId/replies                    send a reply into the thread
 *
 * Nothing here is stored, cached or logged: email text goes only to the signed-in user, and the
 * text of a reply goes only to Gmail.
 */
import { NextFunction, Request, Response, Router } from 'express';
import {
  MailboxQuerySchema,
  MailIdSchema,
  MailPartIdSchema,
  SendMailReplyRequestSchema,
} from '../contracts/mailbox';
import { requireAuth } from '../middleware/auth';
import { listMailboxThreads, readMailAttachment, readMailThread } from '../services/mailbox';
import { sendMailReply } from '../services/mailReply';

const router = Router();
router.use(requireAuth);
router.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

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
  '/threads',
  handle((req) =>
    listMailboxThreads(req.auth!.user.id, MailboxQuerySchema.parse(req.query).pageToken),
  ),
);

router.get(
  '/threads/:threadId',
  handle((req) => readMailThread(req.auth!.user.id, MailIdSchema.parse(req.params.threadId))),
);

router.post(
  '/threads/:threadId/replies',
  handle((req) =>
    sendMailReply(
      req.auth!.user.id,
      MailIdSchema.parse(req.params.threadId),
      SendMailReplyRequestSchema.parse(req.body),
    ),
  ),
);

router.get(
  '/messages/:messageId/attachments/:partId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const file = await readMailAttachment(
        req.auth!.user.id,
        MailIdSchema.parse(req.params.messageId),
        MailPartIdSchema.parse(req.params.partId),
      );
      // Always a download, never shown by the browser: the file comes from an email sender.
      res.attachment(file.filename);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(200).send(file.data);
    } catch (err) {
      next(err);
    }
  },
);

export const mailboxRouter = router;
