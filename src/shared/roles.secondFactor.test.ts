// Who must sign in with an authenticator-app code (ai-therapist-393, 396).
import { describe, it, expect } from 'vitest';
import { USER_ROLES, requiresSecondFactor } from './roles';

describe('requiresSecondFactor', () => {
  it('is required for every role that can read participant data', () => {
    expect(USER_ROLES.filter((r) => requiresSecondFactor(r))).toEqual(['therapist', 'researcher', 'caseworker']);
  });

  it('is not required for participants, demo accounts, or no role', () => {
    for (const role of ['participant', 'demo', '', undefined, null, 'admin']) {
      expect(requiresSecondFactor(role)).toBe(false);
    }
  });
});
