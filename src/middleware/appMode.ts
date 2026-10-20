import { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors';
import { usesSandbox } from '../services/testAccounts';
import { devMode, testAccounts } from '../utils/config';

const notFound = () => new AppError(404, 'NOT_FOUND', 'Not found');

/** For routes that exist in dev mode only: in prod they answer 404 before anything else runs. */
export function devModeOnly(_req: Request, _res: Response, next: NextFunction) {
  next(devMode() ? undefined : notFound());
}

/** For routes that need a real Google account: dev mode has none, so they answer 404 there. */
export function prodModeOnly(_req: Request, _res: Response, next: NextFunction) {
  next(devMode() ? notFound() : undefined);
}

/**
 * The mail sandbox exists in dev mode, and outside it only while test accounts are set up. Where
 * it does not exist, every path answers 404 before authentication.
 */
export function sandboxAvailable(_req: Request, _res: Response, next: NextFunction) {
  next(devMode() || testAccounts().length ? undefined : notFound());
}

/** After authentication: only a user whose mailbox is the sandbox may use it; others get 404. */
export function sandboxUsersOnly(req: Request, _res: Response, next: NextFunction) {
  usesSandbox(req.auth!.user.id).then((allowed) => next(allowed ? undefined : notFound()), next);
}
