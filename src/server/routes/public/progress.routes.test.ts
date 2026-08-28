// Participant progress home routes (ai-therapist-121): every /api/me/*
// endpoint must require an authenticated session and resolve the user id ONLY
// from that session — a caller can never name another user via params, query,
// headers, or body.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  getOwnProgress: vi.fn(),
  getUserLatestSafetyPlan: vi.fn(),
  listUserWorksheetInstances: vi.fn(),
  listUserAssignments: vi.fn(),
  completeAssignment: vi.fn(),
  getMessageHistoryForClient: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);

// The route imports getMessageHistoryForClient through the barrel now; keep a
// single mock object aliased so existing assertions keep working.
const messagingMocks = dbMocks;

import progressRoutes from './progress.routes.js';

function appAs(userId: number | null, role = 'participant') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = (userId === null
      ? {}
      : { userId, userRole: role, username: 'someone' }) as unknown as typeof req.session;
    next();
  });
  app.use(progressRoutes());
  return app;
}

const PROGRESS = {
  session_count: 3,
  last_session_at: new Date('2026-08-10T12:00:00Z'),
  scale_history: [{ scale: 'phq2', score: 2, created_at: new Date('2026-08-10T12:00:00Z'), session_id: 's1' }],
  mood_trajectory: [{ date: new Date('2026-08-10T11:00:00Z'), source: 'checkin', mood: 6 }],
  weekly_sessions: [{ week_start: new Date('2026-08-03T00:00:00Z'), sessions: 2 }],
  has_safety_plan: true,
};

const ASSIGNMENT = {
  id: 5,
  user_id: 7,
  session_id: 's1',
  title: 'Two-minute breathing',
  description: 'Before bed.',
  kind: 'exercise',
  suggested_frequency: 'daily',
  status: 'assigned',
  assigned_at: new Date('2026-08-09T00:00:00Z'),
  completed_at: null,
  completion_note: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.listUserAssignments.mockResolvedValue([ASSIGNMENT]);
  dbMocks.completeAssignment.mockResolvedValue({
    ...ASSIGNMENT, status: 'completed', completed_at: new Date('2026-08-12T00:00:00Z'), completion_note: 'went ok',
  });
  dbMocks.getOwnProgress.mockResolvedValue(PROGRESS);
  dbMocks.getUserLatestSafetyPlan.mockResolvedValue({
    plan: { warning_signs: ['x'] },
    created_at: new Date('2026-08-01T00:00:00Z'),
    session_id: 's1',
  });
  dbMocks.listUserWorksheetInstances.mockResolvedValue([
    {
      instance_id: 9,
      title: 'My worry plan',
      template_title: null,
      intro: null,
      sections: [{ type: 'textarea', label: 'What happened?' }],
      responses: { s0: 'wrote a thing' },
      status: 'completed',
      created_at: new Date('2026-08-05T00:00:00Z'),
      completed_at: new Date('2026-08-05T00:10:00Z'),
    },
  ]);
  messagingMocks.getMessageHistoryForClient.mockResolvedValue([
    {
      thread_id: 1,
      clinician_role: 'caseworker',
      status: 'active',
      created_at: '2026-08-01T00:00:00Z',
      last_message_at: '2026-08-02T00:00:00Z',
      messages: [
        { message_id: 5, sender_role: 'participant', body: 'checking in', created_at: '2026-08-02T00:00:00Z', flagged: false },
      ],
    },
  ]);
});

describe('auth is required on every /api/me/* endpoint', () => {
  it.each(['/api/me/progress', '/api/me/safety-plan', '/api/me/worksheets', '/api/me/assignments', '/api/me/export'])(
    'GET %s without a session returns 401 and touches no db function',
    async (path) => {
      const res = await request(appAs(null)).get(path);
      expect(res.status).toBe(401);
      expect(dbMocks.getOwnProgress).not.toHaveBeenCalled();
      expect(dbMocks.getUserLatestSafetyPlan).not.toHaveBeenCalled();
      expect(dbMocks.listUserWorksheetInstances).not.toHaveBeenCalled();
      expect(dbMocks.listUserAssignments).not.toHaveBeenCalled();
      expect(messagingMocks.getMessageHistoryForClient).not.toHaveBeenCalled();
    }
  );

  it('POST /api/me/assignments/:id/complete without a session returns 401', async () => {
    const res = await request(appAs(null)).post('/api/me/assignments/5/complete').send({});
    expect(res.status).toBe(401);
    expect(dbMocks.completeAssignment).not.toHaveBeenCalled();
  });
});

describe('self-scoping: user id comes from the session, never the request', () => {
  it('GET /api/me/progress ignores query/header/body attempts to name user B', async () => {
    const res = await request(appAs(7))
      .get('/api/me/progress?userId=999&user_id=999')
      .set('X-User-Id', '999')
      .send({ userId: 999 });
    expect(res.status).toBe(200);
    expect(dbMocks.getOwnProgress).toHaveBeenCalledTimes(1);
    expect(dbMocks.getOwnProgress).toHaveBeenCalledWith(7);
  });

  it('GET /api/me/safety-plan resolves the session user only', async () => {
    const res = await request(appAs(7)).get('/api/me/safety-plan?userId=999');
    expect(res.status).toBe(200);
    expect(dbMocks.getUserLatestSafetyPlan).toHaveBeenCalledWith(7);
  });

  it('GET /api/me/worksheets resolves the session user only', async () => {
    const res = await request(appAs(7)).get('/api/me/worksheets?userId=999');
    expect(res.status).toBe(200);
    expect(dbMocks.listUserWorksheetInstances).toHaveBeenCalledWith(7);
  });

  it('GET /api/me/assignments resolves the session user only', async () => {
    const res = await request(appAs(7)).get('/api/me/assignments?userId=999');
    expect(res.status).toBe(200);
    expect(dbMocks.listUserAssignments).toHaveBeenCalledWith(7, { limit: 50 });
  });

  it('POST /api/me/assignments/:id/complete is scoped to the session user (cross-user completion blocked)', async () => {
    // The route always passes the SESSION user's id; a guessed id belonging
    // to another user comes back null from the scoped UPDATE -> 404.
    dbMocks.completeAssignment.mockResolvedValue(null);
    const res = await request(appAs(7)).post('/api/me/assignments/123/complete').send({ note: 'done' });
    expect(res.status).toBe(404);
    expect(dbMocks.completeAssignment).toHaveBeenCalledWith(123, 7, 'done');
  });

  it('there is no path variant that accepts a user id (param probing 404s)', async () => {
    for (const path of ['/api/me/progress/999', '/api/me/worksheets/999', '/api/me/safety-plan/999']) {
      const res = await request(appAs(7)).get(path);
      expect(res.status).toBe(404);
    }
    expect(dbMocks.getOwnProgress).not.toHaveBeenCalled();
    expect(dbMocks.getUserLatestSafetyPlan).not.toHaveBeenCalled();
    expect(dbMocks.listUserWorksheetInstances).not.toHaveBeenCalled();
  });
});

describe('response shapes', () => {
  it('GET /api/me/progress returns the composed progress payload', async () => {
    const res = await request(appAs(7)).get('/api/me/progress');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      session_count: 3,
      has_safety_plan: true,
    });
    expect(Array.isArray(res.body.scale_history)).toBe(true);
    expect(Array.isArray(res.body.mood_trajectory)).toBe(true);
    expect(Array.isArray(res.body.weekly_sessions)).toBe(true);
    // Clinical framing stays admin-side: no memories/case profile here.
    expect(res.body).not.toHaveProperty('memories');
    expect(res.body).not.toHaveProperty('case_profile');
    expect(res.body).not.toHaveProperty('prior_crisis_flags');
  });

  it('GET /api/me/safety-plan wraps the plan (and passes null through)', async () => {
    const res = await request(appAs(7)).get('/api/me/safety-plan');
    expect(res.status).toBe(200);
    expect(res.body.safety_plan.plan.warning_signs).toEqual(['x']);

    dbMocks.getUserLatestSafetyPlan.mockResolvedValue(null);
    const none = await request(appAs(7)).get('/api/me/safety-plan');
    expect(none.status).toBe(200);
    expect(none.body.safety_plan).toBeNull();
  });

  it('GET /api/me/worksheets returns the list with status and dates', async () => {
    const res = await request(appAs(7)).get('/api/me/worksheets');
    expect(res.status).toBe(200);
    expect(res.body.worksheets).toHaveLength(1);
    expect(res.body.worksheets[0]).toMatchObject({
      instance_id: 9,
      title: 'My worry plan',
      status: 'completed',
    });
    expect(res.body.worksheets[0].created_at).toBeTruthy();
  });

  it('GET /api/me/assignments returns the list', async () => {
    const res = await request(appAs(7)).get('/api/me/assignments');
    expect(res.status).toBe(200);
    expect(res.body.assignments).toHaveLength(1);
    expect(res.body.assignments[0]).toMatchObject({
      id: 5,
      title: 'Two-minute breathing',
      status: 'assigned',
    });
  });

  it('POST /api/me/assignments/:id/complete returns the completed row and trims/caps the note', async () => {
    const res = await request(appAs(7))
      .post('/api/me/assignments/5/complete')
      .send({ note: `  ${'x'.repeat(600)}  ` });
    expect(res.status).toBe(200);
    expect(res.body.assignment.status).toBe('completed');
    const note = dbMocks.completeAssignment.mock.calls[0][2] as string;
    expect(note).toHaveLength(500);
  });

  it('POST /api/me/assignments/:id/complete passes a null note when absent or blank', async () => {
    await request(appAs(7)).post('/api/me/assignments/5/complete').send({});
    expect(dbMocks.completeAssignment).toHaveBeenCalledWith(5, 7, null);
    await request(appAs(7)).post('/api/me/assignments/5/complete').send({ note: '   ' });
    expect(dbMocks.completeAssignment).toHaveBeenLastCalledWith(5, 7, null);
  });

  it('POST /api/me/assignments/:id/complete rejects a non-numeric id', async () => {
    const res = await request(appAs(7)).post('/api/me/assignments/abc/complete').send({});
    expect(res.status).toBe(400);
    expect(dbMocks.completeAssignment).not.toHaveBeenCalled();
  });

  // Participant data export (caseworker portal spec section 10 item 8):
  // message history is included, self-scoped, participant-tier fields only.
  it('GET /api/me/export includes the full message history alongside the self-surface data', async () => {
    const res = await request(appAs(7)).get('/api/me/export?userId=999');
    expect(res.status).toBe(200);
    // Self-scoping: every source resolves the SESSION user.
    expect(messagingMocks.getMessageHistoryForClient).toHaveBeenCalledWith(7);
    expect(dbMocks.getOwnProgress).toHaveBeenCalledWith(7);
    expect(res.headers['content-disposition']).toContain('my-data-export.json');
    expect(res.body.exported_at).toBeTruthy();
    expect(res.body.message_threads).toHaveLength(1);
    expect(res.body.message_threads[0].messages[0]).toMatchObject({
      sender_role: 'participant',
      body: 'checking in',
      flagged: false,
    });
    // Participant tier: no risk scores anywhere in the export payload.
    expect(JSON.stringify(res.body)).not.toContain('risk_score');
    expect(res.body).toMatchObject({
      progress: { session_count: 3 },
      worksheets: expect.any(Array),
      assignments: expect.any(Array),
    });
  });

  it('GET /api/me/export returns a generic 500 when the message-history query fails', async () => {
    messagingMocks.getMessageHistoryForClient.mockRejectedValue(new Error('pg exploded'));
    const res = await request(appAs(7)).get('/api/me/export');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to build data export' });
  });

  it('db failures return 500 with a generic error (no internals leaked)', async () => {
    dbMocks.getOwnProgress.mockRejectedValue(new Error('pg exploded: secret dsn'));
    const res = await request(appAs(7)).get('/api/me/progress');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch progress' });
  });
});
