// ai-therapist-373: POST /logs/batch keeps every conversational record in
// process memory before it is stored (the crisis pipeline's context when the
// database cannot give it), once per record even when the browser re-sends a
// batch, and a session it creates is known to have started here.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  insertMessagesBatch: vi.fn(),
  upsertSessionConfig: vi.fn(),
  createActiveRealtimeSession: vi.fn(),
  getSessionMessageCount: vi.fn(),
}));
const pipelineMocks = vi.hoisted(() => ({ runCrisisPipeline: vi.fn() }));
const ownershipMocks = vi.hoisted(() => ({ canAccessSession: vi.fn(), recordSessionOwnership: vi.fn() }));

vi.mock('../../db/index.js', () => dbMocks);
vi.mock('../../utils/sessionHelpers.js', () => ({ getSystemPrompt: vi.fn(async () => 'prompt') }));
vi.mock('../../utils/sessionOwnership.js', () => ownershipMocks);
vi.mock('../../utils/adminBroadcast.js', () => ({ broadcastAdminEventForSession: vi.fn(async () => undefined) }));
vi.mock('../../services/crisisPipeline.service.js', () => pipelineMocks);
vi.mock('../../utils/quietHours.js', () => ({ isQuietHoursActive: () => false }));
vi.mock('../../utils/harness.js', () => ({ isNonStudyUser: () => false }));

import logsRoutes from './logs.routes.js';
const { recentTurns, _resetRecentTurnsForTests } = await import('../../utils/recentTurns.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: 7, userRole: 'participant' } as unknown as typeof req.session;
    next();
  });
  app.use(logsRoutes());
  return app;
}

const T0 = Date.parse('2030-01-01T12:00:00Z');
const record = (role: string, message: string, offsetMs: number, type = 'voice') => ({
  timestamp: new Date(T0 + offsetMs).toISOString(),
  sessionId: 'rt_1',
  role,
  type,
  message,
});

beforeEach(() => {
  vi.clearAllMocks();
  _resetRecentTurnsForTests();
  dbMocks.getSession.mockResolvedValue({ session_id: 'rt_1', user_id: 7 });
  dbMocks.insertMessagesBatch.mockResolvedValue([]);
  dbMocks.getSessionMessageCount.mockResolvedValue(0);
  ownershipMocks.canAccessSession.mockReturnValue(true);
  pipelineMocks.runCrisisPipeline.mockResolvedValue({ steeringGuidance: null });
  (globalThis as { io?: unknown }).io = { to: () => ({ emit: () => undefined }) };
});

describe('POST /logs/batch keeps the turns in memory', () => {
  it('participant and assistant records, at the browser time, but no bookkeeping records', async () => {
    const res = await request(makeApp())
      .post('/logs/batch')
      .send({
        records: [
          record('assistant', 'Are you thinking about suicide?', 0),
          record('user', 'yes', 2_000),
          record('assistant', 'show_resources', 2_500, 'function_call'),
          record('system', 'session started', 3_000),
        ],
      });
    expect(res.status).toBe(200);
    const held = recentTurns('rt_1');
    expect(held?.turns.map((t) => [t.role, t.content, t.at])).toEqual([
      ['assistant', 'Are you thinking about suicide?', T0],
      ['user', 'yes', T0 + 2_000],
    ]);
    // An existing session this process did not start: not complete.
    expect(held?.complete).toBe(false);
  });

  it('a batch the database could not store is kept too, and kept once when the browser re-sends it', async () => {
    dbMocks.insertMessagesBatch.mockRejectedValue(new Error('timeout exceeded when trying to connect'));
    const app = makeApp();
    const first = [record('assistant', 'Are you safe right now?', 0), record('user', 'no', 1_000)];
    await request(app).post('/logs/batch').send({ records: first });
    await request(app)
      .post('/logs/batch')
      .send({ records: [...first, record('user', 'I have the pills', 5_000)] });
    expect(recentTurns('rt_1')?.turns.map((t) => t.content)).toEqual([
      'Are you safe right now?',
      'no',
      'I have the pills',
    ]);
  });

  it('a session the batch creates started here: its record is complete', async () => {
    dbMocks.getSession.mockResolvedValue(null);
    dbMocks.createActiveRealtimeSession.mockResolvedValue(undefined);
    dbMocks.upsertSessionConfig.mockResolvedValue(undefined);
    await request(makeApp())
      .post('/logs/batch')
      .send({ records: [record('user', 'hello', 0)] });
    expect(recentTurns('rt_1')?.complete).toBe(true);
  });

  it('a batch refused for a foreign session keeps nothing', async () => {
    ownershipMocks.canAccessSession.mockReturnValue(false);
    const res = await request(makeApp())
      .post('/logs/batch')
      .send({ records: [record('user', 'hello', 0)] });
    expect(res.status).toBe(403);
    expect(recentTurns('rt_1')).toBeNull();
  });
});
