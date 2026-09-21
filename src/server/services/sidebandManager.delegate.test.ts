import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The GPT-Live SidebandManager forwards its control surface to a registered
// delegate for the sessions that delegate owns (docs/grok-voice.md). Every
// existing call site — crisis steering, admin routes, session end — imports
// sidebandManager, so this forwarding is what makes Grok sessions steerable
// without touching those call sites.

vi.mock('ws', () => {
  const ctor = vi.fn(() => ({ on: vi.fn(), send: vi.fn(), ping: vi.fn(), close: vi.fn(), readyState: 1 }));
  (ctor as unknown as { OPEN: number }).OPEN = 1;
  return { default: ctor };
});
vi.mock('../config/db.js', () => ({ pool: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));
vi.mock('../db/index.js', () => ({
  insertMessagesBatch: vi.fn(), insertToolInvocation: vi.fn(), recordLlmUsage: vi.fn(),
}));
vi.mock('../utils/adminBroadcast.js', () => ({ broadcastAdminEventForSession: vi.fn() }));

import { sidebandManager, type VoiceSidebandDelegate } from './sidebandManager.service.js';

function fakeDelegate(owned: string[]): VoiceSidebandDelegate & { calls: string[] } {
  const calls: string[] = [];
  const rec = (name: string) => (...args: unknown[]) => { calls.push(`${name}:${String(args[0])}`); return Promise.resolve(); };
  return {
    calls,
    owns: id => owned.includes(id),
    isConnected: id => owned.includes(id),
    getActiveConnections: () => owned,
    tryInject: (id) => { calls.push(`tryInject:${id}`); return Promise.resolve(true); },
    injectMessage: rec('injectMessage'),
    updateSession: rec('updateSession'),
    interrupt: rec('interrupt'),
    createResponse: rec('createResponse'),
    triggerTool: rec('triggerTool'),
    disconnect: rec('disconnect'),
    shutdown: () => { calls.push('shutdown'); return Promise.resolve(); },
  };
}

beforeEach(() => {
  sidebandManager._clearDelegatesForTests();
});
afterEach(() => {
  sidebandManager._clearDelegatesForTests();
});

describe('SidebandManager delegate forwarding', () => {
  it('routes every control call for an owned session to the delegate', async () => {
    const d = fakeDelegate(['grok_a']);
    sidebandManager.registerDelegate(d);
    sidebandManager.registerDelegate(d); // idempotent

    expect(sidebandManager.isConnected('grok_a')).toBe(true);
    expect(await sidebandManager.tryInject('grok_a', 'system', 'hi', false)).toBe(true);
    await sidebandManager.injectMessage('grok_a', 'system', 'hi', true);
    await sidebandManager.updateSession('grok_a', { instructions: 'x' });
    await sidebandManager.interrupt('grok_a');
    await sidebandManager.createResponse('grok_a');
    await sidebandManager.triggerTool('grok_a', 'find_worksheet');
    await sidebandManager.disconnect('grok_a');
    expect(d.calls).toEqual([
      'tryInject:grok_a', 'injectMessage:grok_a', 'updateSession:grok_a', 'interrupt:grok_a',
      'createResponse:grok_a', 'triggerTool:grok_a', 'disconnect:grok_a',
    ]);
  });

  it('leaves sessions the delegate does not own on the GPT-Live path', async () => {
    const d = fakeDelegate(['grok_a']);
    sidebandManager.registerDelegate(d);
    expect(sidebandManager.isConnected('live_b')).toBe(false);
    expect(await sidebandManager.tryInject('live_b', 'system', 'hi', false)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  it('lists delegate sessions among the active connections and shuts them down', async () => {
    const d = fakeDelegate(['grok_a', 'grok_b']);
    sidebandManager.registerDelegate(d);
    expect(sidebandManager.getActiveConnections()).toEqual(expect.arrayContaining(['grok_a', 'grok_b']));
    await sidebandManager.shutdown();
    expect(d.calls).toContain('shutdown');
  });
});
