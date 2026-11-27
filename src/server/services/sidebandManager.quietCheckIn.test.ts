// The quiet check-in wired into the GPT-Live sideband (ai-therapist-414): a
// safety question the participant meets with silence is followed, once, by a
// commentary append asking the voice model to check in, and staff can see it.
// The rule itself is covered in liveQuietCheckIn.service.test.ts; this file
// drives it through the sideband's real event handling over a fake socket.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, insertMessagesBatchMock, runCrisisPipelineMock, broadcastMock, logInterventionActionMock } =
  vi.hoisted(() => ({
    queryMock: vi.fn(),
    insertMessagesBatchMock: vi.fn(),
    runCrisisPipelineMock: vi.fn(),
    broadcastMock: vi.fn(),
    logInterventionActionMock: vi.fn(),
  }));

interface FakeSocket {
  on: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  readyState: number;
}

const { WS_OPEN, fakeWs } = vi.hoisted(() => {
  const OPEN = 1;
  return {
    WS_OPEN: OPEN,
    fakeWs: () => ({ on: vi.fn(), send: vi.fn(), ping: vi.fn(), close: vi.fn(), readyState: OPEN }),
  };
});

vi.mock('ws', () => {
  const ctor = vi.fn(function () {
    return fakeWs();
  });
  (ctor as unknown as { OPEN: number }).OPEN = WS_OPEN;
  return { default: ctor };
});
vi.mock('../config/db.js', () => ({ pool: { query: queryMock } }));
vi.mock('../db/index.js', () => ({
  insertMessagesBatch: insertMessagesBatchMock,
  insertToolInvocation: vi.fn().mockResolvedValue(undefined),
  recordLlmUsage: vi.fn().mockResolvedValue(undefined),
  insertMessage: vi.fn().mockResolvedValue({}),
  insertClientEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../db/liveUsage.queries.js', () => ({ recordLiveUsage: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./crisisPipeline.service.js', () => ({ runCrisisPipeline: runCrisisPipelineMock }));
vi.mock('./toolRegistry.service.js', () => ({ toolRegistry: { executeTool: vi.fn() } }));
vi.mock('../utils/adminBroadcast.js', () => ({ broadcastAdminEventForSession: broadcastMock }));
vi.mock('../utils/safetyIdentifier.js', () => ({ safetyIdentifierForSession: vi.fn().mockResolvedValue('sid-test') }));
vi.mock('../utils/sessionHelpers.js', () => ({
  getSystemConfig: vi.fn().mockResolvedValue({ features: {}, session_limits: { enabled: false } }),
  getActiveModality: vi.fn().mockResolvedValue(null),
}));
// The real safety-question screen, with the intervention log observed.
vi.mock('./crisisDetection.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./crisisDetection.service.js')>()),
  logInterventionAction: logInterventionActionMock,
}));

import { sidebandManager } from './sidebandManager.service.js';
import {
  LIVE_QUIET_CHECK_IN_AFTER_MS,
  LIVE_QUIET_CHECK_IN_COMMENTARY,
  _resetQuietCheckInForTests,
} from './liveQuietCheckIn.service.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Internal = any;
const sb = sidebandManager as unknown as Internal;

const TURN_GAP_MS = 900;
const QUESTION = "I'm here with you. Are you having thoughts of suicide?";

async function attach(sessionId: string, options: Record<string, unknown> = {}): Promise<FakeSocket> {
  const ws = await sidebandManager.connect(sessionId, `live_${sessionId}`, 'sk-test', {
    model: 'gpt-live-1',
    backendModel: 'gpt-5.6-terra',
    ...options,
  });
  return ws as unknown as FakeSocket;
}

async function fire(sessionId: string, event: Record<string, unknown>): Promise<void> {
  await sb.handleMessage(sessionId, Buffer.from(JSON.stringify(event)));
}

const commentary = (ws: FakeSocket): string[] =>
  ws.send.mock.calls
    .map((c: unknown[]) => JSON.parse(c[0] as string) as { type: string; content?: string })
    .filter((e) => e.type === 'session.commentary.append')
    .map((e) => e.content ?? '');

/** The assistant says a whole turn, and the turn closes. */
async function assistantSays(sessionId: string, text: string): Promise<void> {
  await fire(sessionId, { type: 'session.output_transcript.delta', delta: text, start_ms: 0, end_ms: 2_000 });
  await vi.advanceTimersByTimeAsync(TURN_GAP_MS);
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
}

// The screen is imported lazily by the check-in; loaded here so that under
// fake timers the import resolves without real time passing.
beforeAll(async () => {
  await import('./crisisDetection.service.js');
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-26T12:00:00Z'));
  sb.sessions.clear();
  sb.endedSessions.clear();
  _resetQuietCheckInForTests();
  queryMock.mockReset().mockResolvedValue({ rows: [] });
  insertMessagesBatchMock.mockReset().mockResolvedValue([{ message_id: 42 }]);
  runCrisisPipelineMock.mockReset().mockResolvedValue({ severity: 'none' });
  broadcastMock.mockReset().mockResolvedValue(undefined);
  logInterventionActionMock.mockReset().mockResolvedValue(undefined);
  (global as Internal).io = { to: () => ({ emit: vi.fn() }) };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllTimers();
  _resetQuietCheckInForTests();
  sb.sessions.clear();
  sb.endedSessions.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('quiet check-in on the sideband', () => {
  it('asks the model to check in once after the quiet period, and tells staff', async () => {
    const s = 'quiet-1';
    const ws = await attach(s);
    await assistantSays(s, QUESTION);
    await vi.advanceTimersByTimeAsync(LIVE_QUIET_CHECK_IN_AFTER_MS - TURN_GAP_MS - 1_000);
    expect(commentary(ws)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(commentary(ws)).toEqual([LIVE_QUIET_CHECK_IN_COMMENTARY]);
    expect(broadcastMock).toHaveBeenCalledWith(
      expect.anything(),
      'live:quiet-check-in',
      expect.objectContaining({ sessionId: s, sent: true, attempt: 1 }),
      s,
    );
    expect(logInterventionActionMock).toHaveBeenCalledWith(
      s,
      'risk_steering',
      expect.objectContaining({ trigger: 'quiet_check_in', delivered: true, count: 1 }),
    );
    // Nothing more, however long the silence lasts.
    await vi.advanceTimersByTimeAsync(LIVE_QUIET_CHECK_IN_AFTER_MS * 4);
    expect(commentary(ws)).toHaveLength(1);
  });

  it('stays out of it when the participant answers', async () => {
    const s = 'quiet-2';
    const ws = await attach(s);
    await assistantSays(s, QUESTION);
    await vi.advanceTimersByTimeAsync(6_000);
    await fire(s, { type: 'session.input_transcript.delta', delta: 'Sometimes.', start_ms: 9_000, end_ms: 9_500 });
    await vi.advanceTimersByTimeAsync(LIVE_QUIET_CHECK_IN_AFTER_MS * 2);
    expect(commentary(ws)).toEqual([]);
  });

  it('stays out of it when the participant answers by typing', async () => {
    const s = 'quiet-typed';
    const ws = await attach(s);
    await assistantSays(s, QUESTION);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(sidebandManager.sendParticipantText(s, 'yes, sometimes')).toBe(true);
    await vi.advanceTimersByTimeAsync(LIVE_QUIET_CHECK_IN_AFTER_MS * 2);
    expect(commentary(ws)).toEqual([]);
  });

  it('does nothing after an ordinary question', async () => {
    const s = 'quiet-3';
    const ws = await attach(s);
    await assistantSays(s, 'That sounds like a long week. What has been the hardest part?');
    await vi.advanceTimersByTimeAsync(LIVE_QUIET_CHECK_IN_AFTER_MS * 2);
    expect(commentary(ws)).toEqual([]);
  });

  it('is not used on a crisis recovery session', async () => {
    const s = 'quiet-4';
    const ws = await attach(s, { delegationMode: 'client' });
    await assistantSays(s, QUESTION);
    await vi.advanceTimersByTimeAsync(LIVE_QUIET_CHECK_IN_AFTER_MS * 2);
    expect(commentary(ws).filter((c) => c === LIVE_QUIET_CHECK_IN_COMMENTARY)).toEqual([]);
  });

  it('sends nothing once the session has been disconnected', async () => {
    const s = 'quiet-5';
    const ws = await attach(s);
    await assistantSays(s, QUESTION);
    const closing = sidebandManager.disconnect(s);
    await vi.advanceTimersByTimeAsync(LIVE_QUIET_CHECK_IN_AFTER_MS * 2);
    await closing;
    expect(commentary(ws)).toEqual([]);
  });
});
