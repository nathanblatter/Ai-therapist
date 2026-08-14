// Clinician prep digest (ai-therapist-123): therapist-only, structured
// (non-LLM) pre-session checklist. The auth matrix matters most — this route
// exposes clinician notes and crisis history.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  listUserAssignments: vi.fn(),
  getUserScaleHistory: vi.fn(),
  getRecentUserSummaries: vi.fn(),
  getLatestClinicianNote: vi.fn(),
  getUserPriorCrisisFlags: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);

import prepRoutes from './prep.routes.js';

function appAs(userId: number | null, role?: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = (userId === null
      ? {}
      : { userId, userRole: role, username: 'someone' }) as unknown as typeof req.session;
    next();
  });
  app.use(prepRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.listUserAssignments.mockResolvedValue([]);
  dbMocks.getUserScaleHistory.mockResolvedValue([]);
  dbMocks.getRecentUserSummaries.mockResolvedValue([]);
  dbMocks.getLatestClinicianNote.mockResolvedValue(null);
  dbMocks.getUserPriorCrisisFlags.mockResolvedValue([]);
});

describe('auth matrix', () => {
  it('401 with no session', async () => {
    const res = await request(appAs(null)).get('/admin/api/users/7/prep');
    expect(res.status).toBe(401);
    expect(dbMocks.listUserAssignments).not.toHaveBeenCalled();
  });

  it('403 for participants', async () => {
    const res = await request(appAs(1, 'participant')).get('/admin/api/users/7/prep');
    expect(res.status).toBe(403);
    expect(dbMocks.listUserAssignments).not.toHaveBeenCalled();
  });

  it('403 for researchers (digest includes clinician notes + crisis history)', async () => {
    const res = await request(appAs(1, 'researcher')).get('/admin/api/users/7/prep');
    expect(res.status).toBe(403);
    expect(dbMocks.listUserAssignments).not.toHaveBeenCalled();
  });

  it('200 for therapists', async () => {
    const res = await request(appAs(1, 'therapist')).get('/admin/api/users/7/prep');
    expect(res.status).toBe(200);
  });
});

describe('digest assembly (structured, no LLM)', () => {
  it('rejects a non-numeric user id', async () => {
    const res = await request(appAs(1, 'therapist')).get('/admin/api/users/abc/prep');
    expect(res.status).toBe(400);
    expect(dbMocks.listUserAssignments).not.toHaveBeenCalled();
  });

  it('fetches everything for the requested user and returns the digest shape', async () => {
    dbMocks.listUserAssignments.mockImplementation(async (_userId: number, opts: { status?: string }) =>
      opts.status === 'assigned'
        ? [{ id: 1, title: 'Two-minute breathing', status: 'assigned' }]
        : [{ id: 2, title: 'Worry log', status: 'completed', completion_note: 'went ok' }]
    );
    dbMocks.getRecentUserSummaries.mockResolvedValue([
      {
        session_id: 's9',
        summary: { headline: 'A hard week', follow_up: 'Revisit the job conversation' },
        session_name: null,
        ended_at: new Date('2026-08-10T00:00:00Z'),
        created_at: new Date('2026-08-10T00:00:00Z'),
      },
    ]);
    dbMocks.getLatestClinicianNote.mockResolvedValue({ notes: 'Ask about sleep.', author: 'dr.jones', created_at: new Date(), session_id: 's9' });
    dbMocks.getUserPriorCrisisFlags.mockResolvedValue([
      { session_id: 's3', severity: 'medium', flagged_at: new Date('2026-07-01T00:00:00Z'), unflagged_at: null, unflagged_by: null },
    ]);

    const res = await request(appAs(1, 'therapist')).get('/admin/api/users/7/prep');
    expect(res.status).toBe(200);
    expect(dbMocks.listUserAssignments).toHaveBeenCalledWith(7, { status: 'assigned', limit: 10 });
    expect(dbMocks.listUserAssignments).toHaveBeenCalledWith(7, { status: 'completed', limit: 5 });
    expect(dbMocks.getUserPriorCrisisFlags).toHaveBeenCalledWith(7, null, 5);
    expect(res.body.open_assignments).toHaveLength(1);
    expect(res.body.completed_assignments[0].completion_note).toBe('went ok');
    expect(res.body.last_session).toMatchObject({
      session_id: 's9',
      headline: 'A hard week',
      follow_up: 'Revisit the job conversation',
    });
    expect(res.body.clinician_note.notes).toBe('Ask about sleep.');
    expect(res.body.recent_crisis_flags).toHaveLength(1);
  });

  it('computes per-scale screener deltas (latest vs previous)', async () => {
    dbMocks.getUserScaleHistory.mockResolvedValue([
      // newest-first within each scale, as getUserScaleHistory returns
      { scale: 'phq2', score: 2, created_at: new Date('2026-08-10T00:00:00Z'), session_id: 's9' },
      { scale: 'phq2', score: 5, created_at: new Date('2026-08-01T00:00:00Z'), session_id: 's8' },
      { scale: 'gad2', score: 4, created_at: new Date('2026-08-10T00:00:00Z'), session_id: 's9' },
    ]);
    const res = await request(appAs(1, 'therapist')).get('/admin/api/users/7/prep');
    expect(res.status).toBe(200);
    const phq = res.body.screener_deltas.find((d: { scale: string }) => d.scale === 'phq2');
    expect(phq).toMatchObject({ latest_score: 2, previous_score: 5, delta: -3, direction: 'down' });
    const gad = res.body.screener_deltas.find((d: { scale: string }) => d.scale === 'gad2');
    expect(gad).toMatchObject({ latest_score: 4, previous_score: null, delta: null, direction: null });
  });

  it('a db failure returns a generic 500', async () => {
    dbMocks.getUserScaleHistory.mockRejectedValue(new Error('pg down: secret'));
    const res = await request(appAs(1, 'therapist')).get('/admin/api/users/7/prep');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to build prep digest' });
  });
});
