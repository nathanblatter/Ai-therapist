// Unit coverage for the caseload enforcement middleware (docs/caseload-rbac.md).
// Load-bearing assertions: researcher/demo pass through untouched, assigned
// therapists get through, unassigned therapists get 404 (never 403), bad ids
// get 400, and null-owner sessions are 404 for therapists.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  isAssigned: vi.fn(),
  getSessionAccessInfo: vi.fn(),
  getMessageOwner: vi.fn(),
  getCareNoteById: vi.fn(),
  getEscalationById: vi.fn(),
  getOrganizationIdForUser: vi.fn(),
  getIrbStudyOrgId: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  isAssigned: mocks.isAssigned,
  getSessionAccessInfo: mocks.getSessionAccessInfo,
  getMessageOwner: mocks.getMessageOwner,
  getCareNoteById: mocks.getCareNoteById,
  getEscalationById: mocks.getEscalationById,
  getOrganizationIdForUser: mocks.getOrganizationIdForUser,
  getIrbStudyOrgId: mocks.getIrbStudyOrgId,
}));

import {
  requireClientAccess,
  requireSessionClientAccess,
  requireMessageClientAccess,
  requireEscalationAccess,
  careNoteBelongsToClient,
  therapistScopeId,
  canAdminAccessSessionLive,
} from './caseload.js';
import type { Request } from 'express';

function appAs(role: string | null, userId = 1) {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = role
      ? { userId, userRole: role, username: 'tester' }
      : {};
    next();
  });
  app.get('/users/:userId', requireClientAccess(), (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/clients/:clientId', requireClientAccess('clientId'), (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/sessions/:sessionId', requireSessionClientAccess(), (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/messages/:messageId', requireMessageClientAccess(), (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/s/:sid', requireSessionClientAccess('sid'), (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/escalations/:escalationId', requireEscalationAccess(), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

beforeEach(() => {
  mocks.isAssigned.mockReset().mockResolvedValue(false);
  mocks.getSessionAccessInfo.mockReset().mockResolvedValue(null);
});

describe('requireClientAccess', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(appAs(null)).get('/users/42');
    expect(res.status).toBe(401);
    expect(mocks.isAssigned).not.toHaveBeenCalled();
  });

  it('passes researcher through without touching the db', async () => {
    const res = await request(appAs('researcher')).get('/users/42');
    expect(res.status).toBe(200);
    expect(mocks.isAssigned).not.toHaveBeenCalled();
  });

  it('passes demo through without touching the db', async () => {
    const res = await request(appAs('demo')).get('/users/42');
    expect(res.status).toBe(200);
    expect(mocks.isAssigned).not.toHaveBeenCalled();
  });

  it('allows an assigned therapist', async () => {
    mocks.isAssigned.mockResolvedValue(true);
    const res = await request(appAs('therapist', 7)).get('/users/42');
    expect(res.status).toBe(200);
    expect(mocks.isAssigned).toHaveBeenCalledWith(7, 42);
  });

  it('returns 404 (not 403) for an unassigned therapist', async () => {
    mocks.isAssigned.mockResolvedValue(false);
    const res = await request(appAs('therapist')).get('/users/42');
    expect(res.status).toBe(404);
  });

  it('returns 400 for a non-numeric id', async () => {
    const res = await request(appAs('therapist')).get('/users/abc');
    expect(res.status).toBe(400);
    expect(mocks.isAssigned).not.toHaveBeenCalled();
  });

  it('respects a custom param name', async () => {
    mocks.isAssigned.mockResolvedValue(true);
    const res = await request(appAs('therapist', 9)).get('/clients/5');
    expect(res.status).toBe(200);
    expect(mocks.isAssigned).toHaveBeenCalledWith(9, 5);
  });
});

describe('requireSessionClientAccess', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(appAs(null)).get('/sessions/s1');
    expect(res.status).toBe(401);
  });

  it('passes researcher through without resolving the session', async () => {
    const res = await request(appAs('researcher')).get('/sessions/s1');
    expect(res.status).toBe(200);
    expect(mocks.getSessionAccessInfo).not.toHaveBeenCalled();
  });

  it('passes demo through without resolving the session', async () => {
    const res = await request(appAs('demo')).get('/sessions/s1');
    expect(res.status).toBe(200);
    expect(mocks.getSessionAccessInfo).not.toHaveBeenCalled();
  });

  it('returns 404 for a therapist when the session does not exist', async () => {
    mocks.getSessionAccessInfo.mockResolvedValue(null);
    const res = await request(appAs('therapist')).get('/sessions/missing');
    expect(res.status).toBe(404);
    expect(mocks.isAssigned).not.toHaveBeenCalled();
  });

  it('returns 404 for a therapist when the session has null user_id', async () => {
    mocks.getSessionAccessInfo.mockResolvedValue({
      status: 'active', user_id: null, session_type: 'text',
    });
    const res = await request(appAs('therapist')).get('/sessions/s1');
    expect(res.status).toBe(404);
    expect(mocks.isAssigned).not.toHaveBeenCalled();
  });

  it('allows a therapist assigned to the session owner', async () => {
    mocks.getSessionAccessInfo.mockResolvedValue({
      status: 'ended', user_id: 42, session_type: 'text',
    });
    mocks.isAssigned.mockResolvedValue(true);
    const res = await request(appAs('therapist', 7)).get('/sessions/s1');
    expect(res.status).toBe(200);
    expect(mocks.getSessionAccessInfo).toHaveBeenCalledWith('s1');
    expect(mocks.isAssigned).toHaveBeenCalledWith(7, 42);
  });

  it('returns 404 (not 403) for a therapist not assigned to the owner', async () => {
    mocks.getSessionAccessInfo.mockResolvedValue({
      status: 'ended', user_id: 42, session_type: 'text',
    });
    mocks.isAssigned.mockResolvedValue(false);
    const res = await request(appAs('therapist')).get('/sessions/s1');
    expect(res.status).toBe(404);
  });

  it('coerces string user_id from the db row', async () => {
    mocks.getSessionAccessInfo.mockResolvedValue({
      status: 'ended', user_id: '42', session_type: 'text',
    });
    mocks.isAssigned.mockResolvedValue(true);
    const res = await request(appAs('therapist', 7)).get('/sessions/s1');
    expect(res.status).toBe(200);
    expect(mocks.isAssigned).toHaveBeenCalledWith(7, 42);
  });

  it('respects a custom param name', async () => {
    mocks.getSessionAccessInfo.mockResolvedValue({
      status: 'ended', user_id: 42, session_type: 'text',
    });
    mocks.isAssigned.mockResolvedValue(true);
    const res = await request(appAs('therapist')).get('/s/sess-9');
    expect(res.status).toBe(200);
    expect(mocks.getSessionAccessInfo).toHaveBeenCalledWith('sess-9');
  });
});

describe('therapistScopeId', () => {
  function fakeReq(session: Record<string, unknown>): Request {
    return { session } as unknown as Request;
  }

  it('returns the therapist userId for therapist sessions', async () => {
    await expect(
      therapistScopeId(fakeReq({ userId: 7, userRole: 'therapist' }))
    ).resolves.toBe(7);
  });

  it('returns null for researcher', async () => {
    await expect(
      therapistScopeId(fakeReq({ userId: 7, userRole: 'researcher' }))
    ).resolves.toBeNull();
  });

  it('returns null for demo and for missing sessions', async () => {
    await expect(
      therapistScopeId(fakeReq({ userId: 7, userRole: 'demo' }))
    ).resolves.toBeNull();
    await expect(therapistScopeId(fakeReq({}))).resolves.toBeNull();
  });
});

describe('canAdminAccessSessionLive', () => {
  it('always allows researcher', async () => {
    await expect(canAdminAccessSessionLive('researcher', 7, null)).resolves.toBe(true);
    expect(mocks.isAssigned).not.toHaveBeenCalled();
  });

  it('allows therapist only when assigned', async () => {
    mocks.isAssigned.mockResolvedValue(true);
    await expect(canAdminAccessSessionLive('therapist', 7, 42)).resolves.toBe(true);
    expect(mocks.isAssigned).toHaveBeenCalledWith(7, 42);

    mocks.isAssigned.mockResolvedValue(false);
    await expect(canAdminAccessSessionLive('therapist', 7, 42)).resolves.toBe(false);
  });

  it('denies therapist for null session owner or missing admin id', async () => {
    await expect(canAdminAccessSessionLive('therapist', 7, null)).resolves.toBe(false);
    await expect(canAdminAccessSessionLive('therapist', undefined, 42)).resolves.toBe(false);
  });

  it('denies other and missing roles', async () => {
    await expect(canAdminAccessSessionLive('participant', 7, 42)).resolves.toBe(false);
    await expect(canAdminAccessSessionLive('demo', 7, 42)).resolves.toBe(false);
    await expect(canAdminAccessSessionLive(undefined, 7, 42)).resolves.toBe(false);
  });
});


describe('requireMessageClientAccess', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lets a researcher through without any db lookup', async () => {
    const res = await request(appAs('researcher')).get('/messages/12');
    expect(res.status).toBe(200);
    expect(mocks.getMessageOwner).not.toHaveBeenCalled();
  });

  it('lets an assigned therapist through', async () => {
    mocks.getMessageOwner.mockResolvedValue({ session_id: 's1', user_id: 7 });
    mocks.isAssigned.mockResolvedValue(true);
    const res = await request(appAs('therapist')).get('/messages/12');
    expect(res.status).toBe(200);
    expect(mocks.isAssigned).toHaveBeenCalledWith(1, 7);
  });

  it('404s an unassigned therapist', async () => {
    mocks.getMessageOwner.mockResolvedValue({ session_id: 's1', user_id: 7 });
    mocks.isAssigned.mockResolvedValue(false);
    const res = await request(appAs('therapist')).get('/messages/12');
    expect(res.status).toBe(404);
  });

  it('404s a therapist when the message or its owner is missing', async () => {
    mocks.getMessageOwner.mockResolvedValue(null);
    expect((await request(appAs('therapist')).get('/messages/12')).status).toBe(404);
    mocks.getMessageOwner.mockResolvedValue({ session_id: 's1', user_id: null });
    expect((await request(appAs('therapist')).get('/messages/13')).status).toBe(404);
  });

  it('400s a non-numeric message id for therapists', async () => {
    const res = await request(appAs('therapist')).get('/messages/abc');
    expect(res.status).toBe(400);
  });
});

describe('requireEscalationAccess researcher org gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEscalationById.mockResolvedValue({
      escalation_id: 11, org_id: 5, client_id: 42, raised_by: 8, assigned_to: null,
    });
  });

  it('passes a researcher whose org matches the escalation org', async () => {
    mocks.getOrganizationIdForUser.mockResolvedValue(5);
    const res = await request(appAs('researcher', 3)).get('/escalations/11');
    expect(res.status).toBe(200);
  });

  it('404s a researcher from another org', async () => {
    mocks.getOrganizationIdForUser.mockResolvedValue(6);
    const res = await request(appAs('researcher', 3)).get('/escalations/11');
    expect(res.status).toBe(404);
  });

  it('fails closed (500 via error handler) when the org lookup fails', async () => {
    mocks.getOrganizationIdForUser.mockRejectedValue(new Error('db down'));
    const res = await request(appAs('researcher', 3)).get('/escalations/11');
    expect(res.status).toBe(500);
  });
});

describe('careNoteBelongsToClient (escalation link check)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('true only when the note exists and matches the client', async () => {
    mocks.getCareNoteById.mockResolvedValue({ note_id: 3, client_id: 42, org_id: 5 });
    await expect(careNoteBelongsToClient(3, 42)).resolves.toBe(true);
    await expect(careNoteBelongsToClient(3, 43)).resolves.toBe(false);
    expect(mocks.getCareNoteById).toHaveBeenCalledWith(3);
  });

  it('false for a missing note', async () => {
    mocks.getCareNoteById.mockResolvedValue(null);
    await expect(careNoteBelongsToClient(999, 42)).resolves.toBe(false);
  });
});
