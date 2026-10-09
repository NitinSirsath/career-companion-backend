import { DomainError } from '../services/agenda';
import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logError } from '../utils/log';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
) {
  logError(
    'request_failed',
    {
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: statusFor(err),
      userId: req.auth?.user.id,
    },
    err,
  );

  if (err instanceof DomainError)
    return res.status(err.status).json({
      error: {
        code: err.code,
        message:
          err.code === 'NOT_FOUND'
            ? 'Not found'
            : 'This change could not be saved. Refresh and review the current state.',
      },
    });

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

/** The status the handler above sends for this error. */
function statusFor(err: unknown): number {
  if (err instanceof DomainError) return err.status;
  if (err instanceof ZodError) return 400;
  if (err instanceof Error && err.name === 'UnauthorizedError') return 401;
  return 500;
}
