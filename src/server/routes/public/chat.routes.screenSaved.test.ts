// ai-therapist-369 item 4: the participant's words are screened whenever they
// were accepted, whatever fails afterwards.
//   (a) /api/chat/message: the minor-age gate's account read used to sit
//       outside any try. When an age pattern matched and that read failed,
//       the turn was saved and the request answered 503, and the turn never
//       reached the crisis pipeline. Any other failure between the save and
//       the screen is covered by the route's catch.
//   (b) /api/chat/start with a check-in: a database failure anywhere before
//       the check-in screen answered 503 and the check-in was never screened.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  insertMessagesBatch: vi.fn(),
  getSessionAccessInfo: vi.fn(),
  isDemoAccountSession: vi.fn(),
  isSandboxAccountSession: vi.fn(),
  getRecentSessionMessages: vi.fn(),
  getActiveSessionForUser: vi.fn(),
  createSession: vi.fn(),
  setSessionCheckin: vi.fn(),
  upsertSessionConfig: vi.fn(),
  recordConsent: vi.fn(),
  checkSessionLimits: vi.fn(),
  sendMessage: vi.fn(),
  matched: vi.fn(),
  confirmMinorDisclosure: vi.fn(),
  consumeNarrowFirstTurn: vi.fn(),
  runCrisisPipeline: vi.fn(),
  runCheckinCrisisScreen: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  insertMessagesBatch: mocks.insertMessagesBatch,
  getSessionAccessInfo: mocks.getSessionAccessInfo,
  isDemoAccountSession: mocks.isDemoAccountSession,
  isSandboxAccountSession: mocks.isSandboxAccountSession,
  getRecentSessionMessages: mocks.getRecentSessionMessages,
  getActiveSessionForUser: mocks.getActiveSessionForUser,
  createSession: mocks.createSession,
  setSessionCheckin: mocks.setSessionCheckin,
  upsertSessionConfig: mocks.upsertSessionConfig,
  recordConsent: mocks.recordConsent,
  getUserPreferredLanguage: vi.fn(async () => 'en'),
  setUserPreferredLanguage: vi.fn(async () => undefined),
  updateSessionStatus: vi.fn(),
}));
vi.mock('../../utils/sessionHelpers.js', () => ({
  checkSessionLimits: mocks.checkSessionLimits,
  getSystemPrompt: vi.fn(async () => 'prompt'),
  getSystemConfig: vi.fn(async () => ({ features: {} })),
  resolveProactiveOffering: vi.fn(async () => true),
  resolvePsychoeducationCue: vi.fn(async () => null),
  resolveLeadConversation: vi.fn(async () => false),
}));
vi.mock('../../utils/promptContext.js', () => ({
  sanitizeCheckin: (raw: unknown) => {
    const input = (raw ?? {}) as { topic?: string; goal?: string };
    const out: { topic?: string; goal?: string } = {};
    if (typeof input.topic === 'string' && input.topic.trim()) out.topic = input.topic.trim();
    if (typeof input.goal === 'string' && input.goal.trim()) out.goal = input.goal.trim();
    return Object.keys(out).length > 0 ? out : null;
  },
  buildCheckinBlock: () => '',
  buildParticipantContextBlock: async () => '',
  buildToolGuidanceBlock: () => '',
  buildLeadConversationBlock: () => '',
}));
vi.mock('../../services/toolRegistry.service.js', () => ({ toolRegistry: {} }));
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
  sendMessage: mocks.sendMessage,
  injectGuidance: vi.fn(),
  isChatSessionUnavailableError: () => false,
}));
vi.mock('../../services/minorSafeguard.service.js', () => ({
  detectMinorDisclosurePatterns: () => ({ matched: mocks.matched() }),
  confirmMinorDisclosure: mocks.confirmMinorDisclosure,
  handleConfirmedMinor: vi.fn(),
  MINOR_ELIGIBILITY_MESSAGE: 'GOODBYE',
}));
vi.mock('../../services/crisisDetection.service.js', () => ({
  detectCrisisKeywords: () => ({ keywordScore: 0 }),
  needsContextAssessment: async () => false,
}));
vi.mock('../../services/textHandoff.service.js', () => ({
  consumeNarrowFirstTurn: mocks.consumeNarrowFirstTurn,
  isHandoffSession: () => false,
  resolveVoiceReturn: async () => false,
}));
vi.mock('../../services/crisisPipeline.service.js', () => ({
  runCrisisPipeline: mocks.runCrisisPipeline,
  runCheckinCrisisScreen: mocks.runCheckinCrisisScreen,
}));
vi.mock('../../utils/harness.js', () => ({ isNonStudyUser: () => false }));

import chatRoutes from './chat.routes.js';
const { knownDemoAccountSession, _forgetSessionAccountsForTests } = await import('../../utils/sessionAccounts.js');

const SESSION = 'chat_saved';
const acquireTimeout = () => new Error('timeout exceeded when trying to connect');

function makeApp(sessionFields: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = {
      consentAccepted: true,
      consentVersion: 'v-test',
      ownedSessions: [SESSION],
      ...sessionFields,
    } as unknown as typeof req.session;
    Object.defineProperty(req, 'sessionID', { value: 'AnonSid_saved', configurable: true });
    next();
  });
  app.use(chatRoutes());
  return app;
}

/** Yield to I/O without touching timers. */
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !condition(); i++) await tick();
  expect(condition()).toBe(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  _forgetSessionAccountsForTests();
  mocks.getSessionAccessInfo.mockResolvedValue({ status: 'active', user_id: null, session_type: 'chat' });
  mocks.insertMessagesBatch.mockResolvedValue([{ message_id: 42 }]);
  mocks.isDemoAccountSession.mockResolvedValue(false);
  mocks.isSandboxAccountSession.mockResolvedValue(false);
  mocks.getRecentSessionMessages.mockResolvedValue([]);
  mocks.getActiveSessionForUser.mockResolvedValue(null);
  mocks.createSession.mockResolvedValue({ session_id: 'x' });
  mocks.setSessionCheckin.mockResolvedValue(undefined);
  mocks.upsertSessionConfig.mockResolvedValue({});
  mocks.recordConsent.mockResolvedValue(undefined);
  mocks.checkSessionLimits.mockResolvedValue({ allowed: true });
  mocks.sendMessage.mockResolvedValue({ text: 'reply', toolEvents: [] });
  mocks.matched.mockReturnValue(false);
  mocks.confirmMinorDisclosure.mockResolvedValue({ isMinor: false, confidence: 'high', statedAge: null });
  mocks.consumeNarrowFirstTurn.mockReturnValue(false);
  mocks.runCrisisPipeline.mockResolvedValue({ steeringGuidance: null });
  mocks.runCheckinCrisisScreen.mockResolvedValue({ steeringGuidance: null });
  (globalThis as { io?: unknown }).io = { to: () => ({ emit: () => {} }) };
});

describe('/api/chat/message: a saved turn is always screened', () => {
  it('(a) an age pattern whose account read fails: the turn is still screened (and the reply goes on)', async () => {
    mocks.matched.mockReturnValue(true);
    mocks.isDemoAccountSession.mockRejectedValue(acquireTimeout());

    const res = await request(makeApp()).post('/api/chat/message').send({ sessionId: SESSION, message: "I'm 15" });

    await until(() => mocks.runCrisisPipeline.mock.calls.length > 0);
    expect(mocks.runCrisisPipeline).toHaveBeenCalledWith(
      { sessionId: SESSION, messageId: 42, content: "I'm 15" },
      'chat',
    );
    // The failed read is treated as the request's own account (not
    // synthetic): the age gate runs, then the turn goes on as usual.
    expect(mocks.confirmMinorDisclosure).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it('a failure between the save and the screen: answered 503, and the saved turn is screened anyway', async () => {
    mocks.consumeNarrowFirstTurn.mockImplementation(() => {
      throw acquireTimeout();
    });

    const res = await request(makeApp())
      .post('/api/chat/message')
      .send({ sessionId: SESSION, message: 'I want to die' });

    expect(res.status).toBe(503);
    await until(() => mocks.runCrisisPipeline.mock.calls.length > 0);
    expect(mocks.runCrisisPipeline).toHaveBeenCalledTimes(1);
    expect(mocks.runCrisisPipeline).toHaveBeenCalledWith(
      { sessionId: SESSION, messageId: 42, content: 'I want to die' },
      'chat',
    );
  });

  it('a turn that was screened before the failure is not screened twice', async () => {
    mocks.sendMessage.mockRejectedValue(acquireTimeout());
    const res = await request(makeApp()).post('/api/chat/message').send({ sessionId: SESSION, message: 'hello' });
    expect(res.status).toBe(503);
    // The clean-turn screen is scheduled for when the response finishes.
    await until(() => mocks.runCrisisPipeline.mock.calls.length > 0);
    for (let i = 0; i < 50; i++) await tick();
    expect(mocks.runCrisisPipeline).toHaveBeenCalledTimes(1);
  });
});

describe('/api/chat/start: a check-in is screened even when the start fails', () => {
  const CHECKIN = { topic: "I don't really want to be alive" };

  it.each([
    ['the session-limit check', () => mocks.checkSessionLimits.mockRejectedValue(acquireTimeout())],
    ['the active-session lookup', () => mocks.getActiveSessionForUser.mockRejectedValue(acquireTimeout())],
    ['the session row insert', () => mocks.createSession.mockRejectedValue(acquireTimeout())],
    ['the configuration write', () => mocks.upsertSessionConfig.mockRejectedValue(acquireTimeout())],
  ])('(b) %s times out: 503, and the check-in is screened in the background', async (_label, fail) => {
    fail();
    const res = await request(makeApp({ userId: 7, userRole: 'participant' }))
      .post('/api/chat/start')
      .send({ checkin: CHECKIN });

    expect(res.status).toBe(503);
    await until(() => mocks.runCheckinCrisisScreen.mock.calls.length > 0);
    expect(mocks.runCheckinCrisisScreen).toHaveBeenCalledTimes(1);
    const [screened, checkin, channel] = mocks.runCheckinCrisisScreen.mock.calls[0];
    expect(checkin).toEqual(CHECKIN);
    expect(channel).toBe('chat');
    expect(String(screened)).toMatch(/^chat_/);
    // Known not to be a demo account: the pipeline needs no read to know it.
    expect(knownDemoAccountSession(String(screened))).toBe(false);
  });

  it("a demo account's failed start screens nothing", async () => {
    mocks.checkSessionLimits.mockRejectedValue(acquireTimeout());
    const res = await request(makeApp({ userId: 9, userRole: 'demo' }))
      .post('/api/chat/start')
      .send({ checkin: CHECKIN });
    expect(res.status).toBe(503);
    for (let i = 0; i < 50; i++) await tick();
    expect(mocks.runCheckinCrisisScreen).not.toHaveBeenCalled();
  });

  it('a start whose check-in screen had already begun does not screen it twice', async () => {
    mocks.runCheckinCrisisScreen.mockRejectedValue(acquireTimeout());
    mocks.recordConsent.mockRejectedValue(acquireTimeout());
    // The screen ran (and failed on its own); a later step then fails.
    mocks.createSession.mockResolvedValue({ session_id: 'x' });
    const res = await request(makeApp({ userId: 7 }))
      .post('/api/chat/start')
      .send({ checkin: CHECKIN });
    expect([200, 503]).toContain(res.status);
    for (let i = 0; i < 50; i++) await tick();
    expect(mocks.runCheckinCrisisScreen).toHaveBeenCalledTimes(1);
  });

  it('a successful start remembers the account for the crisis pipeline (no demo read per turn)', async () => {
    const res = await request(makeApp({ userId: 9, userRole: 'demo' }))
      .post('/api/chat/start')
      .send({});
    expect(res.status).toBe(200);
    expect(knownDemoAccountSession(res.body.sessionId)).toBe(true);
  });
});
