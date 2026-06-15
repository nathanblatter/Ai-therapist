import { createLogger } from '../utils/logger.js';

const log = createLogger('errorHandler');

export function errorHandler(err, req, res, _next) {
  log.error({ err, method: req.method, url: req.originalUrl }, 'Unhandled error');

  const status = err.status || 500;
  const body = {
    error: status === 500 ? 'Internal server error' : err.message
  };

  if (process.env.NODE_ENV !== 'production') {
    body.message = err.message;
    body.stack = err.stack;
  }

  res.status(status).json(body);
}
