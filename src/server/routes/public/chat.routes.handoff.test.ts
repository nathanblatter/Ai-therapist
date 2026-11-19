// The text hand-off at the route (ai-therapist-356): what POST /api/chat/start
// returns and persists for a continuation of a vendor-ended voice session, and
// how the first participant turn after a crisis hand-off is answered.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { HANDOFF_CRISIS_FIRST_MESSAGE, HANDOFF_NEUTRAL_FIRST_MESSAGE } from '../../../shared/textHandoff.js';

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
  upsertSessionConfig: vi.fn(),
}));
const chatMocks = vi.hoisted(() => ({
  initializeChatSession: vi.fn(),
  seedAssistantOpening: vi.fn(),
  injectGuidance: vi.fn(),
  sendMessage: vi.fn(),
}));
const helperMocks = vi.hoisted(() => ({
  checkSessionLimits: vi.fn(),
  getSystemPrompt: vi.fn(),
  getSystemConfig: vi.fn(),
  resolveProactiveOffering: vi.fn(),
  resolvePsychoeducationCue: vi.fn(),
  resolveLeadConversation: vi.fn(),
}));
const handoffMocks = vi.hoisted(() => ({
  prepareTextHandoff: vi.fn(),
  consumeNarrowFirstTurn: vi.fn(),
  isHandoffSession: vi.fn(),
  resolveVoiceReturn: vi.fn(),
  verifyVoiceReturn: vi.fn(),
  clearHandoffState: vi.fn(),
}));
const pipelineMocks = vi.hoisted(() => ({ runCrisisPipeline: vi.fn() }));
const detectionMocks = vi.hoisted(() => ({ detectCrisisKeywords: vi.fn(), needsContextAssessment: vi.fn() }));

vi.mock('../../db/index.js', () => dbMocks);
vi.mock('../../utils/sessionHelpers.js', () => helperMocks);
vi.mock('../../utils/promptContext.js', () => ({
  sanitizeCheckin: () => null,
  buildCheckinBlock: () => '',
  buildParticipantContextBlock: async () => '',
  buildToolGuidanceBlock: () => '',
  buildLeadConversationBlock: () => '',
}));
vi.mock('../../services/toolRegistry.service.js', () => ({
  toolRegistry: { getEnabledToolDefinitions: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../../middleware/consent.js', () => ({
  requireConsent: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../middleware/quietHours.js', () => ({
  requireOutsideQuietHours: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
const quietMocks = vi.hoisted(() => ({ getQuietHoursStatus: vi.fn(() => ({ active: false })) }));
vi.mock('../../utils/quietHours.js', () => quietMocks);
vi.mock('../../middleware/studyStatus.js', () => ({
  requireActiveStudyStatus: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../utils/adminBroadcast.js', () => ({
  broadcastAdminEvent: vi.fn().mockResolvedValue(undefined),
  broadcastAdminEventForSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/sessionName.service.js', () => ({ generateSessionNameAsync: vi.fn() }));
vi.mock('../../services/chatTherapy.service.js', () => ({
  ...chatMocks,
  endChatSession: vi.fn(),
  getConversationHistory: vi.fn().mockReturnValue([]),
  isChatSessionUnavailableError: () => false,
}));
vi.mock('../../services/textHandoff.service.js', () => handoffMocks);
vi.mock('../../services/minorSafeguard.service.js', () => ({
  detectMinorDisclosurePatterns: () => ({ matched: false }),
}));
vi.mock('../../services/crisisDetection.service.js', () => detectionMocks);
vi.mock('../../services/crisisPipeline.service.js', () => pipelineMocks);
vi.mock('../../utils/harness.js', () => ({ isNonStudyUser: () => false }));
vi.mock('../../utils/chatModel.js', () => ({ resolveChatModel: async () => 'gpt-test' }));

import chatRoutes from './chat.routes.js';

function makeApp(sessionFields: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = {
      consentAccepted: true,
      consentVersion: 'v-test',
      userId: 7,
      userRole: 'participant',
      ...sessionFields,
    } as unknown as typeof req.session;
    Object.defineProperty(req, 'sessionID', { value: 'sid-1', configurable: true });
    next();
  });
  app.use(chatRoutes());
  return app;
}

const CRISIS_PREPARED = {
  payload: {
    kind: 'crisis',
    severity: 'high',
    reason: 'content',
    quickReplies: ['Yes', 'No', 'Not sure'],
    voiceReturnAllowed: false,
    spokenBridge:
      "I'm still here. I've moved us to writing, on your screen. You can also call or text 988 at any time.",
    seededFrom: ['live_A'],
  },
  firstMessage: HANDOFF_CRISIS_FIRST_MESSAGE,
  guidance: 'GUIDANCE WITH TRANSCRIPT',
};

beforeEach(() => {
  vi.clearAllMocks();
  helperMocks.checkSessionLimits.mockResolvedValue({ allowed: true });
  helperMocks.getSystemPrompt.mockResolvedValue('prompt');
  helperMocks.getSystemConfig.mockResolvedValue({
    features: { voice_enabled: true },
    crisis_contact: { phone: '988', text: 'HOME to 741741', enabled: true },
  });
  helperMocks.resolveProactiveOffering.mockResolvedValue(true);
  helperMocks.resolvePsychoeducationCue.mockResolvedValue(null);
  helperMocks.resolveLeadConversation.mockResolvedValue(false);
  dbMocks.getActiveSessionForUser.mockResolvedValue(null);
  dbMocks.createSession.mockResolvedValue({});
  dbMocks.recordConsent.mockResolvedValue(undefined);
  dbMocks.setUserPreferredLanguage.mockResolvedValue(undefined);
  dbMocks.upsertSessionConfig.mockResolvedValue({});
  dbMocks.insertMessagesBatch.mockResolvedValue([{ message_id: 41 }]);
  dbMocks.getSessionAccessInfo.mockResolvedValue({ status: 'active', user_id: 7, session_type: 'chat' });
  dbMocks.isDemoAccountSession.mockResolvedValue(false);
  dbMocks.isSandboxAccountSession.mockResolvedValue(false);
  handoffMocks.prepareTextHandoff.mockResolvedValue(CRISIS_PREPARED);
  handoffMocks.consumeNarrowFirstTurn.mockReturnValue(false);
  handoffMocks.isHandoffSession.mockReturnValue(false);
  handoffMocks.resolveVoiceReturn.mockResolvedValue(false);
  handoffMocks.verifyVoiceReturn.mockResolvedValue(false);
  detectionMocks.detectCrisisKeywords.mockReturnValue({ keywordScore: 0 });
  detectionMocks.needsContextAssessment.mockResolvedValue(false);
  pipelineMocks.runCrisisPipeline.mockResolvedValue({ steeringGuidance: null });
  chatMocks.sendMessage.mockResolvedValue({ text: 'model reply', toolEvents: [] });
  (globalThis as { io?: unknown }).io = { to: () => ({ emit: () => {} }) };
});

describe('POST /api/chat/start with continued_from (text hand-off)', () => {
  it('returns the server-authored first message and the hand-off, with no model call', async () => {
    const res = await request(makeApp()).post('/api/chat/start').send({ language: 'en', continued_from: 'live_A' });
    expect(res.status).toBe(200);
    expect(res.body.continuedFrom).toBe('live_A');
    expect(res.body.opening).toBe(HANDOFF_CRISIS_FIRST_MESSAGE);
    expect(res.body.handoff).toEqual(CRISIS_PREPARED.payload);
    expect(chatMocks.sendMessage).not.toHaveBeenCalled();
  });

  it('persists the first message like an opening line and puts it in the model history after the transcript', async () => {
    const res = await request(makeApp()).post('/api/chat/start').send({ continued_from: 'live_A' });
    const sessionId = res.body.sessionId as string;
    expect(dbMocks.insertMessagesBatch).toHaveBeenCalledWith([
      {
        session_id: sessionId,
        role: 'assistant',
        message_type: 'text',
        content: HANDOFF_CRISIS_FIRST_MESSAGE,
        content_redacted: HANDOFF_CRISIS_FIRST_MESSAGE,
        metadata: { opening_line: true, text_handoff: 'crisis' },
      },
    ]);
    expect(chatMocks.injectGuidance).toHaveBeenCalledWith(sessionId, 'GUIDANCE WITH TRANSCRIPT');
    expect(chatMocks.seedAssistantOpening).toHaveBeenCalledWith(sessionId, HANDOFF_CRISIS_FIRST_MESSAGE);
    // Transcript first, then the assistant's own first words in writing.
    expect(chatMocks.injectGuidance.mock.invocationCallOrder[0]).toBeLessThan(
      chatMocks.seedAssistantOpening.mock.invocationCallOrder[0],
    );
  });

  it('asks for the hand-off for the cut session, with the reason and an ownership check', async () => {
    await request(makeApp()).post('/api/chat/start').send({ continued_from: 'live_A', handoff_reason: 'expired' });
    const input = handoffMocks.prepareTextHandoff.mock.calls[0][0] as {
      continuedFrom: string;
      reason: string;
      voiceEnabled: boolean;
      canAccess: (row: { user_id: number | null }, id: string) => boolean;
    };
    expect(input.continuedFrom).toBe('live_A');
    expect(input.reason).toBe('expired');
    expect(input.voiceEnabled).toBe(true);
    expect(input.canAccess({ user_id: 7 }, 'live_A')).toBe(true);
    expect(input.canAccess({ user_id: 8 }, 'live_A')).toBe(false);
  });

  it('anything but "expired" is a content cut', async () => {
    await request(makeApp()).post('/api/chat/start').send({ continued_from: 'live_A', handoff_reason: 'nonsense' });
    expect(handoffMocks.prepareTextHandoff.mock.calls[0][0]).toMatchObject({ reason: 'content' });
  });

  it('is not turned away by the cooldown or by a still-active voice session', async () => {
    helperMocks.checkSessionLimits.mockResolvedValue({ allowed: false, reason: 'cooldown', minutes_remaining: 29 });
    dbMocks.getActiveSessionForUser.mockResolvedValue({ session_id: 'live_A' });
    const res = await request(makeApp()).post('/api/chat/start').send({ continued_from: 'live_A' });
    expect(res.status).toBe(200);
    expect(res.body.alreadyActive).toBeUndefined();
    expect(res.body.opening).toBe(HANDOFF_CRISIS_FIRST_MESSAGE);
  });

  it('a no-risk cut returns the neutral message and no quick replies', async () => {
    handoffMocks.prepareTextHandoff.mockResolvedValue({
      payload: {
        ...CRISIS_PREPARED.payload,
        kind: 'neutral',
        severity: 'none',
        quickReplies: [],
        voiceReturnAllowed: true,
      },
      firstMessage: HANDOFF_NEUTRAL_FIRST_MESSAGE,
      guidance: null,
    });
    const res = await request(makeApp()).post('/api/chat/start').send({ continued_from: 'live_A' });
    expect(res.body.opening).toBe(HANDOFF_NEUTRAL_FIRST_MESSAGE);
    expect(res.body.handoff).toMatchObject({ kind: 'neutral', quickReplies: [], voiceReturnAllowed: true });
    expect(chatMocks.injectGuidance).not.toHaveBeenCalled();
  });

  it('a session that cannot be continued still starts a chat session, with no hand-off', async () => {
    handoffMocks.prepareTextHandoff.mockResolvedValue(null);
    const res = await request(makeApp()).post('/api/chat/start').send({ continued_from: 'live_not_mine' });
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBeTruthy();
    expect(res.body.handoff).toBeNull();
    expect(res.body.opening).toBeNull();
  });

  it('a hand-off that throws still leaves a working chat session', async () => {
    handoffMocks.prepareTextHandoff.mockRejectedValue(new Error('boom'));
    const res = await request(makeApp()).post('/api/chat/start').send({ continued_from: 'live_A' });
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBeTruthy();
    expect(res.body.handoff).toBeNull();
  });

  it('an ordinary chat start is untouched: the normal opening, no hand-off', async () => {
    const res = await request(makeApp()).post('/api/chat/start').send({ language: 'en' });
    expect(res.status).toBe(200);
    expect(handoffMocks.prepareTextHandoff).not.toHaveBeenCalled();
    expect(res.body.handoff).toBeNull();
    expect(res.body.opening).toMatch(/AI mental health support assistant/);
  });
});

describe('POST /api/chat/message in a hand-off session', () => {
  const send = (message = 'Yes') => request(makeApp()).post('/api/chat/message').send({ sessionId: 'chat_1', message });

  it('first turn of a crisis hand-off: the reply is not held for the assessor, and the pipeline still runs', async () => {
    handoffMocks.consumeNarrowFirstTurn.mockReturnValue(true);
    handoffMocks.isHandoffSession.mockReturnValue(true);
    let pipelineDone = false;
    pipelineMocks.runCrisisPipeline.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            pipelineDone = true;
            resolve({ steeringGuidance: 'LATE STEER' });
          }, 150),
        ),
    );
    let pipelineDoneWhenModelCalled: boolean | null = null;
    chatMocks.sendMessage.mockImplementation(async () => {
      pipelineDoneWhenModelCalled = pipelineDone;
      return {
        text: 'Thank you for telling me. Have you thought about how? You can call or text 988.',
        toolEvents: [],
      };
    });

    const res = await send('Yes');
    expect(res.status).toBe(200);
    // The model call started while the assessor was still working.
    expect(pipelineDoneWhenModelCalled).toBe(false);
    expect(chatMocks.sendMessage).toHaveBeenCalledWith('chat_1', 'Yes', { narrowCrisisTurn: true });
    // The turn is still scored, flagged and paged by the ordinary pipeline.
    expect(pipelineMocks.runCrisisPipeline).toHaveBeenCalledWith(
      { sessionId: 'chat_1', messageId: 41, content: 'Yes' },
      'chat',
    );
    // Its steer lands on the next turn.
    expect(chatMocks.injectGuidance).toHaveBeenCalledWith('chat_1', 'LATE STEER');
  });

  it('first turn: voice return is refused while the score is still outstanding', async () => {
    handoffMocks.consumeNarrowFirstTurn.mockReturnValue(true);
    handoffMocks.isHandoffSession.mockReturnValue(true);
    handoffMocks.resolveVoiceReturn.mockResolvedValue(true);
    pipelineMocks.runCrisisPipeline.mockImplementation(() => new Promise(() => {})); // never settles
    const res = await send('No');
    expect(res.status).toBe(200);
    expect(res.body.handoff).toEqual({ voiceReturnAllowed: false });
  });

  it('later turns take the ordinary path (assessed before the reply) and report voice return', async () => {
    handoffMocks.consumeNarrowFirstTurn.mockReturnValue(false);
    handoffMocks.isHandoffSession.mockReturnValue(true);
    handoffMocks.resolveVoiceReturn.mockResolvedValue(true);
    detectionMocks.needsContextAssessment.mockResolvedValue(true);
    pipelineMocks.runCrisisPipeline.mockResolvedValue({ steeringGuidance: 'STEER NOW' });
    const res = await send("I'm okay now");
    expect(chatMocks.sendMessage).toHaveBeenCalledWith('chat_1', "I'm okay now");
    // Steering was injected BEFORE the model call on this turn.
    expect(chatMocks.injectGuidance.mock.invocationCallOrder[0]).toBeLessThan(
      chatMocks.sendMessage.mock.invocationCallOrder[0],
    );
    expect(res.body.handoff).toEqual({ voiceReturnAllowed: true });
  });

  it('an ordinary chat session gets no hand-off field and no narrow turn', async () => {
    const res = await send('hello');
    expect(res.body.handoff).toBeUndefined();
    expect(chatMocks.sendMessage).toHaveBeenCalledWith('chat_1', 'hello');
    expect(handoffMocks.resolveVoiceReturn).not.toHaveBeenCalled();
  });
});

describe('POST /api/chat/voice-return', () => {
  it("answers with the server's own check, bound to the requester", async () => {
    handoffMocks.verifyVoiceReturn.mockResolvedValue(true);
    const res = await request(makeApp()).post('/api/chat/voice-return').send({ sessionId: 'chat_1' });
    expect(res.body).toEqual({ allowed: true });
    const canAccess = handoffMocks.verifyVoiceReturn.mock.calls[0][1] as (
      row: { user_id: number | null },
      id: string,
    ) => boolean;
    expect(canAccess({ user_id: 7 }, 'chat_1')).toBe(true);
    expect(canAccess({ user_id: 9 }, 'chat_1')).toBe(false);
  });

  it('is "no" when the check fails or the id is missing', async () => {
    handoffMocks.verifyVoiceReturn.mockRejectedValue(new Error('db'));
    expect((await request(makeApp()).post('/api/chat/voice-return').send({ sessionId: 'chat_1' })).body).toEqual({
      allowed: false,
    });
    expect((await request(makeApp()).post('/api/chat/voice-return').send({})).status).toBe(400);
  });

  // The voice start it leads to is refused overnight; the chat is ended
  // first, so a "yes" would drop the participant on Home (PR #77 review).
  it('is "no" during quiet hours, without ending anything', async () => {
    handoffMocks.verifyVoiceReturn.mockResolvedValue(true);
    quietMocks.getQuietHoursStatus.mockReturnValueOnce({ active: true });
    const res = await request(makeApp()).post('/api/chat/voice-return').send({ sessionId: 'chat_1' });
    expect(res.body).toEqual({ allowed: false });
    expect(handoffMocks.verifyVoiceReturn).not.toHaveBeenCalled();
  });
});
