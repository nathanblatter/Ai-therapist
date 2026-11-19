// ai-therapist-369 item 1: escalate_to_human at high urgency requests the
// on-call page and shows the crisis card before anything touches the
// database; the flag write runs alongside. Every pool call here waits until the
// test opens its gate (a database that has stopped answering).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => {
  const gate = { opened: false, promise: Promise.resolve(), open: () => undefined as void };
  const reset = () => {
    gate.opened = false;
    gate.promise = new Promise<void>((resolve) => {
      gate.open = () => {
        gate.opened = true;
        resolve();
      };
    });
  };
  reset();
  return {
    gate,
    reset,
    failWrites: { value: false },
    query: vi.fn(),
    connect: vi.fn(),
    pageHighRisk: vi.fn(),
    retryCrisisRecord: vi.fn(),
    emit: vi.fn(),
  };
});

vi.mock('../config/db.js', () => ({ pool: { query: m.query, connect: m.connect } }));
vi.mock('./crisisPaging.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./crisisPaging.service.js')>()),
  pageHighRisk: m.pageHighRisk,
  retryCrisisRecord: m.retryCrisisRecord,
}));
vi.mock('../utils/sessionHelpers.js', () => ({
  getSystemConfig: vi.fn(async () => ({ features: {} })),
  resolveVendorCeilingMinutes: vi.fn(async () => 60),
}));
vi.mock('./sidebandManager.service.js', () => ({
  sidebandManager: {
    getActiveConnections: () => [] as string[],
    isConnected: () => false,
    injectMessage: vi.fn(async () => undefined),
  },
}));
vi.mock('../utils/sessionAutoTerminate.js', () => ({
  liftLimitForCrisis: vi.fn(() => ({ lifted: false, previousLimitMinutes: null, ceilingMinutes: 60 })),
}));
vi.mock('./adverseEvent.service.js', () => ({ draftAdverseEventFromCrisis: vi.fn(async () => null) }));

const { toolRegistry } = await import('./toolRegistry.service.js');
const { clearCrisisResourceState } = await import('./crisisResources.js');
const { _settleBackgroundForTests } = await import('../utils/backgroundWork.js');
await import('./crisisIntervention.service.js');
await import('./crisisDetection.service.js');

const SESSION = 'live_escalate';
const tick = () => new Promise((resolve) => setImmediate(resolve));
// Bounded by elapsed time, not by a tick count: the first call in this file
// loads the escalation path's lazy imports on real I/O, and on a loaded CI
// runner 2000 setImmediate turns ran out before that finished (the deploy of
// 7f771db failed on this).
async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (!condition() && performance.now() < deadline) await tick();
  expect(condition()).toBe(true);
}
const sqlOf = (sql: unknown): string =>
  typeof sql === 'string' ? sql : String((sql as { text?: string })?.text ?? '');

beforeEach(() => {
  vi.clearAllMocks();
  m.reset();
  m.failWrites.value = false;
  clearCrisisResourceState();
  (global as unknown as { io: unknown }).io = { to: vi.fn(() => ({ emit: m.emit })) };
  const answer = async (sql: unknown) => {
    await m.gate.promise;
    if (m.failWrites.value && !/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sqlOf(sql))) {
      throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    }
    return { rows: [{ event_id: 1 }], rowCount: 1 };
  };
  m.query.mockImplementation(answer);
  m.connect.mockImplementation(async () => {
    await m.gate.promise;
    return { query: vi.fn(answer), release: vi.fn() };
  });
  m.pageHighRisk.mockResolvedValue({ outcome: 'paged' });
});
afterEach(async () => {
  m.gate.open();
  await _settleBackgroundForTests();
});

const escalate = () =>
  toolRegistry.executeTool('escalate_to_human', { reason: 'states a plan', urgency: 'high' }, { sessionId: SESSION });

describe('escalate_to_human (high): the page never waits on the database', () => {
  it('the page is requested and the card shown while every database call is still waiting', async () => {
    const done = escalate();
    await until(() => m.pageHighRisk.mock.calls.length > 0);
    expect(m.gate.opened).toBe(false);
    expect(m.pageHighRisk).toHaveBeenCalledWith(SESSION, 80, expect.objectContaining({ source: 'model_escalation' }));
    expect(m.emit).toHaveBeenCalledWith('session:crisis-emergency', expect.objectContaining({ sessionId: SESSION }));
    // The flag write was started alongside, not after.
    await until(() => m.connect.mock.calls.length > 0);

    m.gate.open();
    const result = (await done) as { success?: boolean };
    expect(result.success).toBe(true);
    expect(m.pageHighRisk).toHaveBeenCalledTimes(1);
  });

  it('single flight: a second call while the first runs starts no second handler', async () => {
    const first = escalate();
    await until(() => m.pageHighRisk.mock.calls.length > 0);
    const second = escalate();
    second.catch(() => undefined); // inspected below with allSettled
    for (let i = 0; i < 50; i++) await tick();
    m.gate.open();
    const [a, b] = await Promise.allSettled([first, second]);
    expect(a.status).toBe('fulfilled');
    // The repeat is answered as "still being sent" (toolTimeouts), not run.
    expect(b).toMatchObject({ status: 'rejected', reason: { alreadyRunning: true } });
    await _settleBackgroundForTests();
    expect(m.pageHighRisk).toHaveBeenCalledTimes(1);
    expect(m.connect).toHaveBeenCalledTimes(1);
  });

  it('a flag write that fails is retried in the background and the page is not affected', async () => {
    m.failWrites.value = true;
    m.gate.open();
    const result = (await escalate()) as { success?: boolean };
    expect(result.success).toBe(true);
    expect(m.pageHighRisk).toHaveBeenCalledTimes(1);
    await until(() => m.retryCrisisRecord.mock.calls.length > 0);
    expect(m.retryCrisisRecord).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION, what: 'crisis flag' }),
    );
  });
});
