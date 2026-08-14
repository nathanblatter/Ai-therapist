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
    req.session = role
      ? ({ userId: 1, userRole: role, user: { username: 'tester' } } as unknown as typeof req.session)
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
});
