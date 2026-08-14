// Structured logging via pino. This module preserves the exact API surface the
// codebase has always used (default logger + createLogger(module) + the
// child-logger shape), so call sites are agnostic to the backend. If pino ever
// fails to construct (broken install, exotic runtime), we fall back to the old
// console shim rather than crashing the process at import time.

import { pino } from 'pino';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogMeta {
  [key: string]: unknown;
}

export interface Logger {
  debug(meta: LogMeta | string, msg?: string): void;
  info(meta: LogMeta | string, msg?: string): void;
  warn(meta: LogMeta | string, msg?: string): void;
  error(meta: LogMeta | string, msg?: string): void;
  child(bindings: LogMeta): Logger;
}

// ---- console fallback (previous implementation, kept as a safety net) ----

function makeConsoleLogger(bindings: LogMeta): Logger {
  const level: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
  const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  const currentLevelIdx = levels.indexOf(level);

  function shouldLog(l: LogLevel): boolean {
    return levels.indexOf(l) >= currentLevelIdx;
  }

  function format(meta: LogMeta | string, msg?: string): string {
    const bindingStr = Object.keys(bindings).length
      ? JSON.stringify(bindings) + ' '
      : '';
    if (typeof meta === 'string') {
      return bindingStr + meta;
    }
    const metaStr = Object.keys(meta).length ? JSON.stringify(meta) + ' ' : '';
    return bindingStr + metaStr + (msg ?? '');
  }

  return {
    debug(meta, msg?) { if (shouldLog('debug')) console.debug('[DEBUG]', format(meta, msg)); },
    info(meta, msg?)  { if (shouldLog('info'))  console.info('[INFO]',  format(meta, msg)); },
    warn(meta, msg?)  { if (shouldLog('warn'))  console.warn('[WARN]',  format(meta, msg)); },
    error(meta, msg?) { if (shouldLog('error')) console.error('[ERROR]', format(meta, msg)); },
    child(childBindings) { return makeConsoleLogger({ ...bindings, ...childBindings }); },
  };
}

// ---- pino backend ----

// Under vitest, intentional-failure tests would otherwise spam the runner's
// output with pino error lines; default to silent there. An explicit
// LOG_LEVEL still wins everywhere (so a test run can be made verbose).
function defaultLevel(): string {
  if (process.env.LOG_LEVEL) return process.env.LOG_LEVEL;
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return 'silent';
  return 'info';
}

function makePinoLogger(): Logger {
  const root = pino({
    level: defaultLevel(),
    // Session transcripts never pass through the logger, but headers can:
    // scrub credentials defensively at the logger level too.
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'res.headers["set-cookie"]',
        'password',
        'token',
      ],
      censor: '[redacted]',
    },
  });

  // Minimal structural view of a pino logger; keeps wrap() agnostic to pino's
  // generics (child() narrows them in ways that break direct assignment).
  interface PinoLike {
    debug(obj: unknown, msg?: string): void;
    info(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
    error(obj: unknown, msg?: string): void;
    child(bindings: Record<string, unknown>): PinoLike;
  }

  function wrap(p: PinoLike): Logger {
    return {
      debug(meta, msg?) { if (typeof meta === 'string') p.debug(meta); else p.debug(meta, msg); },
      info(meta, msg?)  { if (typeof meta === 'string') p.info(meta);  else p.info(meta, msg); },
      warn(meta, msg?)  { if (typeof meta === 'string') p.warn(meta);  else p.warn(meta, msg); },
      error(meta, msg?) { if (typeof meta === 'string') p.error(meta); else p.error(meta, msg); },
      child(bindings) { return wrap(p.child(bindings)); },
    };
  }

  return wrap(root);
}

function buildLogger(): Logger {
  try {
    return makePinoLogger();
  } catch (err) {
    console.error('[logger] pino init failed, falling back to console:', err);
    return makeConsoleLogger({});
  }
}

const logger: Logger = buildLogger();

export function createLogger(module: string): Logger {
  return logger.child({ module });
}

export default logger;
