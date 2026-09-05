// IRB-claims enforcement on the public session routes: the weekly PHQ-2/GAD-2
// cadence gate on /scale-response (consent form: "each no more than once per
// week") and the per-participant recording-consent gate on /audio (migrations
// 039/086 — the latest consent snapshot must allow recording, not just the
// global feature flag).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  getUserSessions: vi.fn(),
  getSessionMessages: vi.fn(),
  getSessionConfig: vi.fn(),
  updateSessionStatus: vi.fn(),
  getSessionAccessInfo: vi.fn(),
  setSessionCallId: vi.fn(),
  insertScaleResponse: vi.fn(),
  getUserLatestScaleScore: vi.fn(),
  isRecordingConsentedForSession: vi.fn(),
}));
const recorderMocks = vi.hoisted(() => ({
  appendChunk: vi.fn(),
  isFinalized: vi.fn(),
}));
const helperMocks = vi.hoisted(() => ({
  getSystemConfig: vi.fn(),
}));

vi.mock('../../db/index.js', () => dbMocks);
vi.mock('../../services/recorder.service.js', () => recorderMocks);
vi.mock('../../services/sessionLifecycle.service.js', () => ({
  noteSessionActivity: vi.fn(),
}));
vi.mock('../../utils/sessionHelpers.js', () => helperMocks);
vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../middleware/quietHours.js', () => ({
  requireOutsideQuietHours: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../middleware/studyStatus.js', () => ({
  requireActiveStudyStatus: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../services/sessionName.service.js', () => ({
  generateSessionNameAsync: vi.fn(),
}));
vi.mock('../../utils/adminBroadcast.js', () => ({
  broadcastAdminEventForSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/sidebandManager.service.js', () => ({
  sidebandManager: {
    tryInject: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));

import sessionsRoutes from './sessions.routes.js';

const SESSION_ID = 'sess_test_1';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Cookie ownership so the audio route's hot path skips the access lookup.
    req.session = { ownedSessions: [SESSION_ID] } as unknown as typeof req.session;
    next();
  });
  app.use(sessionsRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  helperMocks.getSystemConfig.mockResolvedValue({ features: { session_recording_enabled: true } });
  recorderMocks.isFinalized.mockReturnValue(false);
  dbMocks.getSessionAccessInfo.mockResolvedValue({ status: 'active', user_id: 42, session_type: 'realtime' });
  dbMocks.insertScaleResponse.mockResolvedValue(undefined);
  dbMocks.getUserLatestScaleScore.mockResolvedValue(null);
  dbMocks.isRecordingConsentedForSession.mockResolvedValue(true);
  (globalThis as { io?: unknown }).io = { to: () => ({ emit: () => {} }) };
});

describe('POST /api/sessions/:id/audio recording-consent gate (039/086)', () => {
  const body = { chunks: ['AAAA'], sampleRate: 24000, track: 'participant' };

  it('persists audio when the global flag is on and the owner consented', async () => {
    const res = await request(makeApp()).post(`/api/sessions/${SESSION_ID}/audio`).send(body);
    expect(res.status).toBe(204);
    expect(recorderMocks.appendChunk).toHaveBeenCalledWith(SESSION_ID, 'AAAA', 24000, 'participant');
  });

  it('drops BOTH tracks when the owner\'s latest consent has recording_enabled=false', async () => {
    dbMocks.isRecordingConsentedForSession.mockResolvedValue(false);
    for (const track of ['participant', 'mixed']) {
      const res = await request(makeApp())
        .post(`/api/sessions/${SESSION_ID}/audio`)
        .send({ ...body, track });
      // 204, not an error — the client uploader must not surface a failure.
      expect(res.status).toBe(204);
    }
    expect(recorderMocks.appendChunk).not.toHaveBeenCalled();
  });

  it('still drops audio on the global flag alone, before the consent lookup', async () => {
    helperMocks.getSystemConfig.mockResolvedValue({ features: { session_recording_enabled: false } });
    const res = await request(makeApp()).post(`/api/sessions/${SESSION_ID}/audio`).send(body);
    expect(res.status).toBe(204);
    expect(recorderMocks.appendChunk).not.toHaveBeenCalled();
    expect(dbMocks.isRecordingConsentedForSession).not.toHaveBeenCalled();
  });
});

describe('POST /api/sessions/:id/scale-response weekly cadence gate', () => {
  const body = { scale: 'phq2', answers: [1, 2] };

  it('rejects with a structured 409 when the scale was administered within 7 days', async () => {
    dbMocks.getUserLatestScaleScore.mockResolvedValue({
      score: 3, created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), session_id: 's0',
    });
    const res = await request(makeApp()).post(`/api/sessions/${SESSION_ID}/scale-response`).send(body);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('scale_recently_administered');
    expect(res.body.scale).toBe('phq2');
    expect(dbMocks.getUserLatestScaleScore).toHaveBeenCalledWith(42, 'phq2');
    expect(dbMocks.insertScaleResponse).not.toHaveBeenCalled();
  });

  it('stores the response when the last administration is at least 7 days old', async () => {
    dbMocks.getUserLatestScaleScore.mockResolvedValue({
      score: 3, created_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), session_id: 's0',
    });
    const res = await request(makeApp()).post(`/api/sessions/${SESSION_ID}/scale-response`).send(body);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(dbMocks.insertScaleResponse).toHaveBeenCalledWith(SESSION_ID, 'phq2', [1, 2], 3);
  });

  it('stores a first-ever response', async () => {
    const res = await request(makeApp()).post(`/api/sessions/${SESSION_ID}/scale-response`).send(body);
    expect(res.status).toBe(200);
    expect(dbMocks.insertScaleResponse).toHaveBeenCalled();
  });

  it('does not gate sessions without a linked user (demo/anonymous)', async () => {
    dbMocks.getSessionAccessInfo.mockResolvedValue({ status: 'active', user_id: null, session_type: 'chat' });
    const res = await request(makeApp()).post(`/api/sessions/${SESSION_ID}/scale-response`).send(body);
    expect(res.status).toBe(200);
    expect(dbMocks.getUserLatestScaleScore).not.toHaveBeenCalled();
    expect(dbMocks.insertScaleResponse).toHaveBeenCalled();
  });
});
