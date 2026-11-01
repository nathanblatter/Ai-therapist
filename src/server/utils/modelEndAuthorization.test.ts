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

  it('a grant authorizes the session until cleared', () => {
    authorizeModelEnd('s-1');
    expect(isModelEndAuthorized('s-1')).toBe(true);
    clearModelEndAuthorization('s-1');
    expect(isModelEndAuthorized('s-1')).toBe(false);
  });

  it('a grant expires after ten minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T10:00:00Z'));
    authorizeModelEnd('s-2');
    vi.setSystemTime(new Date('2026-11-01T10:09:00Z'));
    expect(isModelEndAuthorized('s-2')).toBe(true);
    vi.setSystemTime(new Date('2026-11-01T10:11:00Z'));
    expect(isModelEndAuthorized('s-2')).toBe(false);
    // Expired entries are dropped on read, not retained.
    authorizeModelEnd('s-3');
    clearModelEndAuthorization('s-3');
    expect(_modelEndGrantCountForTests()).toBe(0);
  });
});
