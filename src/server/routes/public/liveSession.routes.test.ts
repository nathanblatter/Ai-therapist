// POST /api/live/session when OpenAI cannot mint the voice session
// (ai-therapist-190). Under the org's hard spend cap the mint returns a
// billing-class 429. The participant must get a prompt, honest, non-alarming
// "unavailable" (never a hang, never a "check your connection" 500), no
// session row may be created, and the spend-limit condition must reach the
// on-call. Every upstream dependency is mocked; no network.
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
  checkin: null as Record<string, unknown> | null,
  runCheckinCrisisScreen: vi.fn(),
}));

vi.mock('../../db/index.js', () => dbMocks);
vi.mock('../../config/secrets.js', () => ({ getOpenAIKey: async () => 'test-key' }));
vi.mock('../../utils/sessionHelpers.js', () => ({
  checkSessionLimits: async () => ({ allowed: true, limits: null }),
  getSystemPrompt: async () => 'prompt',
  getActiveModality: async () => null,
  getSystemConfig: async () => mocks.systemConfig,
  resolveProactiveOffering: async () => false,
  resolvePsychoeducationCue: async () => null,
  resolveLeadConversation: async () => false,
  getLanguageName: async () => 'English',
}));
vi.mock('../../utils/sessionOwnership.js', () => ({ recordSessionOwnership: vi.fn() }));
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
vi.mock('../../services/crisisPipeline.service.js', () => ({ runCheckinCrisisScreen: mocks.runCheckinCrisisScreen }));

const { default: liveSessionRoutes, PROVIDER_UNAVAILABLE_BODY } = await import('./liveSession.routes.js');

function upstream(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = { consentVersion: 'v1' };
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
  mocks.checkin = null;
  mocks.runCheckinCrisisScreen.mockReset().mockResolvedValue({ riskScore: 0 });
  // supertest talks to the app over a real socket; only the upstream fetch is stubbed.
  vi.stubGlobal('fetch', mocks.upstreamFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/live/session when the voice provider refuses the mint', () => {
  it('hard spend cap (billing 429): honest 503, no session row, on-call paged, no retry', async () => {
    mocks.upstreamFetch.mockResolvedValue(
      upstream(429, {
        error: {
          message: 'Your organization reached its enforced spend limit.',
          type: 'insufficient_quota',
          code: 'organization_spend_limit_exceeded',
        },
      }),
    );
    const res = await start();

    expect(res.status).toBe(503);
    expect(res.body).toEqual(PROVIDER_UNAVAILABLE_BODY);
    expect(mocks.upstreamFetch).toHaveBeenCalledTimes(1);
    expect(mocks.reportQuota).toHaveBeenCalledWith('voice_session_mint', 'organization_spend_limit_exceeded');
    expect(dbMocks.createActiveRealtimeSession).not.toHaveBeenCalled();
    expect(mocks.connectAndWait).not.toHaveBeenCalled();
  });

  it('tells the participant nothing about billing, providers or their own connection being at fault', () => {
    const { message } = PROVIDER_UNAVAILABLE_BODY;
    expect(message).toMatch(/temporarily unavailable/);
    expect(message).toMatch(/not with your connection/);
    expect(message).not.toMatch(/openai|billing|quota|spend|limit|crisis|emergency/i);
  });

  it.each([
    ['429 slow_down', 429, { error: { code: 'slow_down', type: 'rate_limit_error' } }],
    ['503 server_is_overloaded', 503, { error: { code: 'server_is_overloaded' } }],
    ['500', 500, 'upstream exploded'],
  ])('%s: the same honest 503, but no spend-limit page', async (_label, status, body) => {
    mocks.upstreamFetch.mockResolvedValue(upstream(status, body, { 'retry-after': '1' }));
    const res = await start();

    expect(res.status).toBe(503);
    expect(res.body).toEqual(PROVIDER_UNAVAILABLE_BODY);
    expect(mocks.upstreamFetch).toHaveBeenCalledTimes(1);
    expect(mocks.reportQuota).not.toHaveBeenCalled();
    expect(dbMocks.createActiveRealtimeSession).not.toHaveBeenCalled();
  });

  it('bounds the mint with a timeout, and a timeout is the same honest 503 (not a hang)', async () => {
    mocks.upstreamFetch.mockRejectedValue(new DOMException('The operation timed out', 'TimeoutError'));
    const res = await start();

    expect(res.status).toBe(503);
    expect(res.body).toEqual(PROVIDER_UNAVAILABLE_BODY);
    const init = mocks.upstreamFetch.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(dbMocks.createActiveRealtimeSession).not.toHaveBeenCalled();
  });

  it('a network failure reaching the provider is the same honest 503', async () => {
    mocks.upstreamFetch.mockRejectedValue(new TypeError('fetch failed'));
    const res = await start();
    expect(res.status).toBe(503);
    expect(res.body).toEqual(PROVIDER_UNAVAILABLE_BODY);
  });

  it('a request the provider rejects as malformed stays a 500 (our bug, not an outage)', async () => {
    mocks.upstreamFetch.mockResolvedValue(upstream(400, { error: { code: 'invalid_request_error' } }));
    const res = await start();
    expect(res.status).toBe(500);
    expect(mocks.reportQuota).not.toHaveBeenCalled();
  });

  it('a healthy mint still starts the session', async () => {
    mocks.upstreamFetch.mockResolvedValue(
      upstream(200, { session: { id: 'sess_live_1' }, transport: { sdp: 'answer' } }),
    );
    const res = await start();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ session_id: 'sess_live_1', sdp: 'answer' });
    expect(dbMocks.createActiveRealtimeSession).toHaveBeenCalled();
    expect(mocks.connectAndWait).toHaveBeenCalled();
  });
});

// The sideband must be told the delegation mode the session was actually
// minted with (ai-therapist-282): a crisis recovery start is client-delegated
// with no tools, and the manager refuses trigger-tool on it only if the route
// says so here.
describe('POST /api/live/session sideband delegation mode', () => {
  const healthy = () => upstream(200, { session: { id: 'sess_live_2' }, transport: { sdp: 'answer' } });

  it('attaches an ordinary session as responses-delegated', async () => {
    mocks.upstreamFetch.mockResolvedValue(healthy());
    await start().expect(201);
    expect(mocks.connectAndWait.mock.calls[0][3]).toMatchObject({ delegationMode: 'responses' });
  });

  it('attaches a recovery session as client-delegated', async () => {
    mocks.upstreamFetch.mockResolvedValue(healthy());
    await request(makeApp()).post('/api/live/session').send({ sdp: 'v=0 offer', recovery: true }).expect(201);
    expect(mocks.connectAndWait.mock.calls[0][3]).toMatchObject({ delegationMode: 'client' });
  });

  it('only the literal boolean marks a recovery start', async () => {
    mocks.upstreamFetch.mockResolvedValue(healthy());
    await request(makeApp()).post('/api/live/session').send({ sdp: 'v=0 offer', recovery: 'true' }).expect(201);
    expect(mocks.connectAndWait.mock.calls[0][3]).toMatchObject({ delegationMode: 'responses' });
  });
});

// What reaches OpenAI at mint (ai-therapist-309): with neither new key set
// the delegation block must be exactly what it was before
// live_backend_reasoning_effort existed; with it set, the effort rides along on
// the configured backend; recovery never gets a backend at all.
describe('POST /api/live/session delegation request body', () => {
  const healthy = () => upstream(200, { session: { id: 'sess_live_3' }, transport: { sdp: 'answer' } });
  const mintedSession = () =>
    JSON.parse((mocks.upstreamFetch.mock.calls[0][1] as RequestInit).body as string).session as {
      delegation: { type: string; responses?: Record<string, unknown> };
    };

  it('with nothing configured: default backend, no reasoning block, keys unchanged', async () => {
    mocks.upstreamFetch.mockResolvedValue(healthy());
    await start().expect(201);
    const { delegation } = mintedSession();
    expect(delegation.type).toBe('responses');
    expect(Object.keys(delegation.responses ?? {}).sort()).toEqual(
      ['instructions', 'model', 'parallel_tool_calls', 'tool_choice', 'tools'].sort(),
    );
    expect(delegation.responses?.model).toBe('gpt-5.6-terra');
  });

  it('sends the configured backend with the configured effort, and pins the backend on the session row', async () => {
    mocks.systemConfig = { live_backend_model: 'gpt-6.1-terra', live_backend_reasoning_effort: 'low' };
    mocks.upstreamFetch.mockResolvedValue(healthy());
    await start().expect(201);
    const { delegation } = mintedSession();
    expect(delegation.responses).toMatchObject({ model: 'gpt-6.1-terra', reasoning: { effort: 'low' } });
    expect(dbMocks.upsertSessionConfig.mock.calls[0][1]).toMatchObject({ live_backend_model: 'gpt-6.1-terra' });
    expect(mocks.connectAndWait.mock.calls[0][3]).toMatchObject({ backendModel: 'gpt-6.1-terra' });
  });

  it('a bad effort value cannot break session start: it is dropped', async () => {
    mocks.systemConfig = { live_backend_model: 'gpt-6.1-terra', live_backend_reasoning_effort: 'lowest' };
    mocks.upstreamFetch.mockResolvedValue(healthy());
    await start().expect(201);
    expect(mintedSession().delegation.responses).not.toHaveProperty('reasoning');
  });

  it('a recovery start stays client-delegated with no backend, whatever is configured', async () => {
    mocks.systemConfig = { live_backend_model: 'gpt-6.1-terra', live_backend_reasoning_effort: 'low' };
    mocks.upstreamFetch.mockResolvedValue(healthy());
    await request(makeApp()).post('/api/live/session').send({ sdp: 'v=0 offer', recovery: true }).expect(201);
    expect(mintedSession().delegation).toEqual({ type: 'client' });
  });
});

// What a recovery session is created with (ai-therapist-293): its speak-first
// instruction rides in the session's startup input as a developer message (the
// documented greeting recipe), so the assistant comes back talking. It names
// the crisis line, says nothing about a dropped connection, and carries none of
// the conversation that was cut.
describe('POST /api/live/session recovery speak-first', () => {
  const healthy = () => upstream(200, { session: { id: 'sess_live_4' }, transport: { sdp: 'answer' } });
  const mintedSession = () =>
    JSON.parse((mocks.upstreamFetch.mock.calls[0][1] as RequestInit).body as string).session as {
      instructions: string;
      input?: Array<{ type: string; role: string; content: Array<{ type: string; text: string }> }>;
    };

  it('a recovery start is minted with one developer message: speak first, the crisis line, the truth', async () => {
    mocks.systemConfig = {
      crisis_contact: { hotline: '988 Suicide & Crisis Lifeline', phone: '988', text: 'HOME to 741741', enabled: true },
    };
    mocks.upstreamFetch.mockResolvedValue(healthy());
    await request(makeApp()).post('/api/live/session').send({ sdp: 'v=0 offer', recovery: true }).expect(201);

    const session = mintedSession();
    expect(session.input).toHaveLength(1);
    const [message] = session.input!;
    expect(message).toMatchObject({ type: 'message', role: 'developer' });
    const text = message.content[0].text;
    expect(message.content[0].type).toBe('input_text');
    expect(text).toMatch(/Speak first, immediately/);
    expect(text).toContain('988');
    expect(text).toContain('HOME to 741741');
    expect(text).not.toMatch(/connection (just )?dropped|technical drop/i);
    // The recovery prompt itself says the same thing and asks for the line aloud.
    expect(session.instructions).not.toMatch(/connection dropped/i);
    expect(session.instructions).toMatch(/say the crisis line out loud/);
  });

  it('falls back to the national lines when no crisis contact is configured', async () => {
    mocks.upstreamFetch.mockResolvedValue(healthy());
    await request(makeApp()).post('/api/live/session').send({ sdp: 'v=0 offer', recovery: true }).expect(201);
    const text = mintedSession().input![0].content[0].text;
    expect(text).toContain('988');
    expect(text).toContain('HOME to 741741');
  });

  it('an ordinary start has no startup input from this path', async () => {
    mocks.upstreamFetch.mockResolvedValue(healthy());
    await start().expect(201);
    expect(mintedSession()).not.toHaveProperty('input');
  });
});

// The pre-session check-in goes through the crisis pipeline at session start
// (PR 65). On GPT-Live that is after the sideband attach, so a steer has a
// socket to travel on.
describe('POST /api/live/session with a check-in', () => {
  const healthy = () => upstream(200, { session: { id: 'sess_live_ci' }, transport: { sdp: 'answer' } });
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('sends the check-in through the crisis pipeline on the realtime channel, after the sideband is attached', async () => {
    mocks.checkin = { mood: 1, topic: "I don't really want to be alive" };
    const order: string[] = [];
    mocks.connectAndWait.mockImplementation(async () => {
      order.push('attached');
    });
    mocks.runCheckinCrisisScreen.mockImplementation(async () => {
      order.push('screened');
      return { riskScore: 55 };
    });
    mocks.upstreamFetch.mockResolvedValue(healthy());

    await start().expect(201);
    await settle();

    expect(mocks.runCheckinCrisisScreen).toHaveBeenCalledTimes(1);
    expect(mocks.runCheckinCrisisScreen).toHaveBeenCalledWith('sess_live_ci', mocks.checkin, 'realtime');
    expect(order).toEqual(['attached', 'screened']);
  });

  it('no check-in: the pipeline is not called', async () => {
    mocks.upstreamFetch.mockResolvedValue(healthy());
    await start().expect(201);
    await settle();
    expect(mocks.runCheckinCrisisScreen).not.toHaveBeenCalled();
  });

  it('a recovery start does not re-score a check-in', async () => {
    mocks.checkin = { topic: 'anything' };
    mocks.upstreamFetch.mockResolvedValue(healthy());
    await request(makeApp()).post('/api/live/session').send({ sdp: 'v=0 offer', recovery: true }).expect(201);
    await settle();
    expect(mocks.runCheckinCrisisScreen).not.toHaveBeenCalled();
  });

  it('a failing screen never fails the session start', async () => {
    mocks.checkin = { topic: 'anything' };
    mocks.runCheckinCrisisScreen.mockRejectedValue(new Error('pipeline down'));
    mocks.upstreamFetch.mockResolvedValue(healthy());
    await start().expect(201);
    await settle();
  });
});
