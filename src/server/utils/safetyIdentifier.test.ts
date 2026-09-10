// A blocked safety identifier is permanent on OpenAI's side and locks one
// participant out of the study, so the detector must fire on the real error
// shapes — and must NOT fire on ordinary failures, which would wrongly tell
// a participant their access is gone.
import { describe, it, expect } from 'vitest';
import { isIdentifierBlockedError } from './safetyIdentifier.js';

describe('isIdentifierBlockedError', () => {
  it('detects the blocked-identifier error from a response body', () => {
    expect(isIdentifierBlockedError(null, JSON.stringify({
      error: { code: 'identifier_blocked', message: 'The safety identifier is blocked.' },
    }))).toBe(true);
  });

  it('detects it from a thrown Error message', () => {
    expect(isIdentifierBlockedError(new Error('403 safety_identifier has been blocked'))).toBe(true);
    expect(isIdentifierBlockedError(new Error('Your safety identifier is blocked from model access'))).toBe(true);
  });

  it('does NOT fire on ordinary failures', () => {
    expect(isIdentifierBlockedError(new Error('Rate limit reached'))).toBe(false);
    expect(isIdentifierBlockedError(new Error('ECONNRESET'))).toBe(false);
    expect(isIdentifierBlockedError(new Error('Invalid API key provided'))).toBe(false);
    expect(isIdentifierBlockedError(null, '{"error":{"message":"model not found"}}')).toBe(false);
    expect(isIdentifierBlockedError(null, '')).toBe(false);
    expect(isIdentifierBlockedError(null, undefined)).toBe(false);
  });

  it('does not fire on a safety_identifier mention without a block', () => {
    expect(isIdentifierBlockedError(null, 'safety_identifier must be a string')).toBe(false);
  });
});
