// /api/chat/start must work for ANONYMOUS participants: therapy_sessions.user_id
// is INTEGER, so the session-limit / idempotency queries must be keyed by the
// numeric user id (null when anonymous) — passing the express-session id string
// used to make pg throw a cast error and 500 every anonymous chat start.
// Also covers the per-IP limiter backstop on /api/chat/message.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer } from 'node:http';
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
  upsertSessionConfig: vi.fn(),
}));
const chatMocks = vi.hoisted(() => ({
  initializeChatSession: vi.fn(),
  seedAssistantOpening: vi.fn(),
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
const registryMocks = vi.hoisted(() => ({
  getEnabledToolDefinitions: vi.fn(),
}));

vi.mock('../../db/index.js', () => dbMocks);
vi.mock('../../utils/sessionHelpers.js', () => helperMocks);
vi.mock('../../utils/promptContext.js', () => ({
  sanitizeCheckin: () => null,
  buildCheckinBlock: () => '',
  buildParticipantContextBlock: async () => '',
  buildToolGuidanceBlock: (names: string[], opts: { psychoeducationCue?: boolean }) =>
    opts.psychoeducationCue && names.includes('retrieve_psychoeducation') ? '\n\nCUE:retrieve_psychoeducation' : '',
  buildLeadConversationBlock: (enabled: boolean) => (enabled ? '\n\nLEAD' : ''),
}));
vi.mock('../../services/toolRegistry.service.js', () => ({
  toolRegistry: registryMocks,
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
  initializeChatSession: chatMocks.initializeChatSession,
  seedAssistantOpening: chatMocks.seedAssistantOpening,
  sendMessage: chatMocks.sendMessage,
  injectGuidance: vi.fn(),
  endChatSession: vi.fn(),
  getConversationHistory: vi.fn().mockReturnValue([]),
  isChatSessionUnavailableError: (err: unknown) =>
    err instanceof Error && (err as { code?: string }).code === 'session_unavailable',
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
  // clearAllMocks keeps implementations: a test's mockRejectedValue (the
  // opening-persist failure, the unrehydratable session) used to carry into
  // whichever test ran next (ai-therapist-370). Reset the hoisted mocks fully.
  for (const group of [dbMocks, chatMocks, helperMocks, registryMocks]) {
    for (const fn of Object.values(group)) fn.mockReset();
  }
  helperMocks.checkSessionLimits.mockResolvedValue({ allowed: true });
  helperMocks.getSystemPrompt.mockResolvedValue('prompt');
  helperMocks.getSystemConfig.mockResolvedValue({ features: {} });
  dbMocks.getActiveSessionForUser.mockResolvedValue(null);
  dbMocks.createSession.mockResolvedValue({ session_id: 'chat_1_a' });
  dbMocks.recordConsent.mockResolvedValue(undefined);
  dbMocks.getUserPreferredLanguage.mockResolvedValue('en');
  dbMocks.setUserPreferredLanguage.mockResolvedValue(undefined);
  dbMocks.setSessionCheckin.mockResolvedValue(undefined);
  dbMocks.upsertSessionConfig.mockResolvedValue({});
  helperMocks.resolveProactiveOffering.mockResolvedValue(true);
  helperMocks.resolvePsychoeducationCue.mockResolvedValue(null);
  helperMocks.resolveLeadConversation.mockResolvedValue(false);
  registryMocks.getEnabledToolDefinitions.mockResolvedValue([
    { name: 'retrieve_psychoeducation' },
    { name: 'log_mood' },
  ]);
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
    expect(dbMocks.createSession).toHaveBeenCalledWith(expect.objectContaining({ userId: null }));
  });

  it('uses the numeric user id for logged-in participants', async () => {
    const res = await request(makeApp({ userId: 12, userRole: 'participant', username: 'p12' }))
      .post('/api/chat/start')
      .send({ language: 'en' });
    expect(res.status).toBe(200);
    expect(helperMocks.checkSessionLimits).toHaveBeenCalledWith(12, 'participant');
    expect(dbMocks.getActiveSessionForUser).toHaveBeenCalledWith(12);
  });

  it('resolves the proactive-offering condition once and persists it (ai-therapist-74)', async () => {
    helperMocks.resolveProactiveOffering.mockResolvedValue(false);
    const res = await request(makeApp()).post('/api/chat/start').send({});
    expect(res.status).toBe(200);

    // Resolved exactly once, passed into the prompt build (no internal
    // re-roll), and recorded on session_configurations for analysis.
    expect(helperMocks.resolveProactiveOffering).toHaveBeenCalledTimes(1);
    expect(helperMocks.getSystemPrompt).toHaveBeenCalledWith('en', 'chat', false);
    expect(dbMocks.upsertSessionConfig).toHaveBeenCalledWith(
      res.body.sessionId,
      expect.objectContaining({ proactive_offering: false, modalities: ['text'], language: 'en' }),
    );
  });

  describe('chat model (system_config.chat_model)', () => {
    it('defaults to gpt-5.2 and stamps it on the session record', async () => {
      const res = await request(makeApp()).post('/api/chat/start').send({});
      expect(res.status).toBe(200);
      expect(chatMocks.initializeChatSession).toHaveBeenCalledWith(res.body.sessionId, 'prompt', 'gpt-5.2');
      expect(dbMocks.upsertSessionConfig).toHaveBeenCalledWith(
        res.body.sessionId,
        expect.objectContaining({ ai_model: 'gpt-5.2' }),
      );
    });

    it('starts the session on the configured model and records that model', async () => {
      helperMocks.getSystemConfig.mockResolvedValue({ features: {}, chat_model: 'gpt-6.1-terra' });
      const res = await request(makeApp()).post('/api/chat/start').send({});
      expect(res.status).toBe(200);
      expect(chatMocks.initializeChatSession).toHaveBeenCalledWith(res.body.sessionId, 'prompt', 'gpt-6.1-terra');
      expect(dbMocks.upsertSessionConfig).toHaveBeenCalledWith(
        res.body.sessionId,
        expect.objectContaining({ ai_model: 'gpt-6.1-terra' }),
      );
    });
  });

  describe('psychoeducation cue experiment (ai-therapist-202)', () => {
    it('experiment off (null): no cue in the prompt, arm stored as null', async () => {
      const res = await request(makeApp()).post('/api/chat/start').send({});
      expect(res.status).toBe(200);
      expect(helperMocks.resolvePsychoeducationCue).toHaveBeenCalledTimes(1);
      expect(chatMocks.initializeChatSession).toHaveBeenCalledWith(res.body.sessionId, 'prompt', 'gpt-5.2');
      expect(registryMocks.getEnabledToolDefinitions).not.toHaveBeenCalled();
      expect(dbMocks.upsertSessionConfig).toHaveBeenCalledWith(
        res.body.sessionId,
        expect.objectContaining({ psychoeducation_cue: null }),
      );
    });

    it('control arm (false): no cue in the prompt, arm stored as false', async () => {
      helperMocks.resolvePsychoeducationCue.mockResolvedValue(false);
      const res = await request(makeApp()).post('/api/chat/start').send({});
      expect(chatMocks.initializeChatSession).toHaveBeenCalledWith(res.body.sessionId, 'prompt', 'gpt-5.2');
      expect(dbMocks.upsertSessionConfig).toHaveBeenCalledWith(
        res.body.sessionId,
        expect.objectContaining({ psychoeducation_cue: false }),
      );
    });

    it('cue arm (true): appends only the retrieve_psychoeducation guidance and stores true', async () => {
      helperMocks.resolvePsychoeducationCue.mockResolvedValue(true);
      const res = await request(makeApp()).post('/api/chat/start').send({});
      expect(registryMocks.getEnabledToolDefinitions).toHaveBeenCalledWith({ channel: 'chat' });
      expect(chatMocks.initializeChatSession).toHaveBeenCalledWith(
        res.body.sessionId,
        'prompt\n\nCUE:retrieve_psychoeducation',
        'gpt-5.2',
      );
      expect(dbMocks.upsertSessionConfig).toHaveBeenCalledWith(
        res.body.sessionId,
        expect.objectContaining({ psychoeducation_cue: true }),
      );
    });

    it('cue arm without the tool enabled for chat adds nothing', async () => {
      helperMocks.resolvePsychoeducationCue.mockResolvedValue(true);
      registryMocks.getEnabledToolDefinitions.mockResolvedValue([{ name: 'log_mood' }]);
      const res = await request(makeApp()).post('/api/chat/start').send({});
      expect(chatMocks.initializeChatSession).toHaveBeenCalledWith(res.body.sessionId, 'prompt', 'gpt-5.2');
    });
  });

  describe('lead-conversation flag (features.lead_conversation_enabled)', () => {
    it('flag off: prompt and opening exactly as before', async () => {
      const res = await request(makeApp()).post('/api/chat/start').send({});
      expect(res.status).toBe(200);
      expect(helperMocks.resolveLeadConversation).toHaveBeenCalledTimes(1);
      expect(chatMocks.initializeChatSession).toHaveBeenCalledWith(res.body.sessionId, 'prompt', 'gpt-5.2');
      expect(res.body.opening).toMatch(/I'm glad you're here with me today\.$/);
    });

    it('flag on: block after the tool guidance, opening ends with an invitation', async () => {
      helperMocks.resolveLeadConversation.mockResolvedValue(true);
      helperMocks.resolvePsychoeducationCue.mockResolvedValue(true);
      const res = await request(makeApp()).post('/api/chat/start').send({});
      expect(chatMocks.initializeChatSession).toHaveBeenCalledWith(
        res.body.sessionId,
        'prompt\n\nCUE:retrieve_psychoeducation\n\nLEAD',
        'gpt-5.2',
      );
      expect(res.body.opening).toMatch(/I'm glad you're here with me today\. What would you like to focus on today\?$/);
      expect(dbMocks.upsertSessionConfig).toHaveBeenCalledWith(
        res.body.sessionId,
        expect.objectContaining({ instructions: 'prompt\n\nCUE:retrieve_psychoeducation\n\nLEAD' }),
      );
    });
  });

  it('does not re-roll the condition when an active session already exists', async () => {
    dbMocks.getActiveSessionForUser.mockResolvedValue({ session_id: 'chat_existing' });
    const res = await request(makeApp({ userId: 12, userRole: 'participant' }))
      .post('/api/chat/start')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.alreadyActive).toBe(true);
    expect(helperMocks.resolveProactiveOffering).not.toHaveBeenCalled();
    expect(helperMocks.resolvePsychoeducationCue).not.toHaveBeenCalled();
    expect(dbMocks.upsertSessionConfig).not.toHaveBeenCalled();
  });

  it('returns 429 when session limits deny the start', async () => {
    helperMocks.checkSessionLimits.mockResolvedValue({
      allowed: false,
      reason: 'daily_limit',
      message: 'no',
      limit: 3,
      current: 3,
    });
    const res = await request(makeApp({ userId: 12, userRole: 'participant' }))
      .post('/api/chat/start')
      .send({});
    expect(res.status).toBe(429);
    expect(dbMocks.createSession).not.toHaveBeenCalled();
  });

  it('a cooldown refusal says when, in words, and carries crisis resources (ai-therapist-324)', async () => {
    helperMocks.checkSessionLimits.mockResolvedValue({
      allowed: false,
      reason: 'cooldown',
      message: 'internal',
      cooldown_minutes: 30,
      minutes_remaining: 28,
    });
    const res = await request(makeApp({ userId: 12, userRole: 'participant' }))
      .post('/api/chat/start')
      .send({});
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: 'rate_limit_exceeded', reason: 'cooldown', minutes_remaining: 28 });
    expect(res.body.message).toMatch(/in 28 minutes/);
    expect(res.body.message).toMatch(/988/);
    expect(res.body.crisis_resources.phone).toBeTruthy();
    expect(dbMocks.createSession).not.toHaveBeenCalled();
  });
});

// Server-authored opening line (ai-therapist-259 / 151): the disclaimer is a
// persisted first assistant turn, not a client-side decoration the model and
// the transcript never see.
describe('POST /api/chat/start opening line', () => {
  it('persists the opening as the first assistant turn, seeds the model history, and returns it', async () => {
    dbMocks.insertMessagesBatch.mockResolvedValue([{ message_id: 1 }]);
    const res = await request(makeApp()).post('/api/chat/start').send({});
    expect(res.status).toBe(200);
    expect(res.body.opening).toMatch(/not a licensed therapist or doctor/);
    expect(res.body.opening).toMatch(/I'm an AI/);

    expect(dbMocks.insertMessagesBatch).toHaveBeenCalledTimes(1);
    const [rows] = dbMocks.insertMessagesBatch.mock.calls[0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: res.body.sessionId,
      role: 'assistant',
      message_type: 'text',
      content: res.body.opening,
      // Pre-redacted: machine-authored, PHI-free, must not cost a redaction call.
      content_redacted: res.body.opening,
      metadata: { opening_line: true },
    });
    expect(chatMocks.seedAssistantOpening).toHaveBeenCalledWith(res.body.sessionId, res.body.opening);
  });

  it('uses the configured crisis contact in the opening', async () => {
    helperMocks.getSystemConfig.mockResolvedValue({
      features: {},
      crisis_contact: { enabled: true, hotline: 'Campus Line', phone: '555-0100', text: 'Text HELP to 12345' },
    });
    const res = await request(makeApp()).post('/api/chat/start').send({});
    expect(res.body.opening).toContain('call the Campus Line crisis line at 555-0100 or text Text HELP to 12345');
  });

  it('skips the opening on a continuation of a terminated voice session', async () => {
    dbMocks.getSessionAccessInfo.mockResolvedValue(null); // prior session not accessible -> fresh, but still a continuation
    const res = await request(makeApp()).post('/api/chat/start').send({ continued_from: 'live_prior' });
    expect(res.status).toBe(200);
    expect(res.body.opening).toBeNull();
    expect(dbMocks.insertMessagesBatch).not.toHaveBeenCalled();
    expect(chatMocks.seedAssistantOpening).not.toHaveBeenCalled();
  });

  it('still starts the session when persisting the opening fails', async () => {
    dbMocks.insertMessagesBatch.mockRejectedValue(new Error('db down'));
    const res = await request(makeApp()).post('/api/chat/start').send({});
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBeTruthy();
    expect(res.body.opening).toBeNull();
  });
});

describe('POST /api/chat/message rate limiting', () => {
  it('backstops the endpoint at 30 requests per IP per minute', async () => {
    // One server for the whole burst instead of 31 (request(app) starts a
    // fresh one per call), sent concurrently: the limiter counts arrivals, so
    // exactly 30 requests pass and exactly one is limited (ai-therapist-279).
    const server = createServer(makeApp());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const statuses = await Promise.all(
        // Missing body -> 400 before any db/model work; still counts for the limiter.
        Array.from({ length: 31 }, () =>
          request(server)
            .post('/api/chat/message')
            .send({})
            .then((res) => res.status),
        ),
      );
      expect(statuses.filter((s) => s === 400)).toHaveLength(30);
      expect(statuses.filter((s) => s === 429)).toHaveLength(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// ai-therapist-222: a restart that leaves the session unrehydratable is a
// client-actionable state, not a server fault — the participant must be told
// to start a new session instead of seeing a generic failure forever.
describe('POST /api/chat/message when the session cannot be rehydrated', () => {
  it('answers 409 session_unavailable with showable copy, not a 500', async () => {
    const sessionId = 'chat_dead';
    dbMocks.getSessionAccessInfo.mockResolvedValue({ status: 'active', user_id: null, session_type: 'chat' });
    dbMocks.insertMessagesBatch.mockResolvedValue([{ message_id: 42 }]);
    const err = Object.assign(new Error('Session chat_dead has no stored instructions'), {
      code: 'session_unavailable',
      participantMessage: 'This conversation is no longer available. Please start a new session.',
    });
    chatMocks.sendMessage.mockRejectedValue(err);

    const res = await request(makeApp({ ownedSessions: [sessionId] }))
      .post('/api/chat/message')
      .send({ sessionId, message: 'are you there?' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'session_unavailable',
      message: 'This conversation is no longer available. Please start a new session.',
    });
  });
});
