// Logger using console since pino is not installed.
// Provides the same child-logger API shape used throughout the codebase.

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogMeta {
  [key: string]: unknown;
}

interface Logger {
  debug(meta: LogMeta | string, msg?: string): void;
  info(meta: LogMeta | string, msg?: string): void;
  warn(meta: LogMeta | string, msg?: string): void;
  error(meta: LogMeta | string, msg?: string): void;
  child(bindings: LogMeta): Logger;
}

function makeLogger(bindings: LogMeta): Logger {
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
    child(childBindings) { return makeLogger({ ...bindings, ...childBindings }); },
  };
}

const logger: Logger = makeLogger({});

export function createLogger(module: string): Logger {
  return logger.child({ module });
}

export default logger;
