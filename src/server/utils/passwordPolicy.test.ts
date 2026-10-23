import { describe, it, expect } from 'vitest';
import {
  passwordPolicyError,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  PASSWORD_POLICY_MESSAGE,
  PASSWORD_TOO_LONG_MESSAGE,
} from './passwordPolicy.js';

describe('passwordPolicyError', () => {
  it('requires a string of at least the minimum length', () => {
    expect(passwordPolicyError(undefined)).toBe(PASSWORD_POLICY_MESSAGE);
    expect(passwordPolicyError('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe(PASSWORD_POLICY_MESSAGE);
    expect(passwordPolicyError('a'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
  });

  it('caps absurd lengths before anything reaches bcrypt or Squawk (ai-therapist-154)', () => {
    expect(passwordPolicyError('a'.repeat(MAX_PASSWORD_LENGTH))).toBeNull();
    expect(passwordPolicyError('a'.repeat(MAX_PASSWORD_LENGTH + 1))).toBe(PASSWORD_TOO_LONG_MESSAGE);
  });
});
