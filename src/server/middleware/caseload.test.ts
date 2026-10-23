// Unit coverage for the caseload enforcement middleware (docs/caseload-rbac.md).
// Load-bearing assertions: demo passes through untouched, researchers are
// organization-scoped (same-org 200, cross-org 404, anonymous sessions only
// for the irb-study org — ai-therapist-269), assigned therapists get through,
// unassigned therapists get 404 (never 403), bad ids get 400, and null-owner
// sessions are 404 for therapists.
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
  requireBodyClientAccess,
  requireEscalationAccess,
  careNoteBelongsToClient,
  therapistScopeId,
  canAdminAccessSessionLive,
  mayCareTeamAccessSession,
} from './caseload.js';
import type { Request } from 'express';

// Researcher org fixtures (ai-therapist-269): the caller's org is stamped on
// the session (as login does), so getOrganizationIdForUser only ever resolves
// the TARGET participant in these tests.
const IRB_ORG = 1;
const PRACTICE_ORG = 2;

function appAs(role: string | null, userId = 1, orgId?: number) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = role
      ? { userId, userRole: role, username: 'tester', ...(orgId === undefined ? {} : { orgId }) }
      : {};
    next();
  });
  app.post('/escalate', requireBodyClientAccess('client_id'), (_req, res) => {
    res.json({ ok: true });
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
  mocks.getMessageOwner.mockReset().mockResolvedValue(null);
  mocks.getOrganizationIdForUser.mockReset().mockResolvedValue(null);
  mocks.getIrbStudyOrgId.mockReset().mockResolvedValue(IRB_ORG);
});

describe('requireClientAccess', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(appAs(null)).get('/users/42');
    expect(res.status).toBe(401);
    expect(mocks.isAssigned).not.toHaveBeenCalled();
  });

  it('passes a researcher whose org matches the target participant (one users lookup, no caseload)', async () => {
    mocks.getOrganizationIdForUser.mockResolvedValue(PRACTICE_ORG);
    const res = await request(appAs('researcher', 3, PRACTICE_ORG)).get('/users/42');
    expect(res.status).toBe(200);
    expect(mocks.getOrganizationIdForUser).toHaveBeenCalledTimes(1);
    expect(mocks.getOrganizationIdForUser).toHaveBeenCalledWith(42);
    expect(mocks.isAssigned).not.toHaveBeenCalled();
  });

  it('404s (not 403) a researcher for a participant in another org', async () => {
    mocks.getOrganizationIdForUser.mockResolvedValue(IRB_ORG);
    const res = await request(appAs('researcher', 3, PRACTICE_ORG)).get('/users/42');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('404s a researcher for a participant that does not exist (no org to match)', async () => {
    mocks.getOrganizationIdForUser.mockResolvedValue(null);
    const res = await request(appAs('researcher', 3, PRACTICE_ORG)).get('/users/42');
    expect(res.status).toBe(404);
  });

  it('resolves a researcher session without a cached orgId via the users table, then compares', async () => {
    // No session.orgId: orgIdFor looks the caller up (userId 3 -> org 2),
    // then the target (42 -> org 2).
    mocks.getOrganizationIdForUser.mockImplementation(async (id: number) => (id === 3 ? PRACTICE_ORG : id === 42 ? PRACTICE_ORG : null));
    const res = await request(appAs('researcher', 3)).get('/users/42');
    expect(res.status).toBe(200);
  });

  it('fails closed (500) for a researcher when the org lookup throws', async () => {
    mocks.getOrganizationIdForUser.mockRejectedValue(new Error('db down'));
    const res = await request(appAs('researcher', 3, PRACTICE_ORG)).get('/users/42');
    expect(res.status).toBe(500);
  });

  it('returns 400 for a researcher on a non-numeric id', async () => {
    const res = await request(appAs('researcher', 3, PRACTICE_ORG)).get('/users/abc');
    expect(res.status).toBe(400);
    expect(mocks.getOrganizationIdForUser).not.toHaveBeenCalled();
  });

  it('passes demo through without touching the db', async () => {
    const res = await request(appAs('demo')).get('/users/42');
    expect(res.status).toBe(200);
    expect(mocks.isAssigned).not.toHaveBeenCalled();
    expect(mocks.getOrganizationIdForUser).not.toHaveBeenCalled();
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

  it('passes a researcher when the session owner is in their org (one session query, no users lookup)', async () => {
    mocks.getSessionAccessInfo.mockResolvedValue({
      status: 'ended', user_id: 42, session_type: 'text', owner_organization_id: PRACTICE_ORG,
    });
    const res = await request(appAs('researcher', 3, PRACTICE_ORG)).get('/sessions/s1');
    expect(res.status).toBe(200);
    expect(mocks.getSessionAccessInfo).toHaveBeenCalledWith('s1');
    expect(mocks.getOrganizationIdForUser).not.toHaveBeenCalled();
    expect(mocks.isAssigned).not.toHaveBeenCalled();
  });

  it('404s (not 403) a researcher when the session owner is in another org', async () => {
    mocks.getSessionAccessInfo.mockResolvedValue({
      status: 'ended', user_id: 42, session_type: 'text', owner_organization_id: IRB_ORG,
    });
    const res = await request(appAs('researcher', 3, PRACTICE_ORG)).get('/sessions/s1');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('404s a researcher when the session does not exist', async () => {
    mocks.getSessionAccessInfo.mockResolvedValue(null);
    const res = await request(appAs('researcher', 3, PRACTICE_ORG)).get('/sessions/missing');
    expect(res.status).toBe(404);
  });

  it('404s a researcher when the owner org is unresolved (dangling owner row)', async () => {
    mocks.getSessionAccessInfo.mockResolvedValue({
      status: 'ended', user_id: 42, session_type: 'text', owner_organization_id: null,
    });
    const res = await request(appAs('researcher', 3, PRACTICE_ORG)).get('/sessions/s1');
    expect(res.status).toBe(404);
  });

  it('anonymous session (null user_id): visible only to a researcher in the irb-study org', async () => {
    mocks.getSessionAccessInfo.mockResolvedValue({
      status: 'active', user_id: null, session_type: 'text', owner_organization_id: null,
    });
    const irb = await request(appAs('researcher', 3, IRB_ORG)).get('/sessions/s1');
    expect(irb.status).toBe(200);
    const practice = await request(appAs('researcher', 3, PRACTICE_ORG)).get('/sessions/s1');
    expect(practice.status).toBe(404);
    expect(mocks.getOrganizationIdForUser).not.toHaveBeenCalled();
  });

  it('anonymous session fails closed when the irb-study org cannot be resolved', async () => {
    mocks.getIrbStudyOrgId.mockResolvedValue(null);
    mocks.getSessionAccessInfo.mockResolvedValue({
      status: 'active', user_id: null, session_type: 'text', owner_organization_id: null,
    });
    const res = await request(appAs('researcher', 3, IRB_ORG)).get('/sessions/s1');
    expect(res.status).toBe(404);
  });

  it('fails closed (500) for a researcher when the session lookup throws', async () => {
    mocks.getSessionAccessInfo.mockRejectedValue(new Error('db down'));
    const res = await request(appAs('researcher', 3, PRACTICE_ORG)).get('/sessions/s1');
    expect(res.status).toBe(500);
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
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getIrbStudyOrgId.mockResolvedValue(IRB_ORG);
  });

  it('allows a researcher when the session owner is in their org (owner org pre-loaded, no lookup)', async () => {
    await expect(canAdminAccessSessionLive('researcher', 7, 42, PRACTICE_ORG, PRACTICE_ORG)).resolves.toBe(true);
    expect(mocks.isAssigned).not.toHaveBeenCalled();
    expect(mocks.getOrganizationIdForUser).not.toHaveBeenCalled();
  });

  it('denies a researcher when the session owner is in another org', async () => {
    await expect(canAdminAccessSessionLive('researcher', 7, 42, PRACTICE_ORG, IRB_ORG)).resolves.toBe(false);
  });

  it('looks the owner org up when the caller did not pre-load it', async () => {
    mocks.getOrganizationIdForUser.mockResolvedValue(PRACTICE_ORG);
    await expect(canAdminAccessSessionLive('researcher', 7, 42, PRACTICE_ORG)).resolves.toBe(true);
    expect(mocks.getOrganizationIdForUser).toHaveBeenCalledWith(42);
    mocks.getOrganizationIdForUser.mockResolvedValue(IRB_ORG);
    await expect(canAdminAccessSessionLive('researcher', 7, 42, PRACTICE_ORG)).resolves.toBe(false);
  });

  it('anonymous session: a researcher gets in only from the irb-study org', async () => {
    await expect(canAdminAccessSessionLive('researcher', 7, null, IRB_ORG, null)).resolves.toBe(true);
    await expect(canAdminAccessSessionLive('researcher', 7, null, PRACTICE_ORG, null)).resolves.toBe(false);
  });

  it('fails closed for a researcher with no resolvable org', async () => {
    await expect(canAdminAccessSessionLive('researcher', 7, 42, null, PRACTICE_ORG)).resolves.toBe(false);
    await expect(canAdminAccessSessionLive('researcher', 7, null, null, null)).resolves.toBe(false);
    expect(mocks.getIrbStudyOrgId).not.toHaveBeenCalled();
  });

  it('allows therapist only when assigned (org ignored)', async () => {
    mocks.isAssigned.mockResolvedValue(true);
    await expect(canAdminAccessSessionLive('therapist', 7, 42, IRB_ORG, PRACTICE_ORG)).resolves.toBe(true);
    expect(mocks.isAssigned).toHaveBeenCalledWith(7, 42);

    mocks.isAssigned.mockResolvedValue(false);
    await expect(canAdminAccessSessionLive('therapist', 7, 42, PRACTICE_ORG, PRACTICE_ORG)).resolves.toBe(false);
  });

  it('denies therapist for null session owner or missing admin id', async () => {
    await expect(canAdminAccessSessionLive('therapist', 7, null, IRB_ORG, null)).resolves.toBe(false);
    await expect(canAdminAccessSessionLive('therapist', undefined, 42, IRB_ORG, IRB_ORG)).resolves.toBe(false);
  });

  it('denies caseworker, other and missing roles even in-org', async () => {
    await expect(canAdminAccessSessionLive('caseworker', 7, 42, IRB_ORG, IRB_ORG)).resolves.toBe(false);
    await expect(canAdminAccessSessionLive('participant', 7, 42, IRB_ORG, IRB_ORG)).resolves.toBe(false);
    await expect(canAdminAccessSessionLive('demo', 7, 42, IRB_ORG, IRB_ORG)).resolves.toBe(false);
    await expect(canAdminAccessSessionLive(undefined, 7, 42, IRB_ORG, IRB_ORG)).resolves.toBe(false);
    expect(mocks.isAssigned).not.toHaveBeenCalled();
  });
});

describe('mayCareTeamAccessSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getIrbStudyOrgId.mockResolvedValue(IRB_ORG);
  });
  const assigned = { caseworkerPolicy: 'assigned' as const };

  it('researcher: same-org owner passes, cross-org owner is denied (one session lookup)', async () => {
    mocks.getSessionAccessInfo.mockResolvedValue({ status: 'active', user_id: 42, owner_organization_id: PRACTICE_ORG });
    await expect(mayCareTeamAccessSession('researcher', 3, 's1', { ...assigned, callerOrgId: PRACTICE_ORG })).resolves.toBe(true);
    await expect(mayCareTeamAccessSession('researcher', 3, 's1', { ...assigned, callerOrgId: IRB_ORG })).resolves.toBe(false);
    expect(mocks.getSessionAccessInfo).toHaveBeenCalledTimes(2);
    expect(mocks.getOrganizationIdForUser).not.toHaveBeenCalled();
    expect(mocks.isAssigned).not.toHaveBeenCalled();
  });

  it('researcher: anonymous session is irb-study custody', async () => {
    mocks.getSessionAccessInfo.mockResolvedValue({ status: 'active', user_id: null, owner_organization_id: null });
    await expect(mayCareTeamAccessSession('researcher', 3, 's1', { ...assigned, callerOrgId: IRB_ORG })).resolves.toBe(true);
    await expect(mayCareTeamAccessSession('researcher', 3, 's1', { ...assigned, callerOrgId: PRACTICE_ORG })).resolves.toBe(false);
  });

  it('researcher: missing session or unresolved caller org is a deny', async () => {
    mocks.getSessionAccessInfo.mockResolvedValue(null);
    await expect(mayCareTeamAccessSession('researcher', 3, 's1', { ...assigned, callerOrgId: IRB_ORG })).resolves.toBe(false);
    mocks.getSessionAccessInfo.mockResolvedValue({ status: 'active', user_id: 42, owner_organization_id: IRB_ORG });
    await expect(mayCareTeamAccessSession('researcher', 3, 's1', { ...assigned, callerOrgId: null })).resolves.toBe(false);
  });

  it('demo passes without any lookup; care-team branches ignore the org', async () => {
    await expect(mayCareTeamAccessSession('demo', 3, 's1', { ...assigned, callerOrgId: null })).resolves.toBe(true);
    expect(mocks.getSessionAccessInfo).not.toHaveBeenCalled();

    mocks.getSessionAccessInfo.mockResolvedValue({ status: 'active', user_id: 42, owner_organization_id: PRACTICE_ORG });
    mocks.isAssigned.mockResolvedValue(true);
    await expect(mayCareTeamAccessSession('therapist', 3, 's1', { ...assigned, callerOrgId: IRB_ORG })).resolves.toBe(true);
    expect(mocks.isAssigned).toHaveBeenCalledWith(3, 42);
    await expect(mayCareTeamAccessSession('caseworker', 3, 's1', { caseworkerPolicy: 'deny', callerOrgId: PRACTICE_ORG })).resolves.toBe(false);
  });
});


describe('requireMessageClientAccess', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lets a researcher through when the owning participant is in their org (one message query)', async () => {
    mocks.getMessageOwner.mockResolvedValue({ session_id: 's1', user_id: 7, owner_organization_id: PRACTICE_ORG });
    const res = await request(appAs('researcher', 3, PRACTICE_ORG)).get('/messages/12');
    expect(res.status).toBe(200);
    expect(mocks.getMessageOwner).toHaveBeenCalledWith(12);
    expect(mocks.getOrganizationIdForUser).not.toHaveBeenCalled();
    expect(mocks.isAssigned).not.toHaveBeenCalled();
  });

  it('404s a researcher when the owning participant is in another org', async () => {
    mocks.getMessageOwner.mockResolvedValue({ session_id: 's1', user_id: 7, owner_organization_id: IRB_ORG });
    const res = await request(appAs('researcher', 3, PRACTICE_ORG)).get('/messages/12');
    expect(res.status).toBe(404);
  });

  it('404s a researcher when the message is missing', async () => {
    mocks.getMessageOwner.mockResolvedValue(null);
    const res = await request(appAs('researcher', 3, PRACTICE_ORG)).get('/messages/12');
    expect(res.status).toBe(404);
  });

  it('anonymous-session message: visible only to a researcher in the irb-study org', async () => {
    mocks.getMessageOwner.mockResolvedValue({ session_id: 's1', user_id: null, owner_organization_id: null });
    expect((await request(appAs('researcher', 3, IRB_ORG)).get('/messages/12')).status).toBe(200);
    expect((await request(appAs('researcher', 3, PRACTICE_ORG)).get('/messages/12')).status).toBe(404);
  });

  it('400s a non-numeric message id for researchers', async () => {
    const res = await request(appAs('researcher', 3, PRACTICE_ORG)).get('/messages/abc');
    expect(res.status).toBe(400);
    expect(mocks.getMessageOwner).not.toHaveBeenCalled();
  });

  it('lets demo through without any db lookup', async () => {
    const res = await request(appAs('demo')).get('/messages/12');
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

describe('requireBodyClientAccess', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401s when unauthenticated and 400s a missing client id for everyone', async () => {
    expect((await request(appAs(null)).post('/escalate').send({ client_id: 42 })).status).toBe(401);
    expect((await request(appAs('researcher', 3, PRACTICE_ORG)).post('/escalate').send({})).status).toBe(400);
    expect((await request(appAs('therapist')).post('/escalate').send({ client_id: 'x' })).status).toBe(400);
    expect(mocks.getOrganizationIdForUser).not.toHaveBeenCalled();
    expect(mocks.isAssigned).not.toHaveBeenCalled();
  });

  it('passes a researcher whose org matches the body client', async () => {
    mocks.getOrganizationIdForUser.mockResolvedValue(PRACTICE_ORG);
    const res = await request(appAs('researcher', 3, PRACTICE_ORG)).post('/escalate').send({ client_id: 42 });
    expect(res.status).toBe(200);
    expect(mocks.getOrganizationIdForUser).toHaveBeenCalledWith(42);
    expect(mocks.isAssigned).not.toHaveBeenCalled();
  });

  it('404s (not 403) a researcher for a body client in another org', async () => {
    mocks.getOrganizationIdForUser.mockResolvedValue(IRB_ORG);
    const res = await request(appAs('researcher', 3, PRACTICE_ORG)).post('/escalate').send({ client_id: 42 });
    expect(res.status).toBe(404);
  });

  it('fails closed (500) for a researcher when the org lookup throws', async () => {
    mocks.getOrganizationIdForUser.mockRejectedValue(new Error('db down'));
    const res = await request(appAs('researcher', 3, PRACTICE_ORG)).post('/escalate').send({ client_id: 42 });
    expect(res.status).toBe(500);
  });

  it('keeps the care-team caseload check (assigned 200, unassigned 404, no org lookup)', async () => {
    mocks.isAssigned.mockResolvedValue(true);
    expect((await request(appAs('caseworker', 7)).post('/escalate').send({ client_id: 42 })).status).toBe(200);
    expect(mocks.isAssigned).toHaveBeenCalledWith(7, 42);
    mocks.isAssigned.mockResolvedValue(false);
    expect((await request(appAs('therapist', 7)).post('/escalate').send({ client_id: 42 })).status).toBe(404);
    expect(mocks.getOrganizationIdForUser).not.toHaveBeenCalled();
  });

  it('passes demo through without any lookup', async () => {
    const res = await request(appAs('demo')).post('/escalate').send({ client_id: 42 });
    expect(res.status).toBe(200);
    expect(mocks.getOrganizationIdForUser).not.toHaveBeenCalled();
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
