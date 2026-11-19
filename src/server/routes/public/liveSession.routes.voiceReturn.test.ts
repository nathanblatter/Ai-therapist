// Return to voice from a text hand-off chat (ai-therapist-356): POST
// /api/live/session with `resume_from`. The cooldown exemption is granted
// only when the server's own check says that chat's risk check has cleared.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  getActiveSessionForUser: vi.fn(),
  upsertSessionConfig: vi.fn(),
  getAiModel: vi.fn(),
  getUserPreferences: vi.fn(),
  updateUserPreferences: vi.fn(),
  createActiveRealtimeSession: vi.fn(),
  recordConsent: vi.fn(),
  setSessionCheckin: vi.fn(),
  updateSessionStatus: vi.fn(),
  setLiveSessionId: vi.fn(),
  markSidebandUnmonitored: vi.fn(),
}));
const mocks = vi.hoisted(() => ({
  reportQuota: vi.fn(),
  connectAndWait: vi.fn(),
  upstreamFetch: vi.fn(),
  systemConfig: {} as Record<string, unknown>,
  limit: { allowed: true, limits: null } as Record<string, unknown>,
  verifyVoiceReturn: vi.fn(),
  recordVoiceReturn: vi.fn(),
}));

vi.mock('../../db/index.js', () => dbMocks);
vi.mock('../../config/secrets.js', () => ({ getOpenAIKey: async () => 'test-key' }));
vi.mock('../../utils/sessionHelpers.js', () => ({
  checkSessionLimits: async () => mocks.limit,
  getSystemPrompt: async () => 'prompt',
  getActiveModality: async () => null,
  getSystemConfig: async () => mocks.systemConfig,
  resolveProactiveOffering: async () => false,
  resolvePsychoeducationCue: async () => null,
  resolveLeadConversation: async () => false,
  getLanguageName: async () => 'English',
}));
vi.mock('../../utils/sessionOwnership.js', () => ({
  recordSessionOwnership: vi.fn(),
  canAccessSession: (_req: unknown, row: { user_id: number | null }) => row.user_id === 7,
}));
vi.mock('../../services/textHandoff.service.js', () => ({
  verifyVoiceReturn: mocks.verifyVoiceReturn,
  recordVoiceReturn: mocks.recordVoiceReturn,
}));
vi.mock('../../utils/sessionLimitRefusal.js', () => ({
  sessionLimitRefusalFor: async () => ({ error: 'rate_limit_exceeded', reason: 'cooldown' }),
  tooManyAttemptsRefusal: () => ({ error: 'rate_limit_exceeded' }),
}));
vi.mock('../../utils/promptContext.js', () => ({
  sanitizeCheckin: () => null,
  buildCheckinBlock: () => '',
  buildParticipantContextBlock: async () => '',
  buildToolGuidanceBlock: () => '',
  buildLeadConversationBlock: () => '',
}));
const pass = (_req: unknown, _res: unknown, next: () => void) => next();
vi.mock('../../middleware/consent.js', () => ({ requireConsent: pass }));
vi.mock('../../middleware/quietHours.js', () => ({ requireOutsideQuietHours: pass }));
vi.mock('../../middleware/studyStatus.js', () => ({ requireActiveStudyStatus: pass }));
vi.mock('../../utils/adminBroadcast.js', () => ({ broadcastAdminEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../utils/sessionAutoTerminate.js', () => ({ scheduleAutoTermination: vi.fn() }));
// The REAL session builder and effort resolution, so the tests below see the
// exact body the mint sends to OpenAI.
vi.mock('../../utils/liveSessionConfig.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/liveSessionConfig.js')>()),
  isLiveModel: () => true,
}));
vi.mock('../../services/sidebandManager.service.js', () => ({
  sidebandManager: { connectAndWait: mocks.connectAndWait, tryInject: vi.fn(), disconnect: vi.fn() },
}));
vi.mock('../../services/toolRegistry.service.js', () => ({
  toolRegistry: { getEnabledToolDefinitions: async () => [] },
}));
vi.mock('../../utils/harness.js', () => ({ isNonStudyUser: () => false }));
vi.mock('../../utils/safetyIdentifier.js', () => ({ isIdentifierBlockedError: () => false }));
vi.mock('../../services/crisisAlert.service.js', () => ({ reportOpenAIQuotaExhausted: mocks.reportQuota }));

const { default: liveSessionRoutes, PROVIDER_UNAVAILABLE_BODY } = await import('./liveSession.routes.js');

function upstream(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = {
      consentVersion: 'v1',
      userId: 7,
      userRole: 'participant',
    };
    next();
  });
  app.use(liveSessionRoutes());
  return app;
}

const start = () => request(makeApp()).post('/api/live/session').send({ sdp: 'v=0 offer' });

beforeEach(() => {
  for (const m of Object.values(dbMocks)) m.mockReset().mockResolvedValue(undefined);
  dbMocks.getAiModel.mockResolvedValue('gpt-live-test');
  mocks.reportQuota.mockReset().mockResolvedValue(undefined);
  mocks.connectAndWait.mockReset().mockResolvedValue(undefined);
  mocks.upstreamFetch.mockReset();
  mocks.systemConfig = {};
  // supertest talks to the app over a real socket; only the upstream fetch is stubbed.
  vi.stubGlobal('fetch', mocks.upstreamFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const healthy = () => upstream(200, { session: { id: 'sess_live_back' }, transport: { sdp: 'answer' } });
const resume = (from: unknown = 'chat_handoff_1') =>
  request(makeApp()).post('/api/live/session').send({ sdp: 'v=0 offer', resume_from: from });

describe('POST /api/live/session with resume_from (return to voice)', () => {
  beforeEach(() => {
    mocks.limit = { allowed: false, reason: 'cooldown', minutes_remaining: 29 };
    mocks.verifyVoiceReturn.mockReset().mockResolvedValue(true);
    mocks.recordVoiceReturn.mockReset().mockResolvedValue(undefined);
    mocks.upstreamFetch.mockResolvedValue(healthy());
    dbMocks.getActiveSessionForUser.mockResolvedValue({ session_id: 'chat_handoff_1', created_at: new Date() });
  });

  it('cleared hand-off chat: starts despite the cooldown and the still-active chat, and links the sessions', async () => {
    const res = await resume();
    expect(res.status).toBe(201);
    expect(res.body.session_id).toBe('sess_live_back');
    expect(mocks.recordVoiceReturn).toHaveBeenCalledWith('sess_live_back', 'chat_handoff_1');
    // An ordinary session: responses-delegated, not a recovery prompt.
    expect(mocks.connectAndWait.mock.calls[0][3]).toMatchObject({ delegationMode: 'responses' });
  });

  it("asks the server's own check, bound to the requester", async () => {
    await resume();
    expect(mocks.verifyVoiceReturn).toHaveBeenCalledWith('chat_handoff_1', expect.any(Function));
    const canAccess = mocks.verifyVoiceReturn.mock.calls[0][1] as (
      row: { user_id: number | null },
      id: string,
    ) => boolean;
    expect(canAccess({ user_id: 7 }, 'chat_handoff_1')).toBe(true);
    expect(canAccess({ user_id: 8 }, 'chat_handoff_1')).toBe(false);
  });

  it('risk check not cleared: no exemption, so the ordinary limit applies and nothing is minted', async () => {
    mocks.verifyVoiceReturn.mockResolvedValue(false);
    const res = await resume();
    expect(res.status).toBe(429);
    expect(mocks.upstreamFetch).not.toHaveBeenCalled();
    expect(mocks.recordVoiceReturn).not.toHaveBeenCalled();
  });

  it('not cleared and no limit in force: the active chat session still blocks a second session', async () => {
    mocks.limit = { allowed: true, limits: null };
    mocks.verifyVoiceReturn.mockResolvedValue(false);
    const res = await resume();
    expect(res.status).toBe(200);
    expect(res.body.session).toMatchObject({ id: 'chat_handoff_1', exists: true });
    expect(mocks.upstreamFetch).not.toHaveBeenCalled();
  });

  it('a resume_from that is not a string is ignored', async () => {
    const res = await resume({ id: 'chat_handoff_1' });
    expect(res.status).toBe(429);
    expect(mocks.verifyVoiceReturn).not.toHaveBeenCalled();
  });

  it('an ordinary start never consults the hand-off', async () => {
    mocks.limit = { allowed: true, limits: null };
    dbMocks.getActiveSessionForUser.mockResolvedValue(null);
    await request(makeApp()).post('/api/live/session').send({ sdp: 'v=0 offer' }).expect(201);
    expect(mocks.verifyVoiceReturn).not.toHaveBeenCalled();
    expect(mocks.recordVoiceReturn).not.toHaveBeenCalled();
  });
});
