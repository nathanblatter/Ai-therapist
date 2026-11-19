// POST /api/grok/session with a pre-session check-in (PR 65).
//
// The check-in's free text goes through the crisis pipeline at session start,
// like a first participant turn. On Grok the voice socket does not exist yet
// (it opens when the browser attaches), so the flag and the page must not wait
// for it; the steer the check-in earns is held and delivered when the socket is
// ready (crisisIntervention deliverPendingSteer; see its tests). This file
// pins the route's half: the call is made, on the realtime channel, and never
// delays or fails the start. Every dependency is mocked; no network.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  getSessionAccessInfo: vi.fn(),
  getActiveSessionForUser: vi.fn(),
  upsertSessionConfig: vi.fn(),
  getAiModel: vi.fn(),
  getUserPreferences: vi.fn(),
  updateUserPreferences: vi.fn(),
  createActiveRealtimeSession: vi.fn(),
  recordConsent: vi.fn(),
  setSessionCheckin: vi.fn(),
}));
const mocks = vi.hoisted(() => ({
  checkin: null as Record<string, unknown> | null,
  runCheckinCrisisScreen: vi.fn(),
  registerPending: vi.fn(),
}));

vi.mock('../../db/index.js', () => dbMocks);
vi.mock('../../config/db.js', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('../../config/secrets.js', () => ({ getXaiKey: async () => 'xai-test', hasXaiKey: () => true }));
vi.mock('../../utils/sessionHelpers.js', () => ({
  checkSessionLimits: async () => ({ allowed: true, limits: null }),
  getSystemPrompt: async () => 'prompt',
  getActiveModality: async () => null,
  getSystemConfig: async () => ({}),
  resolveProactiveOffering: async () => false,
  resolvePsychoeducationCue: async () => null,
  resolveLeadConversation: async () => false,
  getLanguageName: async () => 'English',
}));
vi.mock('../../utils/sessionOwnership.js', () => ({ recordSessionOwnership: vi.fn(), canAccessSession: () => true }));
vi.mock('../../utils/promptContext.js', () => ({
  sanitizeCheckin: () => mocks.checkin,
  buildCheckinBlock: () => '',
  buildParticipantContextBlock: async () => '',
  buildToolGuidanceBlock: () => '',
  buildLeadConversationBlock: () => '',
}));
const pass = (_req: unknown, _res: unknown, next: () => void) => next();
vi.mock('../../middleware/consent.js', () => ({ requireConsent: pass }));
vi.mock('../../middleware/quietHours.js', () => ({ requireOutsideQuietHours: pass }));
vi.mock('../../middleware/studyStatus.js', () => ({ requireActiveStudyStatus: pass }));
vi.mock('../../utils/sessionLimitRefusal.js', () => ({ sessionLimitRefusalFor: async () => ({}) }));
vi.mock('../../utils/adminBroadcast.js', () => ({ broadcastAdminEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../utils/sessionAutoTerminate.js', () => ({ scheduleAutoTermination: vi.fn() }));
vi.mock('../../utils/grokVoiceConfig.js', () => ({
  buildGrokSessionConfig: () => ({ instructions: 'prompt' }),
  buildGrokOpeningPrompt: () => 'opening',
  buildGrokCrisisPhrase: () => '988',
  isGrokVoiceModel: () => true,
  resolveGrokVoice: (v: unknown) => v ?? 'ara',
  resolveGrokTuning: () => ({ reconnect_window_s: 20 }),
}));
vi.mock('../../utils/grokRefusalGuard.js', () => ({
  resolveGrokRefusalGuard: () => ({}),
  buildGrokRefusalRecoveryLine: () => 'recovery',
}));
vi.mock('../../services/grokVoiceManager.service.js', () => ({
  grokVoiceManager: { registerPending: mocks.registerPending, tryInject: vi.fn(), disconnect: vi.fn() },
}));
vi.mock('../../services/toolRegistry.service.js', () => ({
  toolRegistry: { getEnabledToolDefinitions: async () => [] },
}));
vi.mock('../../utils/harness.js', () => ({ isNonStudyUser: () => false }));
vi.mock('../../services/crisisPipeline.service.js', () => ({ runCheckinCrisisScreen: mocks.runCheckinCrisisScreen }));

const { default: grokSessionRoutes } = await import('./grokSession.routes.js');

function makeApp(session: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = { consentVersion: 'v1', ...session };
    next();
  });
  app.use(grokSessionRoutes());
  return app;
}
const start = (session?: Record<string, unknown>) => request(makeApp(session)).post('/api/grok/session').send({});
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  for (const m of Object.values(dbMocks)) m.mockReset().mockResolvedValue(undefined);
  dbMocks.getAiModel.mockResolvedValue('grok-voice-latest');
  mocks.checkin = null;
  mocks.runCheckinCrisisScreen.mockReset().mockResolvedValue({ riskScore: 0 });
  mocks.registerPending.mockReset();
});

describe('POST /api/grok/session with a check-in', () => {
  it('sends the check-in through the crisis pipeline on the realtime channel, for the session it created', async () => {
    mocks.checkin = { mood: 1, topic: "I don't really want to be alive" };

    const res = await start().expect(201);
    await settle();

    expect(mocks.runCheckinCrisisScreen).toHaveBeenCalledTimes(1);
    expect(mocks.runCheckinCrisisScreen).toHaveBeenCalledWith(res.body.session_id, mocks.checkin, 'realtime');
    // The session row exists before the pipeline is asked to score into it,
    // and the voice session is registered: the socket opens later.
    expect(dbMocks.createActiveRealtimeSession).toHaveBeenCalled();
    expect(mocks.registerPending).toHaveBeenCalledWith(res.body.session_id, expect.any(Object));
  });

  // ai-therapist-373: the start and the check-in's words are kept in memory
  // for the crisis pipeline (its context when the database cannot answer).
  it('keeps the start and the check-in text in memory for the crisis pipeline', async () => {
    const { recentTurns, rememberedCheckin } = await import('../../utils/recentTurns.js');
    mocks.checkin = { mood: 1, topic: "I don't really want to be alive" };
    const res = await start().expect(201);
    expect(rememberedCheckin(res.body.session_id)).toBe("I don't really want to be alive");
    expect(recentTurns(res.body.session_id)?.complete).toBe(true);
  });

  // ai-therapist-374: kept with its participant, so a withdrawal or account
  // deletion finds it without a read.
  it("keeps the start with the signed-in participant's id", async () => {
    const { recentTurns, forgetParticipantTurns } = await import('../../utils/recentTurns.js');
    const res = await start({ userId: 7, userRole: 'participant' }).expect(201);
    expect(recentTurns(res.body.session_id)?.complete).toBe(true);
    forgetParticipantTurns(8);
    expect(recentTurns(res.body.session_id)).not.toBeNull();
    forgetParticipantTurns(7);
    expect(recentTurns(res.body.session_id)).toBeNull();
  });

  it('does not wait for the screen: a slow assessor never delays the start', async () => {
    mocks.checkin = { topic: 'anything' };
    mocks.runCheckinCrisisScreen.mockImplementation(() => new Promise(() => undefined));
    await start().expect(201);
  });

  it('no check-in: the pipeline is not called', async () => {
    await start().expect(201);
    await settle();
    expect(mocks.runCheckinCrisisScreen).not.toHaveBeenCalled();
  });

  it('a failing screen never fails the session start', async () => {
    mocks.checkin = { topic: 'anything' };
    mocks.runCheckinCrisisScreen.mockRejectedValue(new Error('pipeline down'));
    await start().expect(201);
    await settle();
  });
});
