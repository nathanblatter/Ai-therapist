import { describe, it, expect } from 'vitest';
import { afterLogout, planSignIn, COGNITO_START, SQUAWK_START } from './signInMode';

const base = { cognitoEnabled: false, squawkEnabled: false, loginChallenge: null, callbackError: null };

describe('planSignIn', () => {
  it('stays on the page with the local form when no provider is configured', () => {
    expect(planSignIn(base)).toEqual({ mode: 'legacy', redirect: null });
    expect(planSignIn({ ...base, callbackError: 'server_error' })).toEqual({ mode: 'legacy', redirect: null });
  });

  it('hands the browser to the Cognito hosted page', () => {
    expect(planSignIn({ ...base, cognitoEnabled: true })).toEqual({ mode: 'cognito', redirect: COGNITO_START });
  });

  it('does not redirect past a Cognito callback error (no loop)', () => {
    expect(planSignIn({ ...base, cognitoEnabled: true, callbackError: 'no_role' })).toEqual({
      mode: 'cognito',
      redirect: null,
    });
  });

  it('prefers Cognito when both providers are configured', () => {
    expect(planSignIn({ ...base, cognitoEnabled: true, squawkEnabled: true, loginChallenge: 'lc1' }).mode).toBe(
      'cognito',
    );
  });

  it('keeps the Squawk behaviour: start once, then stay for the ceremony or an error', () => {
    expect(planSignIn({ ...base, squawkEnabled: true })).toEqual({ mode: 'squawk', redirect: SQUAWK_START });
    expect(planSignIn({ ...base, squawkEnabled: true, loginChallenge: 'lc1' })).toEqual({
      mode: 'squawk',
      redirect: null,
    });
    expect(planSignIn({ ...base, squawkEnabled: true, callbackError: 'state_mismatch' })).toEqual({
      mode: 'squawk',
      redirect: null,
    });
  });
});

describe('afterLogout', () => {
  it('follows a provider sign-out URL or a same-origin path from the server', () => {
    expect(afterLogout({ success: true, redirect: 'https://study.auth.us-west-1.amazoncognito.com/logout?x=1' })).toBe(
      'https://study.auth.us-west-1.amazoncognito.com/logout?x=1',
    );
    expect(afterLogout({ redirect: '/login?signed_out=1' })).toBe('/login?signed_out=1');
  });

  it('falls back to the login page for anything else', () => {
    expect(afterLogout({ success: true })).toBe('/login');
    expect(afterLogout(null)).toBe('/login');
    expect(afterLogout({ redirect: 'javascript:alert(1)' })).toBe('/login');
    expect(afterLogout({ redirect: 'http://insecure.example/logout' })).toBe('/login');
    expect(afterLogout({ redirect: '//evil.example' })).toBe('/login');
    expect(afterLogout({ redirect: 42 })).toBe('/login');
  });
});
