// ai-therapist-373: the participant deep link a crisis page carries when its
// session was never stored.
import { describe, it, expect, vi } from 'vitest';
import { openParticipantDeepLink, participantFromHash, participantProfileSummary } from './deepLink';

describe('participantFromHash', () => {
  it.each([
    ['#participant=7', 7],
    ['#foo=1&participant=2147483647', 2147483647],
    ['#participant=12&other=x', 12],
  ])('%s -> %s', (hash, id) => {
    expect(participantFromHash(hash)).toBe(id);
  });

  it.each([
    '',
    '#session=chat_1',
    '#participant=',
    '#participant=abc',
    '#participant=0',
    '#participant=7x',
    '#xparticipant=7',
  ])('%s -> null', (hash) => {
    expect(participantFromHash(hash)).toBeNull();
  });
});

// ai-therapist-374: what AdminApp does with the link on load. The admin client
// has no component test setup, so the decision is a pure function and
// AdminApp passes it openParticipantProfile and history.replaceState. The
// profile's data comes from GET /admin/api/users/:id/profile and its siblings,
// gated server-side (therapist role and caseload; 401 anonymous, 404 unknown
// id, 400 garbage: routes/admin/participantProfile.routes.test.ts, and
// integration/api.test.ts for the anonymous case through the whole app).
describe('openParticipantDeepLink', () => {
  const run = (hash: string, pathname = '/admin', search = '') => {
    const open = vi.fn();
    const replaceUrl = vi.fn();
    const opened = openParticipantDeepLink({ hash, pathname, search }, open, replaceUrl);
    return { opened, open, replaceUrl };
  };

  it("opens the participant's profile by id, once, and drops the hash but keeps the path and query", () => {
    const { opened, open, replaceUrl } = run('#participant=42', '/admin', '?tab=x');
    expect(opened).toBe(42);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(42);
    expect(replaceUrl).toHaveBeenCalledWith('/admin?tab=x');
  });

  it.each([
    '#participant=abc',
    '#participant=',
    '#participant=0',
    '#participant=-3',
    '#participant=7x',
    '#participant=1e3',
    '#participant=99999999999999999999',
    '#participant=%3Cscript%3E',
    '#participant=<img src=x onerror=alert(1)>',
    '#session=chat_1',
    '',
  ])('%s opens nothing and leaves the URL alone', (hash) => {
    const { opened, open, replaceUrl } = run(hash);
    expect(opened).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(replaceUrl).not.toHaveBeenCalled();
  });
});

describe('participantProfileSummary', () => {
  it('an id the viewer cannot name (unknown, or not on their caseload) shows only the id', () => {
    expect(participantProfileSummary(999999, new Map())).toEqual({
      userid: 999999,
      username: 'client #999999',
      role: 'participant',
    });
  });

  it("uses the caseload's username when it has one", () => {
    expect(participantProfileSummary(7, new Map([[7, 'p-007']]))).toEqual({
      userid: 7,
      username: 'p-007',
      role: 'participant',
    });
  });
});
