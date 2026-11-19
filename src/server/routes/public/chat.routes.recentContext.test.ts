// ai-therapist-373: what the chat routes keep in process memory for the
// crisis pipeline (utils/recentTurns), the participant a failed start's
// check-in page is keyed and linked by (utils/sessionAccounts), and the
// database-unavailable message (utils/databaseRetryMessage).
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
  cachedConfig: vi.fn(),
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
  peekCachedSystemConfig: () => mocks.cachedConfig(),
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
const { knownSessionParticipant, _forgetSessionAccountsForTests } = await import('../../utils/sessionAccounts.js');
const { recentTurns, rememberedCheckin, forgetParticipantTurns, _resetRecentTurnsForTests } = await import(
  '../../utils/recentTurns.js'
);
const { DATABASE_RETRY_MESSAGE } = await import('../../utils/dbErrors.js');

const SESSION = 'chat_recent';
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
    Object.defineProperty(req, 'sessionID', { value: 'AnonSid_recent', configurable: true });
    next();
  });
  app.use(chatRoutes());
  return app;
}

/** Yield to I/O without touching timers. */
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(condition: () => boolean): Promise<void> {
  // Bounded by elapsed time, not a tick count (see toolRegistry.escalateOrder.test.ts).
  const deadline = performance.now() + 15_000;
  while (!condition() && performance.now() < deadline) await tick();
  expect(condition()).toBe(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  _forgetSessionAccountsForTests();
  _resetRecentTurnsForTests();
  mocks.cachedConfig.mockReturnValue(null);
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

describe('/api/chat/message keeps the turns in memory', () => {
  it('the participant turn (with its stored id) and the reply, in order', async () => {
    mocks.sendMessage.mockResolvedValue({ text: 'Are you thinking about suicide?', toolEvents: [] });
    const res = await request(makeApp()).post('/api/chat/message').send({ sessionId: SESSION, message: 'hello' });
    expect(res.status).toBe(200);
    const held = recentTurns(SESSION);
    expect(held?.turns.map((t) => [t.role, t.content, t.messageId])).toEqual([
      ['user', 'hello', 42],
      ['assistant', 'Are you thinking about suicide?', null],
    ]);
  });

  it('a turn the database could not store is kept too (no id), and the pipeline is still run', async () => {
    mocks.insertMessagesBatch.mockRejectedValue(acquireTimeout());
    const res = await request(makeApp()).post('/api/chat/message').send({ sessionId: SESSION, message: 'yes' });
    expect(res.status).toBe(503);
    await until(() => mocks.runCrisisPipeline.mock.calls.length > 0);
    expect(recentTurns(SESSION)?.turns.map((t) => [t.role, t.content, t.messageId])).toEqual([['user', 'yes', null]]);
  });

  it('a request for a session the requester does not own keeps nothing', async () => {
    mocks.getSessionAccessInfo.mockResolvedValue({ status: 'active', user_id: 99, session_type: 'chat' });
    const res = await request(makeApp({ ownedSessions: [] }))
      .post('/api/chat/message')
      .send({ sessionId: SESSION, message: 'hello' });
    expect(res.status).toBe(403);
    expect(recentTurns(SESSION)).toBeNull();
  });
});

describe('/api/chat/start remembers the start, the check-in and the participant', () => {
  const CHECKIN = { topic: "I don't really want to be alive", goal: 'talk' };

  it('a successful start: the check-in text and a complete record; the participant is known and stored', async () => {
    const res = await request(makeApp({ userId: 7, userRole: 'participant' }))
      .post('/api/chat/start')
      .send({ checkin: CHECKIN });
    expect(res.status).toBe(200);
    const sessionId = String(res.body.sessionId);
    expect(rememberedCheckin(sessionId)).toBe("I don't really want to be alive\ntalk");
    expect(recentTurns(sessionId)?.complete).toBe(true);
    expect(knownSessionParticipant(sessionId)).toEqual({ userId: 7, stored: true });
    // Kept with its participant: a withdrawal finds it without a read (ai-therapist-374).
    forgetParticipantTurns(7);
    expect(recentTurns(sessionId)).toBeNull();
  });

  it('the session row insert fails: the screened check-in is filed under the participant, as not stored', async () => {
    mocks.createSession.mockRejectedValue(acquireTimeout());
    const res = await request(makeApp({ userId: 7, userRole: 'participant' }))
      .post('/api/chat/start')
      .send({ checkin: CHECKIN });
    expect(res.status).toBe(503);
    await until(() => mocks.runCheckinCrisisScreen.mock.calls.length > 0);
    const screened = String(mocks.runCheckinCrisisScreen.mock.calls[0][0]);
    expect(knownSessionParticipant(screened)).toEqual({ userId: 7, stored: false });
  });

  it('a failure before the session id is minted: a stand-in id, filed under the participant, not stored', async () => {
    mocks.checkSessionLimits.mockRejectedValue(acquireTimeout());
    const res = await request(makeApp({ userId: 7, userRole: 'participant' }))
      .post('/api/chat/start')
      .send({ checkin: CHECKIN });
    expect(res.status).toBe(503);
    await until(() => mocks.runCheckinCrisisScreen.mock.calls.length > 0);
    const screened = String(mocks.runCheckinCrisisScreen.mock.calls[0][0]);
    expect(knownSessionParticipant(screened)).toEqual({ userId: 7, stored: false });
  });

  it('a failure after the row was written: the session exists, and the page links to it', async () => {
    mocks.upsertSessionConfig.mockRejectedValue(acquireTimeout());
    const res = await request(makeApp({ userId: 7, userRole: 'participant' }))
      .post('/api/chat/start')
      .send({ checkin: CHECKIN });
    expect(res.status).toBe(503);
    await until(() => mocks.runCheckinCrisisScreen.mock.calls.length > 0);
    const screened = String(mocks.runCheckinCrisisScreen.mock.calls[0][0]);
    expect(knownSessionParticipant(screened)).toEqual({ userId: 7, stored: true });
  });

  it('an anonymous browser has no participant to key by', async () => {
    mocks.createSession.mockRejectedValue(acquireTimeout());
    const res = await request(makeApp()).post('/api/chat/start').send({ checkin: CHECKIN });
    expect(res.status).toBe(503);
    await until(() => mocks.runCheckinCrisisScreen.mock.calls.length > 0);
    const screened = String(mocks.runCheckinCrisisScreen.mock.calls[0][0]);
    expect(knownSessionParticipant(screened)).toBeNull();
  });
});

describe('the database-unavailable message', () => {
  it('no crisis contact held in process: the fixed text', async () => {
    mocks.checkSessionLimits.mockRejectedValue(acquireTimeout());
    const res = await request(makeApp({ userId: 7 }))
      .post('/api/chat/start')
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.message).toBe(DATABASE_RETRY_MESSAGE);
  });

  it('the configured crisis contact, when the process already holds it, on both routes', async () => {
    mocks.cachedConfig.mockReturnValue({
      crisis_contact: { hotline: 'Campus Crisis Line', phone: '801-555-0100', text: 'Text HELP to 555', enabled: true },
    });
    const expected =
      'We could not reach our system just now. Please wait a moment and try again. ' +
      'If you are in crisis, contact the Campus Crisis Line at 801-555-0100, or text HELP to 555, or call 911.';
    mocks.checkSessionLimits.mockRejectedValue(acquireTimeout());
    const start = await request(makeApp({ userId: 7 }))
      .post('/api/chat/start')
      .send({});
    expect(start.status).toBe(503);
    expect(start.body.message).toBe(expected);

    mocks.insertMessagesBatch.mockRejectedValue(acquireTimeout());
    const message = await request(makeApp()).post('/api/chat/message').send({ sessionId: SESSION, message: 'hi' });
    expect(message.status).toBe(503);
    expect(message.body.message).toBe(expected);
  });
});
