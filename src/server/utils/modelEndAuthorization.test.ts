import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  authorizeModelEnd,
  isModelEndAuthorized,
  clearModelEndAuthorization,
  _modelEndGrantCountForTests,
} from './modelEndAuthorization.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('modelEndAuthorization', () => {
  it('is unauthorized by default', () => {
    expect(isModelEndAuthorized('s-none')).toBe(false);
  });

  it('a grant authorizes exactly one end', () => {
    authorizeModelEnd('s-1');
    expect(isModelEndAuthorized('s-1')).toBe(true);
    expect(isModelEndAuthorized('s-1')).toBe(false);
  });

  it('a grant can be cleared before it is used', () => {
    authorizeModelEnd('s-1b');
    clearModelEndAuthorization('s-1b');
    expect(isModelEndAuthorized('s-1b')).toBe(false);
  });

  it('a grant expires after ten minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T10:00:00Z'));
    authorizeModelEnd('s-2');
    vi.setSystemTime(new Date('2026-11-01T10:11:00Z'));
    expect(isModelEndAuthorized('s-2')).toBe(false);
    // Expired entries are dropped on read, not retained.
    expect(_modelEndGrantCountForTests()).toBe(0);
    authorizeModelEnd('s-3');
    vi.setSystemTime(new Date('2026-11-01T10:20:00Z'));
    expect(isModelEndAuthorized('s-3')).toBe(true);
  });
});
