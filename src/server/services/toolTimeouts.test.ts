import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Per-tool execution timeouts (ai-therapist-364): every handler run through
// ToolRegistry.executeTool is bounded, answered exactly once, and a late
// outcome is discarded.
const { getSystemConfigMock } = vi.hoisted(() => ({ getSystemConfigMock: vi.fn() }));
vi.mock('../config/db.js', () => ({ pool: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));
vi.mock('../utils/sessionHelpers.js', () => ({ getSystemConfig: getSystemConfigMock }));
vi.mock('../utils/adminBroadcast.js', () => ({ broadcastAdminEventForSession: vi.fn() }));

import {
  runWithToolTimeout,
  toolTimeoutMs,
  toolTimeoutMessage,
  isToolTimeoutError,
  ToolTimeoutError,
  TOOL_TIMEOUT_DEFAULT_MS,
  TOOL_TIMEOUT_OVERRIDES_MS,
} from './toolTimeouts.js';
import { toolRegistry } from './toolRegistry.service.js';

beforeEach(() => {
  vi.useFakeTimers();
  getSystemConfigMock.mockReset().mockResolvedValue({ features: {} });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the timeout table', () => {
  it('one default, overrides only for tools that do more than local database work', () => {
    expect(toolTimeoutMs('log_mood')).toBe(TOOL_TIMEOUT_DEFAULT_MS);
    expect(toolTimeoutMs('no_such_tool')).toBe(TOOL_TIMEOUT_DEFAULT_MS);
    expect(toolTimeoutMs('find_worksheet')).toBe(10_000);
    expect(toolTimeoutMs('escalate_to_human')).toBe(20_000);
    // Every override names a registered tool, and none is shorter than the default.
    for (const [name, ms] of Object.entries(TOOL_TIMEOUT_OVERRIDES_MS)) {
      expect(toolRegistry.hasTool(name), name).toBe(true);
      expect(ms).toBeGreaterThan(TOOL_TIMEOUT_DEFAULT_MS);
    }
  });
});

describe('runWithToolTimeout', () => {
  it('passes a result or an error through when the handler settles in time', async () => {
    await expect(runWithToolTimeout('log_mood', async () => 'ok')).resolves.toBe('ok');
    await expect(
      runWithToolTimeout('log_mood', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // A synchronous throw from the work function is an ordinary rejection.
    await expect(
      runWithToolTimeout('log_mood', () => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects once with ToolTimeoutError at the limit, and ignores the late result', async () => {
    let finish!: (v: string) => void;
    const outcomes: string[] = [];
    const run = runWithToolTimeout('log_mood', () => new Promise<string>((r) => (finish = r))).then(
      (v) => outcomes.push(`resolved:${v}`),
      (e: unknown) => outcomes.push(isToolTimeoutError(e) ? `timeout:${(e as ToolTimeoutError).timeoutMs}` : 'other'),
    );
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_DEFAULT_MS - 1);
    expect(outcomes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(outcomes).toEqual([`timeout:${TOOL_TIMEOUT_DEFAULT_MS}`]);
    finish('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(outcomes).toEqual([`timeout:${TOOL_TIMEOUT_DEFAULT_MS}`]);
    expect(console.warn).toHaveBeenCalledWith('[ToolRegistry] late tool outcome discarded', expect.any(String));
  });

  it('a late error after the timeout is discarded too (no unhandled rejection)', async () => {
    let fail!: (e: Error) => void;
    const run = runWithToolTimeout('log_mood', () => new Promise<string>((_r, j) => (fail = j)), 100);
    const settled = run.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    expect(isToolTimeoutError(await settled)).toBe(true);
    fail(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(console.warn).toHaveBeenCalledWith('[ToolRegistry] late tool outcome discarded', expect.any(String));
  });

  it('the error tells the model plainly what to say, and names the tool', () => {
    const err = new ToolTimeoutError('find_worksheet', 10_000);
    expect(err.message).toBe(toolTimeoutMessage('find_worksheet'));
    expect(err.message).toMatch(/find_worksheet/);
    expect(err.message).toMatch(/Do not say it worked/);
    expect(err.message).toMatch(/crisis protocol/);
    expect(isToolTimeoutError({ code: 'tool_timeout' })).toBe(true);
    expect(isToolTimeoutError(new Error('x'))).toBe(false);
    expect(isToolTimeoutError(null)).toBe(false);
  });
});

// PR #80 review: what the model is told must be true for the tool that timed
// out. A slow escalate_to_human is still running, so "you could not do it"
// would tell a person in crisis that help could not be reached.
describe('the timeout text per tool', () => {
  it('escalate_to_human: still being sent, never "failed", never call again', () => {
    const text = toolTimeoutMessage('escalate_to_human');
    expect(text).toMatch(/still being sent/);
    expect(text).toMatch(/Do not call escalate_to_human again/);
    expect(text).toMatch(/Do not tell the participant that it failed or that no one could be reached/);
    expect(text).not.toMatch(/could not do it/);
  });

  it('run_risk_check is silent and not repeated; end_session may still close', () => {
    expect(toolTimeoutMessage('run_risk_check')).toMatch(/Do not call run_risk_check again/);
    expect(toolTimeoutMessage('run_risk_check')).toMatch(/say nothing about it to the participant/);
    expect(toolTimeoutMessage('end_session')).toMatch(/may still close/);
  });

  it('a tool that writes may still go through: neither "worked" nor "failed"', () => {
    for (const name of ['remember_this', 'forget_this', 'create_safety_plan', 'switch_language']) {
      const text = toolTimeoutMessage(name);
      expect(text, name).toMatch(/not sure it went through/);
      expect(text, name).not.toMatch(/could not do it/);
      expect(toolRegistry.hasTool(name), name).toBe(true);
    }
    // A read-only lookup did nothing, and may say so.
    expect(toolTimeoutMessage('find_worksheet')).toMatch(/could not do it just now/);
  });
});

describe('ToolRegistry.executeTool', () => {
  it('a repeat escalate_to_human while the first is still running starts no second handler', async () => {
    const finishers: Array<(v: unknown) => void> = [];
    const handler = vi.fn(() => new Promise((r) => finishers.push(r)));
    toolRegistry.registerTool(
      'escalate_to_human',
      { type: 'function', name: 'escalate_to_human', description: 'test', parameters: {} },
      handler,
    );
    const first = toolRegistry.executeTool('escalate_to_human', {}, { sessionId: 'sf1', channel: 'chat' });
    const firstSettled = first.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(toolTimeoutMs('escalate_to_human'));
    expect(isToolTimeoutError(await firstSettled)).toBe(true);

    // Same session, first still running: answered at once, no second handler.
    const repeat = await toolRegistry
      .executeTool('escalate_to_human', {}, { sessionId: 'sf1', channel: 'chat' })
      .catch((e: unknown) => e);
    expect(isToolTimeoutError(repeat)).toBe(true);
    expect((repeat as ToolTimeoutError).alreadyRunning).toBe(true);
    expect((repeat as Error).message).toBe(toolTimeoutMessage('escalate_to_human'));
    // Another session is not held back.
    void toolRegistry.executeTool('escalate_to_human', {}, { sessionId: 'sf2', channel: 'chat' }).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(2);

    // Once the first one finishes, a later call runs again.
    finishers[0]({ success: true });
    await vi.advanceTimersByTimeAsync(0);
    handler.mockImplementationOnce(async () => ({ success: true }));
    await expect(
      toolRegistry.executeTool('escalate_to_human', {}, { sessionId: 'sf1', channel: 'chat' }),
    ).resolves.toEqual({ success: true });
    expect(handler).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(toolTimeoutMs('escalate_to_human'));
  });

  it('a hung handler is answered with ToolTimeoutError once; its late result never reaches the caller', async () => {
    let finish!: (v: unknown) => void;
    const handler = vi.fn(() => new Promise((r) => (finish = r)));
    toolRegistry.registerTool(
      'test_hung_tool',
      { type: 'function', name: 'test_hung_tool', description: 'test', parameters: {} },
      handler,
    );
    const outcomes: unknown[] = [];
    const call = toolRegistry.executeTool('test_hung_tool', {}, { sessionId: 's1', channel: 'realtime' }).then(
      (v) => outcomes.push({ resolved: v }),
      (e: unknown) => outcomes.push({ rejected: isToolTimeoutError(e) ? 'timeout' : String(e) }),
    );
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_DEFAULT_MS);
    await call;
    expect(outcomes).toEqual([{ rejected: 'timeout' }]);
    finish({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(outcomes).toHaveLength(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('the chat channel shares the same wrapper, so the same bound', async () => {
    toolRegistry.registerTool(
      'test_hung_chat_tool',
      { type: 'function', name: 'test_hung_chat_tool', description: 'test', parameters: {} },
      () => new Promise(() => {}),
    );
    const call = toolRegistry.executeTool('test_hung_chat_tool', {}, { sessionId: 's1', channel: 'chat' });
    const settled = call.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_DEFAULT_MS);
    expect(isToolTimeoutError(await settled)).toBe(true);
  });
});
