import { AppError } from '../errors';
import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logError, logWarn } from '../utils/log';

/** The body parser's own refusals: the request's fault, not the server's. */
const BODY_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  'entity.too.large': {
    status: 413,
    code: 'PAYLOAD_TOO_LARGE',
    message: 'This request is too large.',
  },
  'entity.parse.failed': {
    status: 400,
    code: 'INVALID_JSON',
    message: 'This request is not valid JSON.',
  },
};

function bodyError(err: unknown) {
  const type = (err as { type?: unknown } | null)?.type;
  return typeof type === 'string' && Object.hasOwn(BODY_ERRORS, type) ? BODY_ERRORS[type] : null;
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
) {
  const fields = {
    method: req.method,
    path: req.originalUrl.split('?')[0],
    status: statusFor(err),
    userId: req.auth?.user.id,
  };

  if (err instanceof AppError) {
    // An expected outcome, not a fault: one short line, without a stack.
    logWarn('request_failed', { ...fields, code: err.code });
    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
  }

  const body = bodyError(err);
  if (body) {
    logWarn('request_failed', { ...fields, code: body.code });
    return res.status(body.status).json({ error: { code: body.code, message: body.message } });
  }

  logError('request_failed', fields, err);

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
  if (err instanceof AppError) return err.status;
  const body = bodyError(err);
  if (body) return body.status;
  if (err instanceof ZodError) return 400;
  if (err instanceof Error && err.name === 'UnauthorizedError') return 401;
  return 500;
}
