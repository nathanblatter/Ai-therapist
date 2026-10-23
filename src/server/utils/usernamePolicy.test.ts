import { describe, it, expect } from 'vitest';
import { usernamePolicyError, USERNAME_HTML_PATTERN, USERNAME_PATTERN } from './usernamePolicy.js';

describe('usernamePolicyError (ai-therapist-154)', () => {
  it('accepts 3-64 chars of letters, digits and . _ - @ +, trimming surrounding whitespace', () => {
    for (const ok of ['abc', 'jane.doe', 'jane_doe-2', 'jane+tag@example.org', '  padded  ', 'x'.repeat(64)]) {
      expect(usernamePolicyError(ok), ok).toBeNull();
    }
  });

  it('rejects non-strings, short, long and off-charset usernames with a user-facing message', () => {
    expect(usernamePolicyError(undefined)).toBe('Username is required');
    expect(usernamePolicyError(42)).toBe('Username is required');
    expect(usernamePolicyError('ab')).toMatch(/at least 3/);
    expect(usernamePolicyError('x'.repeat(65))).toMatch(/at most 64/);
    for (const bad of ['two words', 'tab\tname', 'semi;colon', '<script>', 'na\u00efve', 'slash/name']) {
      expect(usernamePolicyError(bad), bad).toMatch(/may only contain/);
    }
  });

  it('keeps the HTML pattern attribute in sync with the server regex', () => {
    expect(new RegExp(`^${USERNAME_HTML_PATTERN}$`).source).toBe(USERNAME_PATTERN.source);
  });
});
