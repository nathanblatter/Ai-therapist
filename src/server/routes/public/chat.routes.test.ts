// /api/chat/start must work for ANONYMOUS participants: therapy_sessions.user_id
// is INTEGER, so the session-limit / idempotency queries must be keyed by the
// numeric user id (null when anonymous) — passing the express-session id string
// used to make pg throw a cast error and 500 every anonymous chat start.
// Also covers the per-IP limiter backstop on /api/chat/message.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  insertMessagesBatch: vi.fn(),
  updateSessionStatus: vi.fn(),
  getActiveSessionForUser: vi.fn(),
  getSessionAccessInfo: vi.fn(),
  isDemoAccountSession: vi.fn(),
  isSandboxAccountSession: vi.fn(),
  getRecentSessionMessages: vi.fn(),
  getUserPreferredLanguage: vi.fn(),
  setUserPreferredLanguage: vi.fn(),
  recordConsent: vi.fn(),
  setSessionCheckin: vi.fn(),
}));
const helperMocks = vi.hoisted(() => ({
  checkSessionLimits: vi.fn(),
  getSystemPrompt: vi.fn(),
  getSystemConfig: vi.fn(),
}));

vi.mock('../../db/index.js', () => dbMocks);
vi.mock('../../utils/sessionHelpers.js', () => helperMocks);
vi.mock('../../utils/promptContext.js', () => ({
  sanitizeCheckin: () => null,
  buildCheckinBlock: () => '',
  buildMemoryBlock: async () => '',
}));
vi.mock('../../middleware/consent.js', () => ({
  requireConsent: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../utils/adminBroadcast.js', () => ({
  broadcastAdminEvent: vi.fn().mockResolvedValue(undefined),
  broadcastAdminEventForSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/sessionName.service.js', () => ({
  generateSessionNameAsync: vi.fn(),
}));
vi.mock('../../services/chatTherapy.service.js', () => ({
  initializeChatSession: vi.fn(),
  sendMessage: vi.fn(),
  injectGuidance: vi.fn(),
  endChatSession: vi.fn(),
  getConversationHistory: vi.fn().mockReturnValue([]),
}));
vi.mock('../../utils/harness.js', () => ({
  isNonStudyUser: () => false,
}));

import chatRoutes from './chat.routes.js';

function makeApp(sessionFields: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = {
      consentAccepted: true,
      consentVersion: 'v-test',
      ...sessionFields,
    } as unknown as typeof req.session;
    Object.defineProperty(req, 'sessionID', { value: 'AnonSid_abc-123', configurable: true });
    next();
  });
  app.use(chatRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  helperMocks.checkSessionLimits.mockResolvedValue({ allowed: true });
  helperMocks.getSystemPrompt.mockResolvedValue('prompt');
  helperMocks.getSystemConfig.mockResolvedValue({ features: {} });
  dbMocks.getActiveSessionForUser.mockResolvedValue(null);
  dbMocks.createSession.mockResolvedValue({ session_id: 'chat_1_a' });
  dbMocks.recordConsent.mockResolvedValue(undefined);
  dbMocks.getUserPreferredLanguage.mockResolvedValue('en');
  dbMocks.setUserPreferredLanguage.mockResolvedValue(undefined);
  dbMocks.setSessionCheckin.mockResolvedValue(undefined);
  (globalThis as { io?: unknown }).io = { to: () => ({ emit: () => {} }) };
});

describe('POST /api/chat/start', () => {
  it('starts an anonymous session keyed by a NULL user id, never the session-id string', async () => {
    const res = await request(makeApp()).post('/api/chat/start').send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // The integer user_id column cannot hold an express-session id string.
    expect(helperMocks.checkSessionLimits).toHaveBeenCalledWith(null, 'participant');
    expect(dbMocks.getActiveSessionForUser).not.toHaveBeenCalled();
    expect(dbMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: null })
    );
  });

  it('uses the numeric user id for logged-in participants', async () => {
    const res = await request(makeApp({ userId: 12, userRole: 'participant', username: 'p12' }))
      .post('/api/chat/start')
      .send({ language: 'en' });
    expect(res.status).toBe(200);
    expect(helperMocks.checkSessionLimits).toHaveBeenCalledWith(12, 'participant');
    expect(dbMocks.getActiveSessionForUser).toHaveBeenCalledWith(12);
  });

  it('returns 429 when session limits deny the start', async () => {
    helperMocks.checkSessionLimits.mockResolvedValue({
      allowed: false, reason: 'daily_limit', message: 'no', limit: 3, current: 3,
    });
    const res = await request(makeApp({ userId: 12, userRole: 'participant' }))
      .post('/api/chat/start')
      .send({});
    expect(res.status).toBe(429);
    expect(dbMocks.createSession).not.toHaveBeenCalled();
  });
});

describe('POST /api/chat/message rate limiting', () => {
  it('backstops the endpoint at 30 requests per IP per minute', async () => {
    const app = makeApp();
    let lastStatus = 0;
    for (let i = 0; i < 31; i++) {
      // Missing body -> 400 before any db/model work; still counts for the limiter.
      const res = await request(app).post('/api/chat/message').send({});
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
