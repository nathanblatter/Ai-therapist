// ai-therapist-366: POST /logs/batch when the database cannot store the batch.
// The pool now rejects (acquire or statement timeout) where it used to wait
// forever. The participant turns of an owned session are still screened for
// crisis (with no message id), exactly as the GPT-Live sideband path already
// does; the response stays a 500.
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

import logsRoutes from './logs.routes.js';

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

const records = [
  { timestamp: new Date().toISOString(), sessionId: 'rt_1', role: 'user', type: 'voice', message: 'I want to die' },
  { timestamp: new Date().toISOString(), sessionId: 'rt_1', role: 'assistant', type: 'voice', message: 'I hear you' },
];

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getSession.mockResolvedValue({ session_id: 'rt_1', user_id: 7 });
  ownershipMocks.canAccessSession.mockReturnValue(true);
  pipelineMocks.runCrisisPipeline.mockResolvedValue({ steeringGuidance: null });
});

describe('POST /logs/batch when the batch cannot be stored (ai-therapist-366)', () => {
  it.each([
    ['acquire timeout', new Error('timeout exceeded when trying to connect')],
    ['statement timeout', Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })],
  ])('still screens the participant turns of an owned session (%s)', async (_label, err) => {
    dbMocks.insertMessagesBatch.mockRejectedValue(err);
    const res = await request(makeApp()).post('/logs/batch').send({ records });
    expect(res.status).toBe(500);
    await vi.waitFor(() =>
      expect(pipelineMocks.runCrisisPipeline).toHaveBeenCalledWith(
        { sessionId: 'rt_1', messageId: null, content: 'I want to die' },
        'realtime',
      ),
    );
    // Assistant turns are never scored.
    expect(pipelineMocks.runCrisisPipeline).toHaveBeenCalledTimes(1);
  });

  it('scores nothing when the ownership check itself could not run', async () => {
    dbMocks.getSession.mockRejectedValue(new Error('timeout exceeded when trying to connect'));
    const res = await request(makeApp()).post('/logs/batch').send({ records });
    expect(res.status).toBe(500);
    await new Promise((r) => setTimeout(r, 20));
    expect(pipelineMocks.runCrisisPipeline).not.toHaveBeenCalled();
  });
});
