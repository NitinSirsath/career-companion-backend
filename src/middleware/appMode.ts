import { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors';
import { devMode } from '../utils/config';

const notFound = () => new AppError(404, 'NOT_FOUND', 'Not found');

/** For routes that exist in dev mode only: in prod they answer 404 before anything else runs. */
export function devModeOnly(_req: Request, _res: Response, next: NextFunction) {
  next(devMode() ? undefined : notFound());
}

/** For routes that need a real Google account: dev mode has none, so they answer 404 there. */
export function prodModeOnly(_req: Request, _res: Response, next: NextFunction) {
  next(devMode() ? notFound() : undefined);
}
