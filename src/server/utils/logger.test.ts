// API-surface preservation for the pino-backed logger (pass-3 telemetry):
// the module must keep exposing exactly the shape the codebase relies on
// (default logger + createLogger(module) + chainable child loggers), and
// every method must accept both (meta, msg) and plain-string calls.
import { describe, it, expect } from 'vitest';
import logger, { createLogger } from './logger.js';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

describe('logger API surface', () => {
  it('exposes debug/info/warn/error/child on the default logger', () => {
    for (const level of LEVELS) {
      expect(typeof logger[level]).toBe('function');
    }
    expect(typeof logger.child).toBe('function');
  });

  it('createLogger returns a child logger with the same shape', () => {
    const child = createLogger('test-module');
    for (const level of LEVELS) {
      expect(typeof child[level]).toBe('function');
    }
    expect(typeof child.child).toBe('function');
  });

  it('accepts (meta, msg) and plain-string calls without throwing', () => {
    const child = createLogger('test-module');
    for (const level of LEVELS) {
      expect(() => child[level]({ key: 'value' }, 'with meta')).not.toThrow();
      expect(() => child[level]('plain string message')).not.toThrow();
      expect(() => child[level]({})).not.toThrow();
    }
  });

  it('supports nested child loggers', () => {
    const nested = logger.child({ a: 1 }).child({ b: 2 });
    expect(() => nested.info({ c: 3 }, 'nested')).not.toThrow();
  });
});
