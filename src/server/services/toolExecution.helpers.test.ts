// Chat-path tool execution logging (ai-therapist-236 test backfill). Pins the
// parity contract with the sideband: tool_call then tool_response rows, an
// invocation analytics row, admin socket events, and the never-throws
// error envelope.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { insertMessagesBatchMock, insertToolInvocationMock, executeToolMock, broadcastMock } = vi.hoisted(() => ({
  insertMessagesBatchMock: vi.fn(),
  insertToolInvocationMock: vi.fn(),
  executeToolMock: vi.fn(),
  broadcastMock: vi.fn(),
}));
vi.mock('../db/index.js', () => ({
  insertMessagesBatch: insertMessagesBatchMock,
  insertToolInvocation: insertToolInvocationMock,
}));
vi.mock('./toolRegistry.service.js', () => ({ toolRegistry: { executeTool: executeToolMock } }));
vi.mock('../utils/adminBroadcast.js', () => ({ broadcastAdminEventForSession: broadcastMock }));

import { executeLoggedToolCall } from './toolExecution.helpers.js';

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  insertMessagesBatchMock.mockReset().mockResolvedValue([{ message_id: 1 }]);
  insertToolInvocationMock.mockReset().mockResolvedValue(undefined);
  executeToolMock.mockReset();
  broadcastMock.mockReset().mockResolvedValue(undefined);
  (global as unknown as { io: unknown }).io = { to: () => ({ emit: vi.fn() }) };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  (global as unknown as { io: unknown }).io = undefined;
  vi.restoreAllMocks();
});

describe('executeLoggedToolCall', () => {
  it('logs tool_call then tool_response, records a successful invocation, and broadcasts both phases', async () => {
    executeToolMock.mockResolvedValueOnce({ mood: 'ok' });
    const r = await executeLoggedToolCall('sess_1', 'log_mood', { mood: 'ok' }, 'call_1');
    await settle();

    expect(r).toEqual({ result: { mood: 'ok' }, success: true });
    expect(executeToolMock).toHaveBeenCalledWith('log_mood', { mood: 'ok' }, { sessionId: 'sess_1', channel: 'chat' });

    const types = insertMessagesBatchMock.mock.calls.map((c) => c[0][0].message_type);
    expect(types).toEqual(['tool_call', 'tool_response']);
    expect(insertMessagesBatchMock.mock.calls[1][0][0].metadata).toMatchObject({
      tool_name: 'log_mood',
      call_id: 'call_1',
      response: { mood: 'ok' },
      status: 'completed',
      channel: 'chat',
    });
    expect(insertToolInvocationMock).toHaveBeenCalledWith('sess_1', 'log_mood', { mood: 'ok' }, true);
    const statuses = broadcastMock.mock.calls.map((c) => c[2].status);
    expect(statuses).toEqual(['executing', 'completed']);
  });

  it('captures a handler failure as an error envelope, logs a failed invocation, and never throws', async () => {
    executeToolMock.mockRejectedValueOnce(new Error('boom'));
    const r = await executeLoggedToolCall('sess_1', 'find_worksheet', { q: 'x' }, 'call_2', 'realtime');
    await settle();

    expect(r).toEqual({ result: { error: 'boom', success: false }, success: false });
    const last = insertMessagesBatchMock.mock.calls.at(-1)![0][0];
    expect(last.content).toBe('Tool error: find_worksheet');
    expect(last.metadata).toMatchObject({ status: 'failed', error: 'boom', channel: 'realtime' });
    expect(insertToolInvocationMock).toHaveBeenCalledWith('sess_1', 'find_worksheet', null, false);
    expect(broadcastMock.mock.calls.at(-1)![2]).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('still executes the tool when transcript logging fails', async () => {
    insertMessagesBatchMock.mockRejectedValue(new Error('db down'));
    executeToolMock.mockResolvedValueOnce('done');
    const r = await executeLoggedToolCall('sess_1', 'remember_this', {}, 'call_3');
    expect(r).toEqual({ result: 'done', success: true });
  });

  it('skips socket broadcasts when no io server is attached', async () => {
    (global as unknown as { io: unknown }).io = undefined;
    executeToolMock.mockResolvedValueOnce(null);
    await executeLoggedToolCall('sess_1', 'noop', {}, 'call_4');
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});
