// Tier routing for admin event fan-out (caseworker portal, spec section 5):
// the default tier is 'full' (fail closed — caseworker rooms never see it);
// 'summary' additionally reaches the client's caseworker rooms. Lives in its
// own file so the original adminBroadcast.test.ts mock factory (which predates
// getCaseworkerIdsForClient) stays untouched.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTherapistIdsForClient: vi.fn(),
  getCaseworkerIdsForClient: vi.fn(),
  getSessionAccessInfo: vi.fn(),
  isSandboxAccount: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  getTherapistIdsForClient: mocks.getTherapistIdsForClient,
  getCaseworkerIdsForClient: mocks.getCaseworkerIdsForClient,
  getSessionAccessInfo: mocks.getSessionAccessInfo,
  isSandboxAccount: mocks.isSandboxAccount,
}));

import {
  broadcastAdminEvent,
  broadcastAdminEventForSession,
  clearSessionUserCache,
  clearSandboxUserCache,
  caseworkerRoom,
  therapistRoom,
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
  clearSandboxUserCache();
  mocks.getTherapistIdsForClient.mockResolvedValue([7]);
  mocks.getCaseworkerIdsForClient.mockResolvedValue([21]);
  mocks.isSandboxAccount.mockResolvedValue(false);
});

describe('room name helpers', () => {
  it('mirror each other', () => {
    expect(therapistRoom(7)).toBe('therapist:7');
    expect(caseworkerRoom(21)).toBe('caseworker:21');
  });
});

describe('broadcastAdminEvent tier routing', () => {
  it('defaults to full: caseworker rooms are never looked up or emitted to', async () => {
    const { io, to } = makeIo();
    await broadcastAdminEvent(io, 'sideband:transcript', { delta: 'x' }, 42);
    expect(to.mock.calls.map((c) => c[0])).toEqual(['admin-broadcast', 'therapist:7']);
    expect(mocks.getCaseworkerIdsForClient).not.toHaveBeenCalled();
  });

  it("tier='summary' additionally fans out to caseworker rooms", async () => {
    const { io, to, emit } = makeIo();
    await broadcastAdminEvent(io, 'session:ended', { sessionId: 's1' }, 42, 'summary');
    expect(to.mock.calls.map((c) => c[0])).toEqual([
      'admin-broadcast',
      'therapist:7',
      'caseworker:21',
    ]);
    expect(emit).toHaveBeenCalledTimes(3);
    expect(mocks.getCaseworkerIdsForClient).toHaveBeenCalledWith(42);
  });

  it('summary tier still fails closed for unattributed events', async () => {
    const { io, to } = makeIo();
    await broadcastAdminEvent(io, 'session:ended', {}, null, 'summary');
    expect(to.mock.calls.map((c) => c[0])).toEqual(['admin-broadcast']);
    expect(mocks.getCaseworkerIdsForClient).not.toHaveBeenCalled();
  });

  it('a caseworker lookup failure skips caseworker rooms without throwing', async () => {
    const { io, to } = makeIo();
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getCaseworkerIdsForClient.mockRejectedValue(new Error('db down'));
    await expect(
      broadcastAdminEvent(io, 'session:ended', {}, 42, 'summary')
    ).resolves.toBeUndefined();
    expect(to.mock.calls.map((c) => c[0])).toEqual(['admin-broadcast', 'therapist:7']);
    consoleErr.mockRestore();
  });

  it('a therapist lookup failure still lets summary reach caseworkers', async () => {
    const { io, to } = makeIo();
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getTherapistIdsForClient.mockRejectedValue(new Error('db down'));
    await broadcastAdminEvent(io, 'session:ended', {}, 42, 'summary');
    expect(to.mock.calls.map((c) => c[0])).toEqual(['admin-broadcast', 'caseworker:21']);
    consoleErr.mockRestore();
  });

  it('sandbox summary events skip admin-broadcast but reach the sandbox care team (C13)', async () => {
    const { io, to } = makeIo();
    mocks.isSandboxAccount.mockResolvedValue(true);
    await broadcastAdminEvent(io, 'escalation:created', {}, 42, 'summary');
    expect(to.mock.calls.map((c) => c[0])).toEqual(['therapist:7', 'caseworker:21']);
  });
});

describe('broadcastAdminEventForSession tier passthrough', () => {
  it('forwards the tier after resolving the session owner', async () => {
    const { io, to } = makeIo();
    mocks.getSessionAccessInfo.mockResolvedValue({ status: 'active', user_id: 42, session_type: 'chat' });
    await broadcastAdminEventForSession(io, 'session:ended', {}, 'sess-1', 'summary');
    expect(to.mock.calls.map((c) => c[0])).toEqual([
      'admin-broadcast',
      'therapist:7',
      'caseworker:21',
    ]);
  });

  it('defaults to full when no tier is given', async () => {
    const { io, to } = makeIo();
    mocks.getSessionAccessInfo.mockResolvedValue({ status: 'active', user_id: 42, session_type: 'chat' });
    await broadcastAdminEventForSession(io, 'sideband:transcript', {}, 'sess-1');
    expect(to.mock.calls.map((c) => c[0])).toEqual(['admin-broadcast', 'therapist:7']);
    expect(mocks.getCaseworkerIdsForClient).not.toHaveBeenCalled();
  });
});
