// Auth coverage for the risk-context sharing toggle route (ai-therapist-91).
// The write route was widened from therapist-only to therapist+researcher so
// the researcher-only Users tab can drive it; participants must still be denied.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { setEnabledMock, isAssignedMock, getSessionAccessInfoMock } = vi.hoisted(() => ({
  setEnabledMock: vi.fn(),
  isAssignedMock: vi.fn(),
  getSessionAccessInfoMock: vi.fn(),
}));
vi.mock('../../db/index.js', () => ({
  getSessionInsights: vi.fn(),
  markSoapReviewed: vi.fn(),
  getSessionSafetyPlan: vi.fn(),
  getSessionScaleResponses: vi.fn(),
  setSessionNotesForNextSession: vi.fn(),
  setUserRiskContextEnabled: setEnabledMock,
  // Caseload middleware deps (ai-therapist-119).
  isAssigned: isAssignedMock,
  getSessionAccessInfo: getSessionAccessInfoMock,
}));

import insightsRoutes from './insights.routes.js';

function appAs(role: string | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Stand in for the real session middleware.
    (req as unknown as { session: Record<string, unknown> }).session = role
      ? { userId: 1, userRole: role, username: 'tester' }
      : {};
    next();
  });
  app.use(insightsRoutes());
  return app;
}

beforeEach(() => {
  setEnabledMock.mockReset();
  isAssignedMock.mockReset().mockResolvedValue(true);
  getSessionAccessInfoMock.mockReset().mockResolvedValue({ status: 'ended', user_id: 42, session_type: 'realtime' });
});

describe('POST /admin/api/users/:userId/risk-context auth', () => {
  it('allows a researcher to flip the flag', async () => {
    setEnabledMock.mockResolvedValueOnce(undefined);
    const res = await request(appAs('researcher')).post('/admin/api/users/42/risk-context').send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, enabled: true });
    expect(setEnabledMock).toHaveBeenCalledWith(42, true);
  });

  it('allows a therapist to flip the flag (unchanged behavior)', async () => {
    setEnabledMock.mockResolvedValueOnce(undefined);
    const res = await request(appAs('therapist')).post('/admin/api/users/42/risk-context').send({ enabled: false });
    expect(res.status).toBe(200);
    expect(setEnabledMock).toHaveBeenCalledWith(42, false);
  });

  it('denies a participant with 403', async () => {
    const res = await request(appAs('participant')).post('/admin/api/users/42/risk-context').send({ enabled: true });
    expect(res.status).toBe(403);
    expect(setEnabledMock).not.toHaveBeenCalled();
  });

  it('denies an unauthenticated request with 401', async () => {
    const res = await request(appAs(null)).post('/admin/api/users/42/risk-context').send({ enabled: true });
    expect(res.status).toBe(401);
    expect(setEnabledMock).not.toHaveBeenCalled();
  });

  it('404s a therapist whose caseload does not include the user (ai-therapist-119)', async () => {
    isAssignedMock.mockResolvedValue(false);
    const res = await request(appAs('therapist')).post('/admin/api/users/42/risk-context').send({ enabled: true });
    expect(res.status).toBe(404);
    expect(isAssignedMock).toHaveBeenCalledWith(1, 42);
    expect(setEnabledMock).not.toHaveBeenCalled();
  });

  it('does not consult the caseload for researchers', async () => {
    isAssignedMock.mockResolvedValue(false);
    setEnabledMock.mockResolvedValueOnce(undefined);
    const res = await request(appAs('researcher')).post('/admin/api/users/42/risk-context').send({ enabled: true });
    expect(res.status).toBe(200);
    expect(isAssignedMock).not.toHaveBeenCalled();
  });
});

describe('caseload enforcement on :sessionId insights routes (ai-therapist-119)', () => {
  it('404s an unassigned therapist before the handler runs', async () => {
    isAssignedMock.mockResolvedValue(false);
    const res = await request(appAs('therapist')).get('/admin/api/sessions/sess-1/insights');
    expect(res.status).toBe(404);
    expect(isAssignedMock).toHaveBeenCalledWith(1, 42);
  });

  it('404s a therapist when the session does not exist', async () => {
    getSessionAccessInfoMock.mockResolvedValue(null);
    const res = await request(appAs('therapist')).post('/admin/api/sessions/sess-1/insights/review');
    expect(res.status).toBe(404);
    expect(isAssignedMock).not.toHaveBeenCalled();
  });
});
