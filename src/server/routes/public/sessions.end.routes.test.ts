// The participant's own End (POST /api/sessions/:id/end) on a voice session.
// It used to send its closing note with tryInject and close the session right
// after; on GPT-Live the note could never be used and the vendor answered the
// close with a `context_injection_incomplete` error, stored as a sideband
// error on every participant-ended session (87 of 87 measured, 2026-11-25).
// The route now hands the note to injectClosingNote, which sends it only where
// it can land (sidebandManager.service.test.ts covers that half).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { getSessionMock, updateSessionStatusMock, sidebandMocks } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  updateSessionStatusMock: vi.fn(),
  sidebandMocks: {
    tryInject: vi.fn(),
    injectMessage: vi.fn(),
    injectClosingNote: vi.fn(),
    disconnect: vi.fn(),
  },
}));

vi.mock('../../db/index.js', () => ({
  getSession: getSessionMock,
  updateSessionStatus: updateSessionStatusMock,
  getUserSessions: vi.fn(),
  getSessionMessages: vi.fn(),
  getSessionConfig: vi.fn(),
  getSessionAccessInfo: vi.fn(),
}));
vi.mock('../../db/studyStatus.queries.js', () => ({ getStudyStatus: vi.fn().mockResolvedValue('active') }));
vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../utils/sessionHelpers.js', () => ({ getSystemConfig: vi.fn().mockResolvedValue({ features: {} }) }));
vi.mock('../../utils/adminBroadcast.js', () => ({
  broadcastAdminEventForSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../utils/sessionAutoTerminate.js', () => ({ cancelAutoTermination: vi.fn() }));
vi.mock('../../services/sessionLifecycle.service.js', () => ({ noteSessionActivity: vi.fn() }));
vi.mock('../../services/liveOpening.service.js', () => ({ deliverLiveOpeningViaSideband: vi.fn() }));
vi.mock('../../services/sessionName.service.js', () => ({ generateSessionNameAsync: vi.fn() }));
vi.mock('../../services/sidebandManager.service.js', () => ({ sidebandManager: sidebandMocks }));
vi.mock('../../services/sessionRedaction.service.js', () => ({ redactSession: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/recorder.service.js', () => ({
  appendChunk: vi.fn(),
  isFinalized: vi.fn(),
  trackSampleRate: vi.fn(),
  finalize: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/acousticFeatures.service.js', () => ({
  generateAcousticFeaturesAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/sessionInsights.service.js', () => ({
  generateSessionInsightsAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/sessionEval.service.js', () => ({
  maybeAutoEvalSession: vi.fn().mockResolvedValue(undefined),
}));

import sessionsRoutes from './sessions.routes.js';

const SESSION_ID = 'live_end_1';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { ownedSessions: [SESSION_ID] } as unknown as typeof req.session;
    next();
  });
  app.use(sessionsRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { io?: unknown }).io = { to: () => ({ emit: vi.fn() }) };
  getSessionMock.mockResolvedValue({ session_id: SESSION_ID, status: 'active', user_id: null });
  updateSessionStatusMock.mockResolvedValue({ session_id: SESSION_ID, status: 'ended' });
  sidebandMocks.tryInject.mockResolvedValue(true);
  sidebandMocks.injectClosingNote.mockResolvedValue(false);
  sidebandMocks.disconnect.mockResolvedValue(undefined);
});

describe('POST /api/sessions/:sessionId/end', () => {
  it('leaves the closing note to injectClosingNote and never appends it as a steer', async () => {
    const res = await request(makeApp()).post(`/api/sessions/${SESSION_ID}/end`).expect(200);

    expect(res.body.message).toMatch(/ended successfully/i);
    expect(updateSessionStatusMock).toHaveBeenCalledWith(SESSION_ID, 'ended', 'user');
    expect(sidebandMocks.tryInject).not.toHaveBeenCalled();
    expect(sidebandMocks.injectMessage).not.toHaveBeenCalled();
    // The wording is unchanged.
    expect(sidebandMocks.injectClosingNote).toHaveBeenCalledExactlyOnceWith(
      SESSION_ID,
      '[The participant ended the session from their screen. The session is now closing.]',
    );
    expect(sidebandMocks.disconnect).toHaveBeenCalledWith(SESSION_ID);
    // The note, where there is one, goes in before the close.
    expect(sidebandMocks.injectClosingNote.mock.invocationCallOrder[0]).toBeLessThan(
      sidebandMocks.disconnect.mock.invocationCallOrder[0],
    );
  });

  it('still closes the session when the note could not be handled', async () => {
    sidebandMocks.injectClosingNote.mockRejectedValue(new Error('socket gone'));
    await request(makeApp()).post(`/api/sessions/${SESSION_ID}/end`).expect(200);
    expect(updateSessionStatusMock).toHaveBeenCalledWith(SESSION_ID, 'ended', 'user');
  });

  it('an already ended session is answered without touching the voice session', async () => {
    getSessionMock.mockResolvedValue({ session_id: SESSION_ID, status: 'ended', user_id: null });
    const res = await request(makeApp()).post(`/api/sessions/${SESSION_ID}/end`).expect(200);
    expect(res.body.alreadyEnded).toBe(true);
    expect(sidebandMocks.injectClosingNote).not.toHaveBeenCalled();
    expect(sidebandMocks.disconnect).not.toHaveBeenCalled();
  });
});
