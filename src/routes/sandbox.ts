/**
 * Mail sandbox API (dev mode only; see the app mode section of utils/config.ts).
 *
 *   GET  /api/sandbox/threads                     conversations in Inbox or Sent
 *   GET  /api/sandbox/threads/:threadId           one conversation, both sides, with its text
 *   POST /api/sandbox/messages                    send a new mail to the user
 *   POST /api/sandbox/threads/:threadId/replies   reply as the user or as the other person
 *   GET  /api/sandbox/senders                     sender addresses used before
 *   POST /api/sandbox/reset                       empty the mailbox and what the app made from it
 *
 * In prod mode every path answers 404 before authentication. Mail text is never logged.
 */
import { NextFunction, Request, Response, Router } from 'express';
import {
  ListSandboxThreadsQuerySchema,
  ReplySandboxMailRequestSchema,
  ResetSandboxRequestSchema,
  SandboxIdSchema,
  SendSandboxMailRequestSchema,
} from '../contracts/sandbox';
import { devModeOnly } from '../middleware/appMode';
import { requireAuth } from '../middleware/auth';
import {
  listSandboxSenders,
  listSandboxThreads,
  readSandboxThread,
  replyInSandbox,
  resetSandbox,
  sendSandboxMail,
} from '../services/sandbox/mailbox';

const router = Router();
router.use(devModeOnly);
router.use(requireAuth);

function handle(status: number, action: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json(await action(req));
    } catch (err) {
      next(err);
    }
  };
}

router.get(
  '/threads',
  handle(200, (req) => {
    const { folder, pageToken } = ListSandboxThreadsQuerySchema.parse(req.query);
    return listSandboxThreads(req.auth!.user.id, folder, pageToken);
  }),
);

router.get(
  '/threads/:threadId',
  handle(200, (req) =>
    readSandboxThread(req.auth!.user.id, SandboxIdSchema.parse(req.params.threadId)),
  ),
);

router.post(
  '/messages',
  handle(201, (req) =>
    sendSandboxMail(req.auth!.user.id, SendSandboxMailRequestSchema.parse(req.body)),
  ),
);

router.post(
  '/threads/:threadId/replies',
  handle(201, (req) =>
    replyInSandbox(
      req.auth!.user.id,
      SandboxIdSchema.parse(req.params.threadId),
      ReplySandboxMailRequestSchema.parse(req.body),
    ),
  ),
);

router.get(
  '/senders',
  handle(200, (req) => listSandboxSenders(req.auth!.user.id)),
);

router.post(
  '/reset',
  handle(200, (req) => {
    ResetSandboxRequestSchema.parse(req.body);
    return resetSandbox(req.auth!.user.id);
  }),
);

export const sandboxRouter = router;
