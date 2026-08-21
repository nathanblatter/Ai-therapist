// Routing matrix for caseload-aware admin event fan-out (HIGH-1,
// docs/caseload-rbac.md): researchers ('admin-broadcast') always receive;
// therapist rooms only when the event is attributed to a participant on their
// caseload; unattributable events and lookup failures fail closed.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTherapistIdsForClient: vi.fn(),
  getSessionAccessInfo: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  getTherapistIdsForClient: mocks.getTherapistIdsForClient,
  getSessionAccessInfo: mocks.getSessionAccessInfo,
}));

import {
  broadcastAdminEvent,
  broadcastAdminEventForSession,
  clearSessionUserCache,
  type AdminBroadcastIo,
} from './adminBroadcast.js';

function makeIo() {
  const emit = vi.fn();
  const to = vi.fn((_room: string) => ({ emit }));
  return { io: { to } as unknown as AdminBroadcastIo, to, emit };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSessionUserCache();
});

describe('broadcastAdminEvent', () => {
  it('emits to admin-broadcast and each assigned therapist room when attributed', async () => {
    const { io, to, emit } = makeIo();
    mocks.getTherapistIdsForClient.mockResolvedValue([7, 12]);

    await broadcastAdminEvent(io, 'session:started', { sessionId: 's1' }, 42);

    expect(to.mock.calls.map(c => c[0])).toEqual(['admin-broadcast', 'therapist:7', 'therapist:12']);
    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit).toHaveBeenCalledWith('session:started', { sessionId: 's1' });
    expect(mocks.getTherapistIdsForClient).toHaveBeenCalledWith(42);
  });

  it('emits only to admin-broadcast when the participant has no assigned therapists', async () => {
    const { io, to } = makeIo();
    mocks.getTherapistIdsForClient.mockResolvedValue([]);

    await broadcastAdminEvent(io, 'session:activity', { sessionId: 's1' }, 42);

    expect(to.mock.calls.map(c => c[0])).toEqual(['admin-broadcast']);
  });

  it.each([null, undefined])('fails closed (admin-broadcast only, no lookup) for participantUserId=%s', async (uid) => {
    const { io, to } = makeIo();

    await broadcastAdminEvent(io, 'sideband:transcript', { delta: 'x' }, uid);

    expect(to.mock.calls.map(c => c[0])).toEqual(['admin-broadcast']);
    expect(mocks.getTherapistIdsForClient).not.toHaveBeenCalled();
  });

  it('fails closed for non-finite userIds', async () => {
    const { io, to } = makeIo();

    await broadcastAdminEvent(io, 'session:crisis-detected', {}, Number.NaN);

    expect(to.mock.calls.map(c => c[0])).toEqual(['admin-broadcast']);
    expect(mocks.getTherapistIdsForClient).not.toHaveBeenCalled();
  });

  it('fails closed (admin-broadcast only) and does not throw when the caseload lookup fails', async () => {
    const { io, to } = makeIo();
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getTherapistIdsForClient.mockRejectedValue(new Error('db down'));

    await expect(broadcastAdminEvent(io, 'session:crisis-detected', {}, 42)).resolves.toBeUndefined();

    expect(to.mock.calls.map(c => c[0])).toEqual(['admin-broadcast']);
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });
});

describe('broadcastAdminEventForSession', () => {
  it('resolves the session owner and routes to their therapists', async () => {
    const { io, to } = makeIo();
    mocks.getSessionAccessInfo.mockResolvedValue({ status: 'active', user_id: 42, session_type: 'realtime' });
    mocks.getTherapistIdsForClient.mockResolvedValue([7]);

    await broadcastAdminEventForSession(io, 'sideband:transcript', { delta: 'x' }, 'sess-1');

    expect(mocks.getSessionAccessInfo).toHaveBeenCalledWith('sess-1');
    expect(to.mock.calls.map(c => c[0])).toEqual(['admin-broadcast', 'therapist:7']);
  });

  it('coerces string user_id from the session row', async () => {
    const { io } = makeIo();
    mocks.getSessionAccessInfo.mockResolvedValue({ status: 'active', user_id: '42', session_type: 'chat' });
    mocks.getTherapistIdsForClient.mockResolvedValue([]);

    await broadcastAdminEventForSession(io, 'session:activity', {}, 'sess-1');

    expect(mocks.getTherapistIdsForClient).toHaveBeenCalledWith(42);
  });

  it('caches the session->user resolution across calls', async () => {
    const { io } = makeIo();
    mocks.getSessionAccessInfo.mockResolvedValue({ status: 'active', user_id: 42, session_type: 'realtime' });
    mocks.getTherapistIdsForClient.mockResolvedValue([]);

    await broadcastAdminEventForSession(io, 'sideband:transcript', {}, 'sess-1');
    await broadcastAdminEventForSession(io, 'sideband:transcript', {}, 'sess-1');

    expect(mocks.getSessionAccessInfo).toHaveBeenCalledTimes(1);
  });

  it('fails closed for anonymous sessions (user_id null) and missing sessions', async () => {
    const { io, to } = makeIo();
    mocks.getSessionAccessInfo.mockResolvedValueOnce({ status: 'active', user_id: null, session_type: 'realtime' });

    await broadcastAdminEventForSession(io, 'sideband:transcript', {}, 'anon-sess');
    expect(to.mock.calls.map(c => c[0])).toEqual(['admin-broadcast']);

    to.mockClear();
    mocks.getSessionAccessInfo.mockResolvedValueOnce(null);
    await broadcastAdminEventForSession(io, 'sideband:transcript', {}, 'missing-sess');
    expect(to.mock.calls.map(c => c[0])).toEqual(['admin-broadcast']);

    expect(mocks.getTherapistIdsForClient).not.toHaveBeenCalled();
  });

  it('fails closed and does not throw or cache when the session lookup fails', async () => {
    const { io, to } = makeIo();
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getSessionAccessInfo.mockRejectedValueOnce(new Error('db down'));

    await expect(broadcastAdminEventForSession(io, 'sideband:transcript', {}, 'sess-1')).resolves.toBeUndefined();
    expect(to.mock.calls.map(c => c[0])).toEqual(['admin-broadcast']);

    // Failure is not cached: a later call retries the lookup.
    mocks.getSessionAccessInfo.mockResolvedValueOnce({ status: 'active', user_id: 42, session_type: 'realtime' });
    mocks.getTherapistIdsForClient.mockResolvedValue([7]);
    to.mockClear();
    await broadcastAdminEventForSession(io, 'sideband:transcript', {}, 'sess-1');
    expect(to.mock.calls.map(c => c[0])).toEqual(['admin-broadcast', 'therapist:7']);

    consoleErr.mockRestore();
  });
});
