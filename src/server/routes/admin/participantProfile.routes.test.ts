// Auth + shape coverage for the participant-profile admin API
// (ai-therapist-110). The profile bundle is therapist-only (unredacted
// clinical content, same rule as session insights); the session history is
// therapist+researcher like the main session browser.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getUserProfileBundle: vi.fn(),
  getSessionScoreExtras: vi.fn(),
  listSessions: vi.fn(),
  countSessions: vi.fn(),
  recordLlmUsage: vi.fn(),
  openaiCreate: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  getUserById: mocks.getUserById,
  getUserProfileBundle: mocks.getUserProfileBundle,
  getSessionScoreExtras: mocks.getSessionScoreExtras,
  listSessions: mocks.listSessions,
  countSessions: mocks.countSessions,
  recordLlmUsage: mocks.recordLlmUsage,
}));

vi.mock('../../config/secrets.js', () => ({
  getOpenAIKey: vi.fn().mockResolvedValue('test-key'),
}));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: mocks.openaiCreate } };
  },
}));

import participantProfileRoutes, { _clearBriefCache } from './participantProfile.routes.js';

function appAs(role: string | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = role
      ? { userId: 1, userRole: role, username: 'tester' }
      : {};
    next();
  });
  app.use(participantProfileRoutes());
  return app;
}

const EMPTY_BUNDLE = {
  memory_enabled: true,
  risk_context_share_enabled: false,
  summaries: [],
  ended_session_count: 2,
  memories: [{ fact: 'Prefers morning sessions', session_id: 's1', created_at: new Date().toISOString() }],
  case_profile: null,
  scale_history: [],
  mood_trajectory: [],
  safety_plan: null,
  thought_record: null,
  clinician_note: null,
  prior_crisis_flags: [],
};

beforeEach(() => {
  mocks.getUserById.mockReset().mockResolvedValue({
    userid: 42, username: 'p42', role: 'participant',
    preferred_voice: 'cedar', preferred_language: 'en', mfa_enabled: false,
    created_at: new Date('2026-01-01'),
  });
  mocks.getUserProfileBundle.mockReset().mockResolvedValue(EMPTY_BUNDLE);
  mocks.getSessionScoreExtras.mockReset().mockResolvedValue([]);
  mocks.listSessions.mockReset().mockResolvedValue([]);
  mocks.countSessions.mockReset().mockResolvedValue(0);
  mocks.recordLlmUsage.mockReset().mockResolvedValue(undefined);
  mocks.openaiCreate.mockReset().mockResolvedValue({
    choices: [{ message: { content: 'Doing steadily better since the last review.' } }],
    usage: { prompt_tokens: 120, completion_tokens: 60 },
  });
  _clearBriefCache();
});

describe('GET /admin/api/users/:userId/profile auth', () => {
  it('returns the bundle plus account header fields for a therapist', async () => {
    const res = await request(appAs('therapist')).get('/admin/api/users/42/profile');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ userid: 42, username: 'p42', role: 'participant' });
    expect(res.body.memory_enabled).toBe(true);
    expect(res.body.ended_session_count).toBe(2);
    expect(res.body.memories).toHaveLength(1);
    expect(mocks.getUserProfileBundle).toHaveBeenCalledWith(42);
  });

  it('denies a researcher with 403 (unredacted clinical content)', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/users/42/profile');
    expect(res.status).toBe(403);
    expect(mocks.getUserProfileBundle).not.toHaveBeenCalled();
  });

  it('denies a participant with 403 and anonymous with 401', async () => {
    expect((await request(appAs('participant')).get('/admin/api/users/42/profile')).status).toBe(403);
    expect((await request(appAs(null)).get('/admin/api/users/42/profile')).status).toBe(401);
  });

  it('404s for an unknown user and 400s for a garbage id', async () => {
    mocks.getUserById.mockResolvedValue(null);
    expect((await request(appAs('therapist')).get('/admin/api/users/999/profile')).status).toBe(404);
    expect((await request(appAs('therapist')).get('/admin/api/users/abc/profile')).status).toBe(400);
  });
});

describe('GET /admin/api/users/:userId/sessions', () => {
  it('filters by user and merges eval score + feedback rating', async () => {
    mocks.listSessions.mockResolvedValue([
      { session_id: 's1', session_name: 'First chat' },
      { session_id: 's2', session_name: null },
    ]);
    mocks.countSessions.mockResolvedValue(2);
    mocks.getSessionScoreExtras.mockResolvedValue([
      { session_id: 's1', eval_score: 4.2, feedback_rating: 5 },
    ]);

    const res = await request(appAs('researcher')).get('/admin/api/users/42/sessions');

    expect(res.status).toBe(200);
    expect(mocks.listSessions).toHaveBeenCalledWith(expect.objectContaining({ userId: 42 }));
    expect(mocks.countSessions).toHaveBeenCalledWith(expect.objectContaining({ userId: 42 }));
    expect(res.body.sessions[0]).toMatchObject({ session_id: 's1', eval_score: 4.2, feedback_rating: 5 });
    expect(res.body.sessions[1]).toMatchObject({ session_id: 's2', eval_score: null, feedback_rating: null });
    expect(res.body.pagination.totalCount).toBe(2);
  });

  it('is open to therapists too, but not participants', async () => {
    expect((await request(appAs('therapist')).get('/admin/api/users/42/sessions')).status).toBe(200);
    expect((await request(appAs('participant')).get('/admin/api/users/42/sessions')).status).toBe(403);
  });
});

describe('GET /admin/api/users/:userId/brief (ai-therapist-122)', () => {
  it('is therapist-only: 403 for researcher/participant, 401 anonymous', async () => {
    expect((await request(appAs('researcher')).get('/admin/api/users/42/brief')).status).toBe(403);
    expect((await request(appAs('participant')).get('/admin/api/users/42/brief')).status).toBe(403);
    expect((await request(appAs(null)).get('/admin/api/users/42/brief')).status).toBe(401);
    expect(mocks.openaiCreate).not.toHaveBeenCalled();
  });

  it('404s for an unknown user and 400s for a garbage id', async () => {
    mocks.getUserById.mockResolvedValue(null);
    expect((await request(appAs('therapist')).get('/admin/api/users/999/brief')).status).toBe(404);
    expect((await request(appAs('therapist')).get('/admin/api/users/abc/brief')).status).toBe(400);
  });

  it('generates a brief from the bundle and records LLM usage', async () => {
    const res = await request(appAs('therapist')).get('/admin/api/users/42/brief');
    expect(res.status).toBe(200);
    expect(res.body.brief).toBe('Doing steadily better since the last review.');
    expect(mocks.openaiCreate).toHaveBeenCalledTimes(1);
    expect(mocks.recordLlmUsage).toHaveBeenCalledWith(null, 'insights', 'gpt-4o-mini', 120, 60);
  });

  it('serves repeat views from cache, but a new latest session regenerates', async () => {
    await request(appAs('therapist')).get('/admin/api/users/42/brief');
    const cached = await request(appAs('therapist')).get('/admin/api/users/42/brief');
    expect(cached.status).toBe(200);
    expect(cached.body).toMatchObject({ brief: 'Doing steadily better since the last review.', cached: true });
    expect(mocks.openaiCreate).toHaveBeenCalledTimes(1);

    // A newly ended session changes the cache key and regenerates.
    mocks.getUserProfileBundle.mockResolvedValue({
      ...EMPTY_BUNDLE,
      ended_session_count: 3,
      summaries: [{
        session_id: 's-new', session_name: 'New session', ended_at: new Date(), created_at: new Date(),
        summary: { headline: 'New headline', topics: ['sleep'], mood_trajectory: 'improving', follow_up: 'Keep the wind-down routine.' },
      }],
    });
    const fresh = await request(appAs('therapist')).get('/admin/api/users/42/brief');
    expect(fresh.status).toBe(200);
    expect(fresh.body.cached).toBeUndefined();
    expect(mocks.openaiCreate).toHaveBeenCalledTimes(2);
  });

  it('returns a null brief without calling the model when there is nothing to summarize', async () => {
    mocks.getUserProfileBundle.mockResolvedValue({ ...EMPTY_BUNDLE, ended_session_count: 0, summaries: [] });
    const res = await request(appAs('therapist')).get('/admin/api/users/42/brief');
    expect(res.status).toBe(200);
    expect(res.body.brief).toBeNull();
    expect(mocks.openaiCreate).not.toHaveBeenCalled();
  });

  it('fails soft: an LLM error still returns 200 with a null brief and does not poison the cache', async () => {
    mocks.openaiCreate.mockRejectedValueOnce(new Error('model down'));
    const res = await request(appAs('therapist')).get('/admin/api/users/42/brief');
    expect(res.status).toBe(200);
    expect(res.body.brief).toBeNull();

    // Next request retries and succeeds.
    const retry = await request(appAs('therapist')).get('/admin/api/users/42/brief');
    expect(retry.body.brief).toBe('Doing steadily better since the last review.');
    expect(mocks.openaiCreate).toHaveBeenCalledTimes(2);
  });
});
