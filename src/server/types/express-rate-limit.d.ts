// Minimal type stub for express-rate-limit (package not installed).
// Provides enough typing to satisfy strict-mode TypeScript without touching
// src/server/index.ts or package.json.
declare module 'express-rate-limit' {
  import type { RequestHandler } from 'express';

  interface Options {
    windowMs?: number;
    max?: number;
    standardHeaders?: boolean;
    legacyHeaders?: boolean;
    message?: unknown;
    [key: string]: unknown;
  }

  function rateLimit(options?: Options): RequestHandler;
  export default rateLimit;
}
