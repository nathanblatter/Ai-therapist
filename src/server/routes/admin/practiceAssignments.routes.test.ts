// Clinician homework API tests (ai-therapist-200): role matrix (caseworker
// 403, participant 403, anonymous 401), therapist caseload 404, researcher
// org-scoping 404, validation 400s, lifecycle 409s, and the audit row every
// write appends.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  // practiceAssignments.queries
  listAssignmentsForClient: vi.fn(),
  createAssignment: vi.fn(),
  updateAssignment: vi.fn(),
  cancelAssignment: vi.fn(),
  reissueAssignment: vi.fn(),
  // users / audit
  getUserById: vi.fn(),
  insertCaseloadAudit: vi.fn(),
  // imported by middleware/caseload.ts + middleware/org.ts
  isAssigned: vi.fn(),
  getSessionAccessInfo: vi.fn(),
  getMessageOwner: vi.fn(),
  getCareNoteById: vi.fn(),
  getEscalationById: vi.fn(),
  getOrganizationIdForUser: vi.fn(),
  getIrbStudyOrgId: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);

import practiceAssignmentsRoutes from './practiceAssignments.routes.js';

const CLIENT = { userid: 42, username: 'p42', role: 'participant', organization_id: 5, is_sandbox: false };

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 7, user_id: 42, session_id: null, title: 'Worry log', description: 'Note each worry.',
    kind: 'worksheet', suggested_frequency: 'daily', status: 'assigned',
    assigned_at: '2026-10-20T00:00:00Z', completed_at: null, completion_note: null,
    source: 'therapist', authored_by: 9, cancelled_at: null, cancelled_by: null,
    cancel_reason: null, reissued_from: null,
    ...overrides,
  };
}

function appAs(role: string | null, userId = 9, orgId: number | null = 5) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = role
      ? { userId, userRole: role, username: `user${userId}`, ...(orgId === null ? {} : { orgId }) }
      : {};
    next();
  });
  app.use(practiceAssignmentsRoutes());
  return app;
}

const VALID = { title: 'Worry log', description: 'Note each worry.', kind: 'worksheet', suggested_frequency: 'daily' };

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.isAssigned.mockResolvedValue(true);
  dbMocks.getUserById.mockResolvedValue(CLIENT);
  dbMocks.getOrganizationIdForUser.mockResolvedValue(5);
  dbMocks.insertCaseloadAudit.mockResolvedValue(undefined);
  dbMocks.listAssignmentsForClient.mockResolvedValue([row()]);
  dbMocks.createAssignment.mockResolvedValue(row());
  dbMocks.updateAssignment.mockResolvedValue(row({ title: 'Edited' }));
  dbMocks.cancelAssignment.mockResolvedValue(row({ status: 'cancelled', cancel_reason: 'superseded' }));
  dbMocks.reissueAssignment.mockResolvedValue(row({ id: 8, reissued_from: 7 }));
});

describe('role matrix', () => {
  it('401 anonymous', async () => {
    expect((await request(appAs(null)).get('/admin/api/clients/42/assignments')).status).toBe(401);
  });

  it('403 caseworker on every route (never writes clinical content)', async () => {
    const app = appAs('caseworker', 2);
    expect((await request(app).get('/admin/api/clients/42/assignments')).status).toBe(403);
    expect((await request(app).post('/admin/api/clients/42/assignments').send(VALID)).status).toBe(403);
    expect((await request(app).patch('/admin/api/clients/42/assignments/7').send({ title: 'x' })).status).toBe(403);
    expect((await request(app).post('/admin/api/clients/42/assignments/7/cancel').send({ reason: 'r' })).status).toBe(403);
    expect((await request(app).post('/admin/api/clients/42/assignments/7/reissue')).status).toBe(403);
    expect(dbMocks.listAssignmentsForClient).not.toHaveBeenCalled();
    expect(dbMocks.createAssignment).not.toHaveBeenCalled();
  });

  it('403 participant', async () => {
    expect((await request(appAs('participant', 42)).get('/admin/api/clients/42/assignments')).status).toBe(403);
  });

  it('therapist lists a caseload client', async () => {
    const res = await request(appAs('therapist', 9)).get('/admin/api/clients/42/assignments');
    expect(res.status).toBe(200);
    expect(res.body.assignments).toHaveLength(1);
    expect(dbMocks.isAssigned).toHaveBeenCalledWith(9, 42);
    expect(dbMocks.listAssignmentsForClient).toHaveBeenCalledWith(42);
  });

  it('researcher lists a same-org client without a caseload check', async () => {
    const res = await request(appAs('researcher', 3)).get('/admin/api/clients/42/assignments');
    expect(res.status).toBe(200);
    expect(dbMocks.isAssigned).not.toHaveBeenCalled();
  });
});

describe('scoping (404-over-403)', () => {
  it('therapist off-caseload -> 404 and nothing is written', async () => {
    dbMocks.isAssigned.mockResolvedValue(false);
    const app = appAs('therapist', 9);
    expect((await request(app).get('/admin/api/clients/42/assignments')).status).toBe(404);
    expect((await request(app).post('/admin/api/clients/42/assignments').send(VALID)).status).toBe(404);
    expect(dbMocks.createAssignment).not.toHaveBeenCalled();
    expect(dbMocks.insertCaseloadAudit).not.toHaveBeenCalled();
  });

  it('researcher in another org -> 404', async () => {
    const res = await request(appAs('researcher', 3, 6)).post('/admin/api/clients/42/assignments').send(VALID);
    expect(res.status).toBe(404);
    expect(dbMocks.createAssignment).not.toHaveBeenCalled();
  });

  it('researcher org lookup failure -> 500 (fail closed, never widened)', async () => {
    dbMocks.getOrganizationIdForUser.mockRejectedValue(new Error('db down'));
    const res = await request(appAs('researcher', 3, null)).get('/admin/api/clients/42/assignments');
    expect(res.status).toBe(500);
  });

  it('unknown user or non-participant -> 404', async () => {
    dbMocks.getUserById.mockResolvedValueOnce(null);
    expect((await request(appAs('therapist', 9)).get('/admin/api/clients/42/assignments')).status).toBe(404);
    dbMocks.getUserById.mockResolvedValueOnce({ ...CLIENT, role: 'therapist' });
    expect((await request(appAs('therapist', 9)).get('/admin/api/clients/42/assignments')).status).toBe(404);
  });

  it('non-numeric user id -> 400', async () => {
    expect((await request(appAs('therapist', 9)).get('/admin/api/clients/abc/assignments')).status).toBe(400);
  });
});

describe('POST create', () => {
  it('creates with the therapist as author and audits assignment_created', async () => {
    const res = await request(appAs('therapist', 9)).post('/admin/api/clients/42/assignments').send(VALID);
    expect(res.status).toBe(201);
    expect(res.body.assignment.id).toBe(7);
    expect(dbMocks.createAssignment).toHaveBeenCalledWith({
      userId: 42, authoredBy: 9, title: 'Worry log', description: 'Note each worry.',
      kind: 'worksheet', suggestedFrequency: 'daily',
    });
    expect(dbMocks.insertCaseloadAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'assignment_created', therapistId: 9, clientId: 42, actorUserId: 9, actorUsername: 'user9',
      detail: expect.objectContaining({ assignment_id: 7, title: 'Worry log' }),
    }));
  });

  it('researcher writes carry a null therapist_id in the audit row', async () => {
    const res = await request(appAs('researcher', 3)).post('/admin/api/clients/42/assignments').send(VALID);
    expect(res.status).toBe(201);
    expect(dbMocks.insertCaseloadAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'assignment_created', therapistId: null, actorUserId: 3,
    }));
  });

  it('defaults kind to custom and frequency to null; trims text', async () => {
    const res = await request(appAs('therapist', 9)).post('/admin/api/clients/42/assignments')
      .send({ title: '  Breathing  ', description: ' Two minutes. ' });
    expect(res.status).toBe(201);
    expect(dbMocks.createAssignment).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Breathing', description: 'Two minutes.', kind: 'custom', suggestedFrequency: null,
    }));
  });

  it('400s invalid input (missing title, long title, bad kind, bad frequency)', async () => {
    const app = appAs('therapist', 9);
    const url = '/admin/api/clients/42/assignments';
    expect((await request(app).post(url).send({ description: 'd' })).status).toBe(400);
    expect((await request(app).post(url).send({ title: '   ', description: 'd' })).status).toBe(400);
    expect((await request(app).post(url).send({ title: 'x'.repeat(201), description: 'd' })).status).toBe(400);
    expect((await request(app).post(url).send({ title: 't', description: 'x'.repeat(1001) })).status).toBe(400);
    const badKind = await request(app).post(url).send({ title: 't', description: 'd', kind: 'homework' });
    expect(badKind.status).toBe(400);
    expect(badKind.body.error).toMatch(/kind must be one of/);
    const badFreq = await request(app).post(url).send({ title: 't', description: 'd', suggested_frequency: 'hourly' });
    expect(badFreq.status).toBe(400);
    expect(badFreq.body.error).toMatch(/suggested_frequency must be one of/);
    expect(dbMocks.createAssignment).not.toHaveBeenCalled();
    expect(dbMocks.insertCaseloadAudit).not.toHaveBeenCalled();
  });
});

describe('PATCH edit', () => {
  it('edits supplied fields only, scoped to the client, and audits', async () => {
    const res = await request(appAs('therapist', 9)).patch('/admin/api/clients/42/assignments/7')
      .send({ title: 'Edited', suggested_frequency: '' });
    expect(res.status).toBe(200);
    expect(dbMocks.updateAssignment).toHaveBeenCalledWith(7, 42, { title: 'Edited', suggestedFrequency: null });
    expect(dbMocks.insertCaseloadAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'assignment_updated', clientId: 42,
      detail: expect.objectContaining({ assignment_id: 7, fields: ['title', 'suggestedFrequency'] }),
    }));
  });

  it('400s an empty patch, a blank title, or a bad id', async () => {
    const app = appAs('therapist', 9);
    expect((await request(app).patch('/admin/api/clients/42/assignments/7').send({})).status).toBe(400);
    expect((await request(app).patch('/admin/api/clients/42/assignments/7').send({ title: '' })).status).toBe(400);
    expect((await request(app).patch('/admin/api/clients/42/assignments/x').send({ title: 't' })).status).toBe(400);
    expect(dbMocks.updateAssignment).not.toHaveBeenCalled();
  });

  it('409 when the assignment is no longer open (or not this client\'s)', async () => {
    dbMocks.updateAssignment.mockResolvedValue(null);
    const res = await request(appAs('therapist', 9)).patch('/admin/api/clients/42/assignments/7').send({ title: 'Edited' });
    expect(res.status).toBe(409);
    expect(dbMocks.insertCaseloadAudit).not.toHaveBeenCalled();
  });
});

describe('POST cancel', () => {
  it('cancels with a reason and audits assignment_cancelled', async () => {
    const res = await request(appAs('therapist', 9)).post('/admin/api/clients/42/assignments/7/cancel')
      .send({ reason: 'superseded' });
    expect(res.status).toBe(200);
    expect(res.body.assignment.status).toBe('cancelled');
    expect(dbMocks.cancelAssignment).toHaveBeenCalledWith(7, 42, 9, 'superseded');
    expect(dbMocks.insertCaseloadAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'assignment_cancelled', detail: expect.objectContaining({ reason: 'superseded' }),
    }));
  });

  it('400 without a reason or with an overlong one', async () => {
    const app = appAs('therapist', 9);
    expect((await request(app).post('/admin/api/clients/42/assignments/7/cancel').send({})).status).toBe(400);
    expect((await request(app).post('/admin/api/clients/42/assignments/7/cancel').send({ reason: 'x'.repeat(501) })).status).toBe(400);
    expect(dbMocks.cancelAssignment).not.toHaveBeenCalled();
  });

  it('409 when already closed', async () => {
    dbMocks.cancelAssignment.mockResolvedValue(null);
    const res = await request(appAs('therapist', 9)).post('/admin/api/clients/42/assignments/7/cancel').send({ reason: 'r' });
    expect(res.status).toBe(409);
  });
});

describe('POST reissue', () => {
  it('re-issues a closed assignment as a new linked row and audits', async () => {
    const res = await request(appAs('researcher', 3)).post('/admin/api/clients/42/assignments/7/reissue');
    expect(res.status).toBe(201);
    expect(res.body.assignment.reissued_from).toBe(7);
    expect(dbMocks.reissueAssignment).toHaveBeenCalledWith(7, 42, 3);
    expect(dbMocks.insertCaseloadAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'assignment_reissued', detail: expect.objectContaining({ assignment_id: 8, reissued_from: 7 }),
    }));
  });

  it('409 while the original is still open', async () => {
    dbMocks.reissueAssignment.mockResolvedValue(null);
    expect((await request(appAs('therapist', 9)).post('/admin/api/clients/42/assignments/7/reissue')).status).toBe(409);
  });
});
