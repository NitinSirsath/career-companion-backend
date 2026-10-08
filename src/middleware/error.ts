import { DomainError } from '../services/agenda';
import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logError } from '../utils/log';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  let status = 500;
  if (err instanceof DomainError) status = err.status;
  else if (err instanceof ZodError) status = 400;
  else if (err instanceof Error && err.name === 'UnauthorizedError') status = 401;

  logError(
    'request_failed',
    {
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status,
      userId: req.auth?.user.id,
    },
    err,
  );

  if (err instanceof DomainError) return res.status(err.status).json({ error: { code: err.code, message: err.code === 'NOT_FOUND' ? 'Not found' : 'This change could not be saved. Refresh and review the current state.' } });

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        details: (err as any).issues || (err as any).errors,
      },
    });
  }

  const error = err as Error;
  if (error.name === 'UnauthorizedError') {
    return res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: error.message || 'Authentication required',
      },
    });
  }

  return res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    },
  });
}
