import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '../utils/logger.js';

const log = createLogger('errorHandler');

interface HttpError extends Error {
  status?: number;
}

export function errorHandler(err: HttpError, req: Request, res: Response, _next: NextFunction): void {
  log.error({ err, method: req.method, url: req.originalUrl }, 'Unhandled error');

  const status = err.status || 500;
  const body: Record<string, string> = {
    error: status === 500 ? 'Internal server error' : err.message
  };

  if (process.env.NODE_ENV !== 'production') {
    body.message = err.message;
    body.stack = err.stack ?? '';
  }

  res.status(status).json(body);
}
