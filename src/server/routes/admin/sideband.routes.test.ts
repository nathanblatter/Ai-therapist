// Route tests for the admin trigger-tool control (ai-therapist-103):
// validation against the enabled-tool registry, sideband-connection guard,
// role guard, and the forced-call + audit-log happy path.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../config/db.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn(), on: vi.fn() },
}));

const dbMocks = vi.hoisted(() => ({
  getActiveSidebandSessions: vi.fn().mockResolvedValue([]),
  logSidebandAction: vi.fn().mockResolvedValue(undefined),
  // Caseload middleware/guard deps (ai-therapist-119).
  isAssigned: vi.fn().mockResolvedValue(true),
  getSessionAccessInfo: vi.fn().mockResolvedValue({ status: 'active', user_id: 42, session_type: 'realtime' }),
  getCaseloadClientIds: vi.fn().mockResolvedValue([42]),
}));
vi.mock('../../db/index.js', () => dbMocks);

const sidebandMocks = vi.hoisted(() => ({
  isConnected: vi.fn().mockReturnValue(true),
  triggerTool: vi.fn().mockResolvedValue(undefined),
  updateSession: vi.fn().mockResolvedValue(undefined),
  injectMessage: vi.fn().mockResolvedValue(undefined),
  createResponse: vi.fn().mockResolvedValue(undefined),
  interrupt: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  getActiveConnections: vi.fn().mockReturnValue([]),
}));
vi.mock('../../services/sidebandManager.service.js', () => ({ sidebandManager: sidebandMocks }));

const registryMocks = vi.hoisted(() => ({
  getEnabledToolDefinitions: vi.fn().mockResolvedValue([
    { type: 'function', name: 'start_breathing_exercise', description: '', parameters: {} },
    { type: 'function', name: 'end_session', description: '', parameters: {} },
  ]),
}));
vi.mock('../../services/toolRegistry.service.js', () => ({ toolRegistry: registryMocks }));

import sidebandRoutes from './sideband.routes.js';

function appAs(role: string | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Mirrors the real login session shape (auth.routes.ts): username is
    // stored directly on the session, NOT under a nested user object.
    req.session = role
      ? ({ userId: 1, userRole: role, username: 'tester' } as unknown as typeof req.session)
      : ({} as unknown as typeof req.session);
    next();
  });
  app.use(sidebandRoutes());
  return app;
}

const SESSION_ID = 'sess-abc-123';

beforeEach(() => {
  Object.values(dbMocks).forEach(m => m.mockClear());
  Object.values(sidebandMocks).forEach(m => m.mockClear());
  registryMocks.getEnabledToolDefinitions.mockClear();
  sidebandMocks.isConnected.mockReturnValue(true);
  dbMocks.isAssigned.mockResolvedValue(true);
  dbMocks.getSessionAccessInfo.mockResolvedValue({ status: 'active', user_id: 42, session_type: 'realtime' });
  dbMocks.getCaseloadClientIds.mockResolvedValue([42]);
});

describe('caseload enforcement (ai-therapist-119)', () => {
  it('404s an unassigned therapist on the :sessionId update-instructions route', async () => {
    dbMocks.isAssigned.mockResolvedValue(false);
    const res = await request(appAs('therapist'))
      .post(`/admin/api/sessions/${SESSION_ID}/update-instructions`)
      .send({ instructions: 'be gentler' });
    expect(res.status).toBe(404);
    expect(sidebandMocks.updateSession).not.toHaveBeenCalled();
  });

  it('404s an unassigned therapist on body-addressed sideband controls', async () => {
    dbMocks.isAssigned.mockResolvedValue(false);
    await request(appAs('therapist'))
      .post('/admin/api/sideband/trigger-tool')
      .send({ sessionId: SESSION_ID, toolName: 'start_breathing_exercise' })
      .expect(404);
    await request(appAs('therapist'))
      .post('/admin/api/sideband/inject')
      .send({ sessionId: SESSION_ID, text: 'hello' })
      .expect(404);
    await request(appAs('therapist'))
      .post('/admin/api/sideband/disconnect')
      .send({ sessionId: SESSION_ID })
      .expect(404);
    expect(sidebandMocks.triggerTool).not.toHaveBeenCalled();
    expect(sidebandMocks.injectMessage).not.toHaveBeenCalled();
    expect(sidebandMocks.disconnect).not.toHaveBeenCalled();
  });

  it('404s a therapist targeting a session with no owner (null user_id)', async () => {
    dbMocks.getSessionAccessInfo.mockResolvedValue({ status: 'active', user_id: null, session_type: 'realtime' });
    await request(appAs('therapist'))
      .post('/admin/api/sideband/interrupt')
      .send({ sessionId: SESSION_ID })
      .expect(404);
    expect(dbMocks.isAssigned).not.toHaveBeenCalled();
  });

  it('leaves researchers unscoped on body-addressed controls', async () => {
    dbMocks.isAssigned.mockResolvedValue(false);
    await request(appAs('researcher'))
      .post('/admin/api/sideband/disconnect')
      .send({ sessionId: SESSION_ID })
      .expect(200);
    expect(dbMocks.getSessionAccessInfo).not.toHaveBeenCalled();
  });

  it('filters the sideband status list to the therapist caseload', async () => {
    dbMocks.getActiveSidebandSessions.mockResolvedValueOnce([
      { session_id: 'mine', sideband_connected: true, status: 'active' },
      { session_id: 'not-mine', sideband_connected: true, status: 'active' },
    ]);
    dbMocks.getSessionAccessInfo.mockImplementation(async (id: string) => ({
      status: 'active',
      user_id: id === 'mine' ? 42 : 99,
      session_type: 'realtime',
    }));
    const res = await request(appAs('therapist')).get('/admin/api/sideband/status');
    expect(res.status).toBe(200);
    expect(res.body.sessions.map((s: { session_id: string }) => s.session_id)).toEqual(['mine']);
  });
});

describe('POST /admin/api/sideband/trigger-tool', () => {
  it('requires an authenticated therapist/researcher', async () => {
    await request(appAs(null))
      .post('/admin/api/sideband/trigger-tool')
      .send({ sessionId: SESSION_ID, toolName: 'start_breathing_exercise' })
      .expect(401);
    await request(appAs('participant'))
      .post('/admin/api/sideband/trigger-tool')
      .send({ sessionId: SESSION_ID, toolName: 'start_breathing_exercise' })
      .expect(403);
    expect(sidebandMocks.triggerTool).not.toHaveBeenCalled();
  });

  it('rejects missing sessionId or toolName', async () => {
    const app = appAs('therapist');
    await request(app).post('/admin/api/sideband/trigger-tool').send({ toolName: 'start_breathing_exercise' }).expect(400);
    await request(app).post('/admin/api/sideband/trigger-tool').send({ sessionId: SESSION_ID }).expect(400);
    await request(app).post('/admin/api/sideband/trigger-tool').send({ sessionId: SESSION_ID, toolName: '   ' }).expect(400);
    expect(sidebandMocks.triggerTool).not.toHaveBeenCalled();
  });

  it('rejects non-object args', async () => {
    await request(appAs('therapist'))
      .post('/admin/api/sideband/trigger-tool')
      .send({ sessionId: SESSION_ID, toolName: 'start_breathing_exercise', args: [1, 2] })
      .expect(400);
    expect(sidebandMocks.triggerTool).not.toHaveBeenCalled();
  });

  it('rejects tools not in the enabled registry (unknown or disabled)', async () => {
    const res = await request(appAs('therapist'))
      .post('/admin/api/sideband/trigger-tool')
      .send({ sessionId: SESSION_ID, toolName: 'not_a_tool' })
      .expect(400);
    expect(res.body.error).toBe('Unknown or disabled tool');
    expect(res.body.available).toContain('start_breathing_exercise');
    expect(sidebandMocks.triggerTool).not.toHaveBeenCalled();
  });

  it('rejects when the session has no active sideband connection', async () => {
    sidebandMocks.isConnected.mockReturnValue(false);
    await request(appAs('therapist'))
      .post('/admin/api/sideband/trigger-tool')
      .send({ sessionId: SESSION_ID, toolName: 'start_breathing_exercise' })
      .expect(400);
    expect(sidebandMocks.triggerTool).not.toHaveBeenCalled();
  });

  it('triggers the tool and audit-logs the action', async () => {
    const args = { duration_seconds: 90 };
    const res = await request(appAs('researcher'))
      .post('/admin/api/sideband/trigger-tool')
      .send({ sessionId: SESSION_ID, toolName: 'start_breathing_exercise', args })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(sidebandMocks.triggerTool).toHaveBeenCalledWith(SESSION_ID, 'start_breathing_exercise', args);
    expect(dbMocks.logSidebandAction).toHaveBeenCalledWith(
      SESSION_ID,
      'Admin triggered tool start_breathing_exercise via sideband',
      expect.objectContaining({ action: 'trigger_tool', tool: 'start_breathing_exercise', args, admin_user: 'tester' }),
    );
  });

  it('allows end_session server-side (confirm is client-side only)', async () => {
    await request(appAs('therapist'))
      .post('/admin/api/sideband/trigger-tool')
      .send({ sessionId: SESSION_ID, toolName: 'end_session' })
      .expect(200);
    expect(sidebandMocks.triggerTool).toHaveBeenCalledWith(SESSION_ID, 'end_session', undefined);
  });

  it('returns 500 when the sideband send fails', async () => {
    sidebandMocks.triggerTool.mockRejectedValueOnce(new Error('WS gone'));
    await request(appAs('therapist'))
      .post('/admin/api/sideband/trigger-tool')
      .send({ sessionId: SESSION_ID, toolName: 'start_breathing_exercise' })
      .expect(500);
    expect(dbMocks.logSidebandAction).not.toHaveBeenCalled();
  });

  it('returns 409 (not success) when a model response is already in flight', async () => {
    sidebandMocks.triggerTool.mockRejectedValueOnce(new Error(
      'conversation_already_has_active_response: the model is still responding; wait for the current response to finish and retry',
    ));
    const res = await request(appAs('therapist'))
      .post('/admin/api/sideband/trigger-tool')
      .send({ sessionId: SESSION_ID, toolName: 'start_breathing_exercise' })
      .expect(409);
    expect(res.body.error).toBe('Model response in progress');
    expect(dbMocks.logSidebandAction).not.toHaveBeenCalled();
  });
});

describe('audit attribution (admin_user from the real session shape)', () => {
  // The login session stores username directly (req.session.username); the
  // audit rows must never log admin_user: undefined.
  it.each([
    ['inject', '/admin/api/sideband/inject', { sessionId: SESSION_ID, text: 'steer' }],
    ['interrupt', '/admin/api/sideband/interrupt', { sessionId: SESSION_ID }],
    ['respond', '/admin/api/sideband/respond', { sessionId: SESSION_ID }],
    ['update-session', '/admin/api/sideband/update-session', { sessionId: SESSION_ID, instructions: 'be brief' }],
    ['disconnect', '/admin/api/sideband/disconnect', { sessionId: SESSION_ID }],
  ])('%s logs admin_user from req.session.username', async (_name, path, body) => {
    await request(appAs('therapist')).post(path).send(body).expect(200);
    expect(dbMocks.logSidebandAction).toHaveBeenCalledWith(
      SESSION_ID,
      expect.any(String),
      expect.objectContaining({ admin_user: 'tester' }),
    );
  });
});
