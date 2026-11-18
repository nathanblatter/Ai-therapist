// The plain admin End Session action (POST /admin/api/sessions/:id/end) is the
// supported way to end a crisis RECOVERY session, which has no tools and so
// refuses the sideband trigger-tool control (ai-therapist-282). This pins that
// the end path never goes through the delegated backend: it marks the session
// ended and tears the sideband down, and nothing else on the manager.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { getSessionMock, updateSessionStatusMock, sidebandMocks } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  updateSessionStatusMock: vi.fn(),
  sidebandMocks: {
    disconnect: vi.fn(),
    triggerTool: vi.fn(),
    updateSession: vi.fn(),
    updateDelegation: vi.fn(),
    createResponse: vi.fn(),
    getDelegationMode: vi.fn(),
  },
}));

vi.mock('../../db/index.js', () => ({
  getSession: getSessionMock,
  updateSessionStatus: updateSessionStatusMock,
  getActiveSessions: vi.fn(),
  listSessions: vi.fn(),
  countSessions: vi.fn(),
  getSessionWithUser: vi.fn(),
  getAdminSessionMessages: vi.fn(),
  getRedactionStatusBreakdown: vi.fn(),
  deleteSession: vi.fn(),
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  logDataAccess: vi.fn(),
  projectSafeMetadata: vi.fn(),
}));
vi.mock('../../db/recording.queries.js', () => ({ getSessionRecording: vi.fn() }));
vi.mock('../../db/acousticFeatures.queries.js', () => ({ getParticipantRecordingForSession: vi.fn() }));
vi.mock('../../config/objectStorage.js', () => ({ headObject: vi.fn(), getObjectStream: vi.fn() }));
vi.mock('../../middleware/auth.js', () => ({
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFullContent: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../middleware/caseload.js', () => ({
  requireSessionClientAccess: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireMessageClientAccess: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  careTeamScopeId: () => null,
}));
vi.mock('../../middleware/org.js', () => ({ orgIdFor: async () => 1 }));
vi.mock('../../utils/adminBroadcast.js', () => ({ broadcastAdminEventForSession: vi.fn() }));
vi.mock('../../services/sessionName.service.js', () => ({ generateSessionNameAsync: vi.fn() }));
vi.mock('../../services/sidebandManager.service.js', () => ({ sidebandManager: sidebandMocks }));
vi.mock('../../services/chatTherapy.service.js', () => ({ endChatSession: vi.fn() }));
vi.mock('../../services/sessionRedaction.service.js', () => ({ redactSession: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/recorder.service.js', () => ({ finalize: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/sessionInsights.service.js', () => ({
  generateSessionInsightsAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/sessionEval.service.js', () => ({
  maybeAutoEvalSession: vi.fn().mockResolvedValue(undefined),
}));

import adminSessionsRoutes from './sessions.routes.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: 7, userRole: 'researcher', username: 'tester' } as unknown as typeof req.session;
    next();
  });
  app.use(adminSessionsRoutes());
  return app;
}

const SESSION_ID = 'sess-recovery-1';

beforeEach(() => {
  vi.clearAllMocks();
  (global as unknown as { io: unknown }).io = { to: () => ({ emit: vi.fn() }) };
  getSessionMock.mockResolvedValue({ session_id: SESSION_ID, status: 'active' });
  updateSessionStatusMock.mockResolvedValue({ session_id: SESSION_ID, status: 'ended' });
  sidebandMocks.disconnect.mockResolvedValue(undefined);
  // A client-delegated recovery session: any backend-config call would be
  // refused by the manager, so the end path must not make one.
  sidebandMocks.getDelegationMode.mockReturnValue('client');
  const refuse = () => Promise.reject(Object.assign(new Error('refused'), { code: 'live_delegation_unsupported' }));
  sidebandMocks.triggerTool.mockImplementation(refuse);
  sidebandMocks.updateSession.mockImplementation(refuse);
  sidebandMocks.updateDelegation.mockImplementation(refuse);
});

describe('POST /admin/api/sessions/:sessionId/end on a recovery session', () => {
  it('ends the session and tears the sideband down without any delegation call', async () => {
    const res = await request(makeApp()).post(`/admin/api/sessions/${SESSION_ID}/end`).expect(200);

    expect(res.body.message).toMatch(/ended successfully/i);
    expect(updateSessionStatusMock).toHaveBeenCalledWith(SESSION_ID, 'ended', 'tester');
    expect(sidebandMocks.disconnect).toHaveBeenCalledWith(SESSION_ID);
    expect(sidebandMocks.triggerTool).not.toHaveBeenCalled();
    expect(sidebandMocks.updateSession).not.toHaveBeenCalled();
    expect(sidebandMocks.updateDelegation).not.toHaveBeenCalled();
    expect(sidebandMocks.createResponse).not.toHaveBeenCalled();
  });
});
