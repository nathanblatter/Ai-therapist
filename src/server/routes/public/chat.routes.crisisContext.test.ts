// /api/chat/message: when is a keyword-free turn assessed BEFORE the reply
// (ai-therapist-299), and what happens to the reply when the assessor is slow.
//
//   keyword hit                       inline, as before
//   keyword-free, context needed      inline, capped at 6 seconds
//   keyword-free, calm session        deferred until the response has shipped
//
// "Context needed" is decided by needsContextAssessment (a context-dependent
// signal in the message, or a session already flagged / recently risk-bearing).
// The cap exists because the assessor sits on the reply path here: a call that
// is timing out (10s per attempt) or being retried must not hold the
// participant's reply, and must still finish, flag and page in the background.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  insertMessagesBatch: vi.fn(),
  getSessionAccessInfo: vi.fn(),
  sendMessage: vi.fn(),
  injectGuidance: vi.fn(),
  keywordScore: vi.fn(),
  needsContextAssessment: vi.fn(),
  runCrisisPipeline: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  insertMessagesBatch: mocks.insertMessagesBatch,
  getSessionAccessInfo: mocks.getSessionAccessInfo,
  isDemoAccountSession: vi.fn(),
  isSandboxAccountSession: vi.fn(),
  getRecentSessionMessages: vi.fn(),
}));
vi.mock('../../utils/sessionHelpers.js', () => ({}));
vi.mock('../../utils/promptContext.js', () => ({}));
vi.mock('../../services/toolRegistry.service.js', () => ({ toolRegistry: {} }));
vi.mock('../../middleware/consent.js', () => ({
  requireConsent: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../utils/adminBroadcast.js', () => ({
  broadcastAdminEvent: vi.fn().mockResolvedValue(undefined),
  broadcastAdminEventForSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/sessionName.service.js', () => ({ generateSessionNameAsync: vi.fn() }));
vi.mock('../../services/chatTherapy.service.js', () => ({
  sendMessage: mocks.sendMessage,
  injectGuidance: mocks.injectGuidance,
  isChatSessionUnavailableError: () => false,
}));
vi.mock('../../services/minorSafeguard.service.js', () => ({
  detectMinorDisclosurePatterns: () => ({ matched: false }),
}));
vi.mock('../../services/crisisDetection.service.js', () => ({
  detectCrisisKeywords: () => ({ keywordScore: mocks.keywordScore() }),
  needsContextAssessment: mocks.needsContextAssessment,
}));
vi.mock('../../services/crisisPipeline.service.js', () => ({ runCrisisPipeline: mocks.runCrisisPipeline }));
vi.mock('../../utils/harness.js', () => ({ isNonStudyUser: () => false }));

import chatRoutes from './chat.routes.js';

const SESSION = 'chat_ctx';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = {
      consentAccepted: true,
      consentVersion: 'v-test',
      ownedSessions: [SESSION],
    } as unknown as typeof req.session;
    Object.defineProperty(req, 'sessionID', { value: 'AnonSid', configurable: true });
    next();
  });
  app.use(chatRoutes());
  return app;
}

const send = (message: string) => request(makeApp()).post('/api/chat/message').send({ sessionId: SESSION, message });
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
/** Yield to I/O without touching (possibly faked) setTimeout. */
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !condition(); i++) await tick();
  expect(condition()).toBe(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionAccessInfo.mockResolvedValue({ status: 'active', user_id: null, session_type: 'chat' });
  mocks.insertMessagesBatch.mockResolvedValue([{ message_id: 42 }]);
  mocks.sendMessage.mockResolvedValue({ text: 'reply', toolEvents: [] });
  mocks.keywordScore.mockReturnValue(0);
  mocks.needsContextAssessment.mockResolvedValue(false);
  mocks.runCrisisPipeline.mockResolvedValue({ steeringGuidance: null });
  (globalThis as { io?: unknown }).io = { to: () => ({ emit: () => {} }) };
});
afterEach(() => vi.useRealTimers());

describe('keyword-free turn that needs context (flagged session, or a context signal)', () => {
  it('is assessed before the reply, and its steer reaches the model call that answers it', async () => {
    mocks.needsContextAssessment.mockResolvedValue(true);
    mocks.runCrisisPipeline.mockResolvedValue({ steeringGuidance: 'HIGH_STEER' });
    const order: string[] = [];
    mocks.injectGuidance.mockImplementation(() => void order.push('inject'));
    mocks.sendMessage.mockImplementation(async () => {
      order.push('model');
      return { text: 'reply', toolEvents: [] };
    });

    const res = await send("I'm going to do it tonight, I've decided.");

    expect(res.status).toBe(200);
    expect(mocks.needsContextAssessment).toHaveBeenCalledWith(SESSION, "I'm going to do it tonight, I've decided.");
    expect(mocks.runCrisisPipeline).toHaveBeenCalledTimes(1);
    expect(mocks.runCrisisPipeline).toHaveBeenCalledWith(
      { sessionId: SESSION, messageId: 42, content: "I'm going to do it tonight, I've decided." },
      'chat',
    );
    expect(mocks.injectGuidance).toHaveBeenCalledWith(SESSION, 'HIGH_STEER');
    expect(order).toEqual(['inject', 'model']);
  });

  it('does not hold the reply past 6 seconds for a slow assessor; detection finishes in the background', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.needsContextAssessment.mockResolvedValue(true);
    let finishPipeline: (r: { steeringGuidance: string | null }) => void = () => {};
    mocks.runCrisisPipeline.mockReturnValue(
      new Promise((resolve) => {
        finishPipeline = resolve;
      }),
    );

    const pending = send('tonight').then((res) => res);
    // Let the request reach the race, then pass the deadline.
    await until(() => mocks.runCrisisPipeline.mock.calls.length === 1);
    for (let i = 0; i < 20; i++) await tick();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5999);
    for (let i = 0; i < 20; i++) await tick();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();

    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body.response).toBe('reply');
    // The reply went out unsteered...
    expect(mocks.injectGuidance).not.toHaveBeenCalled();

    // ...and when the pipeline does finish, its steer is queued for the next turn.
    finishPipeline({ steeringGuidance: 'LATE_STEER' });
    await flush();
    expect(mocks.injectGuidance).toHaveBeenCalledWith(SESSION, 'LATE_STEER');
    // Never a second pipeline run for the same turn.
    expect(mocks.runCrisisPipeline).toHaveBeenCalledTimes(1);
  });

  it('assesses the turn anyway when the context check itself throws: detection is never skipped', async () => {
    mocks.needsContextAssessment.mockRejectedValue(new Error('boom'));
    mocks.runCrisisPipeline.mockResolvedValue({ steeringGuidance: 'STEER' });

    const res = await send('tonight');

    expect(res.status).toBe(200);
    expect(mocks.runCrisisPipeline).toHaveBeenCalledTimes(1);
    expect(mocks.injectGuidance).toHaveBeenCalledWith(SESSION, 'STEER');
  });

  it('replies without steering when the pipeline itself rejects', async () => {
    mocks.needsContextAssessment.mockResolvedValue(true);
    mocks.runCrisisPipeline.mockRejectedValue(new Error('boom'));

    const res = await send('tonight');

    expect(res.status).toBe(200);
    expect(mocks.injectGuidance).not.toHaveBeenCalled();
  });
});

describe('unchanged paths', () => {
  it('a calm keyword-free turn is still scored only after the response has shipped', async () => {
    let pipelineRanBeforeModel = false;
    mocks.sendMessage.mockImplementation(async () => {
      pipelineRanBeforeModel = mocks.runCrisisPipeline.mock.calls.length > 0;
      return { text: 'reply', toolEvents: [] };
    });

    const res = await send('tell me about breathing exercises');
    await flush();

    expect(res.status).toBe(200);
    expect(pipelineRanBeforeModel).toBe(false);
    expect(mocks.runCrisisPipeline).toHaveBeenCalledTimes(1);
  });

  it('a keyword turn is assessed inline without consulting the context check', async () => {
    mocks.keywordScore.mockReturnValue(75);
    mocks.runCrisisPipeline.mockResolvedValue({ steeringGuidance: 'KEYWORD_STEER' });

    const res = await send('I want to end my life');

    expect(res.status).toBe(200);
    expect(mocks.needsContextAssessment).not.toHaveBeenCalled();
    expect(mocks.injectGuidance).toHaveBeenCalledWith(SESSION, 'KEYWORD_STEER');
  });
});
