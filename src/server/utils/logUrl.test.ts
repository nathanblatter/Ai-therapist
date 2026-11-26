import { describe, it, expect } from 'vitest';
import { loggableUrl } from './logUrl.js';

describe('loggableUrl', () => {
  it('drops the query of a sign-in callback', () => {
    expect(loggableUrl('/api/auth/cognito/callback?code=abc&state=xyz')).toBe('/api/auth/cognito/callback?[redacted]');
    expect(loggableUrl('/api/auth/squawk/callback?code=abc')).toBe('/api/auth/squawk/callback?[redacted]');
  });

  it('leaves every other URL alone', () => {
    expect(loggableUrl('/api/auth/cognito/callback')).toBe('/api/auth/cognito/callback');
    expect(loggableUrl('/api/sessions?limit=10')).toBe('/api/sessions?limit=10');
    expect(loggableUrl('/api/auth/cognito/callbackish?code=1')).toBe('/api/auth/cognito/callbackish?code=1');
    expect(loggableUrl('')).toBe('');
    expect(loggableUrl(undefined)).toBeUndefined();
  });
});
