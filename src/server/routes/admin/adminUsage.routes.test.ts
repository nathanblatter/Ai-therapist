// Route coverage for the de-identified admin usage telemetry ingest: the
// core promise is that NO identity reaches the row (only the role cohort),
// resource ids are templated out, and the flag gate is enforced server-side.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

const { insertAdminUsageEventsMock, getSystemConfigMock } = vi.hoisted(() => ({
  insertAdminUsageEventsMock: vi.fn(),
  getSystemConfigMock: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  insertAdminUsageEvents: insertAdminUsageEventsMock,
  // clientEvents.routes.ts (imported for capDetail) also pulls from db/index.
  insertClientEvent: vi.fn(),
}));

vi.mock('../../utils/sessionHelpers.js', () => ({
  getSystemConfig: getSystemConfigMock,
}));

import adminUsageRoutes, { templatePath } from './adminUsage.routes.js';

const USAGE_ID = '123e4567-e89b-42d3-a456-426614174000';

function appAs(role: string | null, userId: number | null = 7) {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
  app.use((req, _res, next) => {
    if (userId !== null) req.session.userId = userId;
    if (role !== null) req.session.userRole = role;
    next();
  });
  app.use(adminUsageRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  insertAdminUsageEventsMock.mockResolvedValue(undefined);
  getSystemConfigMock.mockResolvedValue({ features: { telemetry_admin_usage: true } });
});

describe('templatePath', () => {
  it('replaces numeric ids, uuids, and app session ids', () => {
    expect(templatePath('/admin/api/users/42/sessions')).toBe('/admin/api/users/:id/sessions');
    expect(templatePath(`/admin/api/sessions/${USAGE_ID}`)).toBe('/admin/api/sessions/:id');
    expect(templatePath('/api/sessions/sess_abc123/audio')).toBe('/api/sessions/:id/audio');
    expect(templatePath('/admin/api/work-queue?status=open&user=9')).toBe('/admin/api/work-queue');
  });

  it('returns null for non-strings', () => {
    expect(templatePath(42)).toBeNull();
    expect(templatePath(undefined)).toBeNull();
  });
});

describe('POST /admin/api/usage-events', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await request(appAs(null, null))
      .post('/admin/api/usage-events')
      .send({ usageSessionId: USAGE_ID, events: [{ kind: 'view_open', detail: { view: 'sessions' } }] });
    expect(res.status).toBe(401);
    expect(insertAdminUsageEventsMock).not.toHaveBeenCalled();
  });

  it('rejects participant-role callers', async () => {
    const res = await request(appAs('participant'))
      .post('/admin/api/usage-events')
      .send({ usageSessionId: USAGE_ID, events: [{ kind: 'view_open' }] });
    expect(res.status).toBe(403);
  });

  it('stores role but NEVER the userId (the de-identification promise)', async () => {
    await request(appAs('researcher', 99))
      .post('/admin/api/usage-events')
      .send({ usageSessionId: USAGE_ID, events: [{ kind: 'view_open', seq: 0, detail: { view: 'sessions' } }] });
    const rows = insertAdminUsageEventsMock.mock.calls[0][0];
    expect(rows[0]).toEqual({
      usageSessionId: USAGE_ID,
      seq: 0,
      role: 'researcher',
      kind: 'view_open',
      detail: { view: 'sessions' },
    });
    expect(JSON.stringify(rows)).not.toContain('99');
  });

  it('drops everything with 204 when the flag is off', async () => {
    getSystemConfigMock.mockResolvedValue({ features: { telemetry_admin_usage: false } });
    const res = await request(appAs('researcher'))
      .post('/admin/api/usage-events')
      .send({ usageSessionId: USAGE_ID, events: [{ kind: 'view_open' }] });
    expect(res.status).toBe(204);
    expect(insertAdminUsageEventsMock).not.toHaveBeenCalled();
  });

  it('drops batches without a valid uuid usageSessionId', async () => {
    const res = await request(appAs('researcher'))
      .post('/admin/api/usage-events')
      .send({ usageSessionId: 'kimberly-monday', events: [{ kind: 'view_open' }] });
    expect(res.status).toBe(204);
    expect(insertAdminUsageEventsMock).not.toHaveBeenCalled();
  });

  it('strips disallowed detail keys and templates api_error paths', async () => {
    await request(appAs('therapist'))
      .post('/admin/api/usage-events')
      .send({
        usageSessionId: USAGE_ID,
        events: [
          { kind: 'api_error', detail: { path: '/admin/api/users/42', status: 500, userId: 7, participant: 'kim' } },
          { kind: 'view_heartbeat', detail: { view: 'live', visible_ms: 61234.7, sessionId: 'sess_abc' } },
        ],
      });
    const rows = insertAdminUsageEventsMock.mock.calls[0][0];
    expect(rows[0].detail).toEqual({ path: '/admin/api/users/:id', status: 500 });
    expect(rows[1].detail).toEqual({ view: 'live', visible_ms: 61235 });
  });

  it('skips unknown kinds silently', async () => {
    await request(appAs('researcher'))
      .post('/admin/api/usage-events')
      .send({ usageSessionId: USAGE_ID, events: [{ kind: 'keystrokes' }, { kind: 'overlay_open', detail: { overlay: 'session_detail' } }] });
    const rows = insertAdminUsageEventsMock.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('overlay_open');
  });

  it('still returns 204 when the insert fails (beacons are fire-and-forget)', async () => {
    insertAdminUsageEventsMock.mockRejectedValueOnce(new Error('db down'));
    const res = await request(appAs('caseworker'))
      .post('/admin/api/usage-events')
      .send({ usageSessionId: USAGE_ID, events: [{ kind: 'view_open', detail: { view: 'triage' } }] });
    expect(res.status).toBe(204);
  });
});
