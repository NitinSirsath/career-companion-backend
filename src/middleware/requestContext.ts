import { randomUUID } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { logDebug, logWarn, runWithRequestId } from '../utils/log';

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  const startedAt = Date.now();
  res.setHeader('X-Request-Id', requestId);

  res.on('finish', () => {
    if (req.originalUrl.startsWith('/mcp')) return;
    const status = res.statusCode;
    const fields = {
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status,
      durationMs: Date.now() - startedAt,
      userId: req.auth?.user.id,
    };
    runWithRequestId(requestId, () => {
      if (status < 400 || status === 401) logDebug('request_completed', fields);
      else if (status < 500) logWarn('request_completed', fields);
    });
  });

  runWithRequestId(requestId, next);
}
