// /api/chat/start sends the pre-session check-in's free text through the
// crisis pipeline. Before this, the check-in only reached the model's prompt:
// "I don't really want to be alive" in the check-in followed by "hi" left no
// risk row, no flag and no steer (red-team OPEN-03, 5 of 5 runs, 2026-11-18).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  insertMessagesBatch: vi.fn(),
  updateSessionStatus: vi.fn(),
  getActiveSessionForUser: vi.fn(),
  getSessionAccessInfo: vi.fn(),
  getUserPreferredLanguage: vi.fn(),
  setUserPreferredLanguage: vi.fn(),
  recordConsent: vi.fn(),
  setSessionCheckin: vi.fn(),
  upsertSessionConfig: vi.fn(),
}));
const mocks = vi.hoisted(() => ({
  runCheckinCrisisScreen: vi.fn(),
  injectGuidance: vi.fn(),
  order: [] as string[],
}));

vi.mock('../../db/index.js', () => dbMocks);
vi.mock('../../utils/sessionHelpers.js', () => ({
  checkSessionLimits: vi.fn(async () => ({ allowed: true })),
  getSystemPrompt: vi.fn(async () => 'prompt'),
  getSystemConfig: vi.fn(async () => ({ features: {} })),
  resolveProactiveOffering: vi.fn(async () => true),
  resolvePsychoeducationCue: vi.fn(async () => null),
  resolveLeadConversation: vi.fn(async () => false),
}));
vi.mock('../../utils/promptContext.js', () => ({
  // The real sanitizer's contract: text fields kept, empty input is null.
  sanitizeCheckin: (raw: unknown) => {
    const input = (raw ?? {}) as { mood?: number; topic?: string; goal?: string };
    const out: { mood?: number; topic?: string; goal?: string } = {};
    if (typeof input.mood === 'number') out.mood = input.mood;
    if (typeof input.topic === 'string' && input.topic.trim()) out.topic = input.topic.trim();
    if (typeof input.goal === 'string' && input.goal.trim()) out.goal = input.goal.trim();
    return Object.keys(out).length > 0 ? out : null;
  },
  buildCheckinBlock: () => '',
  buildMemoryBlock: async () => '',
  buildParticipantContextBlock: async () => '',
  buildToolGuidanceBlock: () => '',
  buildLeadConversationBlock: () => '',
}));
vi.mock('../../services/toolRegistry.service.js', () => ({ toolRegistry: { getEnabledToolDefinitions: vi.fn() } }));
vi.mock('../../middleware/consent.js', () => ({
  requireConsent: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../middleware/studyStatus.js', () => ({
  requireActiveStudyStatus: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../utils/adminBroadcast.js', () => ({
  broadcastAdminEvent: vi.fn().mockResolvedValue(undefined),
  broadcastAdminEventForSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/sessionName.service.js', () => ({ generateSessionNameAsync: vi.fn() }));
vi.mock('../../services/chatTherapy.service.js', () => ({
  initializeChatSession: vi.fn(),
  seedAssistantOpening: vi.fn(),
  sendMessage: vi.fn(),
  injectGuidance: mocks.injectGuidance,
  endChatSession: vi.fn(),
  getConversationHistory: vi.fn().mockReturnValue([]),
  isChatSessionUnavailableError: () => false,
}));
vi.mock('../../services/minorSafeguard.service.js', () => ({
  detectMinorDisclosurePatterns: () => ({ matched: false }),
}));
vi.mock('../../services/crisisDetection.service.js', () => ({
  detectCrisisKeywords: () => ({ keywordScore: 0 }),
  needsContextAssessment: async () => false,
}));
vi.mock('../../services/crisisPipeline.service.js', () => ({
  runCrisisPipeline: vi.fn().mockResolvedValue({ steeringGuidance: null }),
  runCheckinCrisisScreen: mocks.runCheckinCrisisScreen,
}));
vi.mock('../../utils/harness.js', () => ({ isNonStudyUser: () => false }));

import chatRoutes from './chat.routes.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { consentAccepted: true, consentVersion: 'v-test' } as unknown as typeof req.session;
    Object.defineProperty(req, 'sessionID', { value: 'AnonSid_checkin', configurable: true });
    next();
  });
  app.use(chatRoutes());
  return app;
}

const NONE = { riskScore: 0, severity: 'none', factors: [], flagged: false, steeringGuidance: null };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  dbMocks.getActiveSessionForUser.mockResolvedValue(null);
  dbMocks.createSession.mockResolvedValue({ session_id: 'chat_1_a' });
  dbMocks.recordConsent.mockResolvedValue(undefined);
  dbMocks.upsertSessionConfig.mockResolvedValue({});
  dbMocks.insertMessagesBatch.mockResolvedValue([{ message_id: 1 }]);
  dbMocks.setSessionCheckin.mockImplementation(async () => {
    mocks.order.push('stored');
  });
  mocks.runCheckinCrisisScreen.mockImplementation(async () => {
    mocks.order.push('screened');
    return NONE;
  });
  (globalThis as { io?: unknown }).io = { to: () => ({ emit: () => {} }) };
});

describe('POST /api/chat/start with a check-in', () => {
  it('sends the check-in through the crisis pipeline on the chat channel, after it is stored', async () => {
    const res = await request(makeApp())
      .post('/api/chat/start')
      .send({ checkin: { mood: 1, topic: "I don't really want to be alive" } });

    expect(res.status).toBe(200);
    expect(mocks.runCheckinCrisisScreen).toHaveBeenCalledTimes(1);
    expect(mocks.runCheckinCrisisScreen).toHaveBeenCalledWith(
      res.body.sessionId,
      expect.objectContaining({ topic: "I don't really want to be alive" }),
      'chat',
    );
    expect(mocks.order).toEqual(['stored', 'screened']);
  });

  it('injects the steer the check-in earned, so it is in place before the first reply', async () => {
    mocks.runCheckinCrisisScreen.mockResolvedValue({
      riskScore: 55,
      severity: 'medium',
      factors: ['passive ideation'],
      flagged: true,
      steeringGuidance: 'CHECKIN_STEER',
    });

    const res = await request(makeApp())
      .post('/api/chat/start')
      .send({ checkin: { topic: "I don't really want to be alive" } });

    expect(res.status).toBe(200);
    expect(mocks.injectGuidance).toHaveBeenCalledWith(res.body.sessionId, 'CHECKIN_STEER');
  });

  it('no steer for an ordinary check-in', async () => {
    const res = await request(makeApp())
      .post('/api/chat/start')
      .send({ checkin: { topic: 'midterms' } });
    expect(res.status).toBe(200);
    expect(mocks.runCheckinCrisisScreen).toHaveBeenCalledTimes(1);
    expect(mocks.injectGuidance).not.toHaveBeenCalledWith(res.body.sessionId, 'CHECKIN_STEER');
  });

  it('no check-in: the pipeline is not called', async () => {
    const res = await request(makeApp()).post('/api/chat/start').send({});
    expect(res.status).toBe(200);
    expect(mocks.runCheckinCrisisScreen).not.toHaveBeenCalled();
  });

  it('a failing screen never fails the session start', async () => {
    mocks.runCheckinCrisisScreen.mockRejectedValue(new Error('pipeline down'));
    const res = await request(makeApp())
      .post('/api/chat/start')
      .send({ checkin: { topic: 'anything' } });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
