// Clinician prep digest (ai-therapist-123): structured (non-LLM) pre-session
// checklist. Two server-selected tiers (caseworker portal spec section 10
// item 2): therapist = full (clinician notes + crisis history); caseworker =
// summaries-only. The auth matrix and the caseworker payload's freedom from
// transcript-derived fields matter most.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  listUserAssignments: vi.fn(),
  getUserScaleHistory: vi.fn(),
  getRecentUserSummaries: vi.fn(),
  getLatestClinicianNote: vi.fn(),
  getUserPriorCrisisFlags: vi.fn(),
  // Recent signed care notes card (caseworker portal slice B).
  getRecentSignedNotes: vi.fn(),
  // Caseworker summaries-only brief variant (spec section 10 item 2).
  listEscalations: vi.fn(),
  listCaseworkerRoster: vi.fn(),
  // Caseload middleware deps (ai-therapist-119).
  isAssigned: vi.fn(),
  getSessionAccessInfo: vi.fn(),
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
  dbMocks.getRecentSignedNotes.mockResolvedValue([]);
  dbMocks.listEscalations.mockResolvedValue([]);
  dbMocks.listCaseworkerRoster.mockResolvedValue([]);
  dbMocks.isAssigned.mockResolvedValue(true);
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
    expect(dbMocks.isAssigned).toHaveBeenCalledWith(1, 7);
  });

  it('404 for a therapist whose caseload does not include the user (ai-therapist-119)', async () => {
    dbMocks.isAssigned.mockResolvedValue(false);
    const res = await request(appAs(1, 'therapist')).get('/admin/api/users/7/prep');
    expect(res.status).toBe(404);
    expect(dbMocks.listUserAssignments).not.toHaveBeenCalled();
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

  it('includes recent signed care notes with the therapist as viewer', async () => {
    dbMocks.getRecentSignedNotes.mockResolvedValue([
      {
        note_id: 21, note_type: 'case', case_note_kind: 'contact',
        author_name: 'cw.smith', author_role: 'caseworker',
        signed_at: '2026-08-20T00:00:00Z', content: { narrative: 'Called client' },
        org_id: 5, client_id: 7, status: 'signed',
      },
    ]);
    const res = await request(appAs(1, 'therapist')).get('/admin/api/users/7/prep');
    expect(res.status).toBe(200);
    expect(dbMocks.getRecentSignedNotes).toHaveBeenCalledWith(7, { userId: 1, role: 'therapist' }, 3);
    expect(res.body.recent_notes).toEqual([
      {
        note_id: 21, note_type: 'case', case_note_kind: 'contact',
        author_name: 'cw.smith', author_role: 'caseworker',
        signed_at: '2026-08-20T00:00:00Z', content: { narrative: 'Called client' },
      },
    ]);
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

describe('caseworker summaries-only variant (spec section 10 item 2)', () => {
  // Recursively collect every key in a JSON payload.
  function allKeys(value: unknown, keys = new Set<string>()): Set<string> {
    if (Array.isArray(value)) {
      for (const v of value) allKeys(v, keys);
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        keys.add(k);
        allKeys(v, keys);
      }
    }
    return keys;
  }

  function seedCaseworkerFixtures() {
    dbMocks.listUserAssignments.mockImplementation(async (_userId: number, opts: { status?: string }) =>
      opts.status === 'assigned'
        ? [{
            id: 1, user_id: 7, session_id: 's9', title: 'Two-minute breathing',
            description: 'Therapist-authored instructions', kind: 'exercise',
            suggested_frequency: 'daily', status: 'assigned',
            assigned_at: '2026-08-01T00:00:00.000Z', completed_at: null, completion_note: null,
          }]
        : [{
            id: 2, user_id: 7, session_id: 's8', title: 'Worry log',
            description: 'Track worries nightly', kind: 'worksheet',
            suggested_frequency: null, status: 'completed',
            assigned_at: '2026-07-20T00:00:00.000Z', completed_at: '2026-07-25T00:00:00.000Z',
            completion_note: 'participant free text: I told my therapist that...',
          }]
    );
    dbMocks.getUserScaleHistory.mockResolvedValue([
      { scale: 'phq2', score: 2, created_at: new Date('2026-08-10T00:00:00Z'), session_id: 's9' },
      { scale: 'phq2', score: 5, created_at: new Date('2026-08-01T00:00:00Z'), session_id: 's8' },
    ]);
    dbMocks.getRecentUserSummaries.mockResolvedValue([
      {
        session_id: 's9',
        summary: { headline: 'A hard week', follow_up: 'Revisit the job conversation', topics: ['work'] },
        session_name: null,
        ended_at: new Date('2026-08-10T00:00:00Z'),
        created_at: new Date('2026-08-10T00:00:00Z'),
      },
    ]);
    dbMocks.getRecentSignedNotes.mockResolvedValue([
      {
        note_id: 21, note_type: 'case', case_note_kind: 'contact',
        author_name: 'cw.smith', author_role: 'caseworker',
        signed_at: '2026-08-20T00:00:00Z', content: { narrative: 'Called client' },
        org_id: 5, client_id: 7, status: 'signed',
      },
    ]);
    dbMocks.listEscalations.mockResolvedValue([
      {
        escalation_id: 3, org_id: 5, client_id: 7, raised_by: 1, raised_by_role: 'caseworker',
        assigned_to: 9, reason: 'Missed two check-ins', urgency: 'urgent',
        crisis_event_id: null, session_id: null, note_id: null, status: 'open',
        acknowledged_by: null, acknowledged_at: null, resolved_by: null, resolved_at: null,
        resolution_note: null, created_at: '2026-08-21T00:00:00Z', updated_at: '2026-08-21T00:00:00Z',
        client_username: 'client7', assigned_username: 'dr.jones',
      },
    ]);
    dbMocks.listCaseworkerRoster.mockResolvedValue([
      { client_id: 99, last_session_at: null, ended_session_count: 0, last_checkin_mood: null, has_safety_plan: false },
      {
        client_id: 7, username: 'client7', assigned_at: '2026-06-01', member_role: 'caseworker',
        last_session_at: '2026-08-10T00:00:00Z', ended_session_count: 6, last_checkin_mood: 3,
        last_summary: { headline: 'A hard week' }, last_summary_session_id: 's9',
        latest_risk_score: 2, latest_risk_severity: 'low', latest_risk_at: '2026-08-10T00:00:00Z',
        open_crisis_count: 0, latest_scales: null, open_escalation_count: 1,
        overdue_practice_count: 0, has_safety_plan: true,
      },
    ]);
  }

  it('returns the summaries-only brief and never fetches therapist-tier sources', async () => {
    seedCaseworkerFixtures();
    // Poison the therapist-tier mocks: if the route ever called them for a
    // caseworker, transcript-adjacent content would appear (or the call count
    // assertion below fails first).
    dbMocks.getLatestClinicianNote.mockResolvedValue({ notes: 'verbatim client quote', author: 'dr.jones', created_at: new Date() });
    dbMocks.getUserPriorCrisisFlags.mockResolvedValue([{ session_id: 's3', severity: 'high', flagged_at: new Date(), unflagged_at: null }]);

    const res = await request(appAs(1, 'caseworker')).get('/admin/api/users/7/prep');
    expect(res.status).toBe(200);
    expect(dbMocks.isAssigned).toHaveBeenCalledWith(1, 7);

    // Therapist-tier sources are never queried on the caseworker branch.
    expect(dbMocks.getLatestClinicianNote).not.toHaveBeenCalled();
    expect(dbMocks.getUserPriorCrisisFlags).not.toHaveBeenCalled();

    // Tier + summaries-only shape.
    expect(res.body.tier).toBe('caseworker');
    expect(res.body.engagement).toEqual({
      last_session_at: '2026-08-10T00:00:00Z', ended_session_count: 6, last_checkin_mood: 3,
    });
    expect(res.body.has_safety_plan).toBe(true);
    expect(res.body.screener_deltas[0]).toMatchObject({ scale: 'phq2', latest_score: 2, previous_score: 5, delta: -3, direction: 'down' });
    expect(res.body.open_escalations).toEqual([
      {
        escalation_id: 3, status: 'open', urgency: 'urgent', reason: 'Missed two check-ins',
        raised_by_role: 'caseworker', assigned_username: 'dr.jones', created_at: '2026-08-21T00:00:00Z',
      },
    ]);
    expect(res.body.latest_case_note).toEqual({
      note_id: 21, note_type: 'case', case_note_kind: 'contact',
      author_name: 'cw.smith', author_role: 'caseworker',
      signed_at: '2026-08-20T00:00:00Z', content: { narrative: 'Called client' },
    });
    expect(res.body.recent_summaries).toEqual([
      {
        session_id: 's9', ended_at: '2026-08-10T00:00:00.000Z',
        summary: { headline: 'A hard week', follow_up: 'Revisit the job conversation', topics: ['work'] },
      },
    ]);

    // The case-note lookup runs with the caseworker visibility set.
    expect(dbMocks.getRecentSignedNotes).toHaveBeenCalledWith(7, { userId: 1, role: 'caseworker' }, 1);

    // No transcript-derived or therapist-clinical fields anywhere in the payload.
    const keys = allKeys(res.body);
    for (const forbidden of [
      'soap_note', 'notes_for_next_session', 'clinician_note', 'recent_crisis_flags',
      'recent_notes', 'transcript', 'messages', 'message_content',
      'completion_note', 'description', 'notes', 'last_summary', 'score_factors',
    ]) {
      expect(keys.has(forbidden), `caseworker prep payload must not contain "${forbidden}"`).toBe(false);
    }
    // And the poisoned therapist-tier strings never leak into the body.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('verbatim client quote');
    expect(body).not.toContain('participant free text');
    expect(body).not.toContain('Therapist-authored instructions');
  });

  it('assignments carry status fields only (no completion_note or description)', async () => {
    seedCaseworkerFixtures();
    const res = await request(appAs(1, 'caseworker')).get('/admin/api/users/7/prep');
    expect(res.status).toBe(200);
    expect(res.body.open_assignments).toEqual([
      {
        id: 1, title: 'Two-minute breathing', kind: 'exercise', suggested_frequency: 'daily',
        status: 'assigned', assigned_at: '2026-08-01T00:00:00.000Z', completed_at: null,
      },
    ]);
    expect(res.body.completed_assignments).toEqual([
      {
        id: 2, title: 'Worry log', kind: 'worksheet', suggested_frequency: null,
        status: 'completed', assigned_at: '2026-07-20T00:00:00.000Z', completed_at: '2026-07-25T00:00:00.000Z',
      },
    ]);
  });

  it('tier is server-selected: a caseworker cannot request the therapist brief', async () => {
    seedCaseworkerFixtures();
    const res = await request(appAs(1, 'caseworker')).get('/admin/api/users/7/prep?tier=therapist');
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('caseworker');
    expect(dbMocks.getLatestClinicianNote).not.toHaveBeenCalled();
    expect(res.body.clinician_note).toBeUndefined();
  });

  it('404 for a caseworker whose caseload does not include the user', async () => {
    dbMocks.isAssigned.mockResolvedValue(false);
    const res = await request(appAs(1, 'caseworker')).get('/admin/api/users/7/prep');
    expect(res.status).toBe(404);
    expect(dbMocks.listUserAssignments).not.toHaveBeenCalled();
  });

  it('missing roster row degrades to null engagement and no safety plan', async () => {
    dbMocks.listCaseworkerRoster.mockResolvedValue([]);
    const res = await request(appAs(1, 'caseworker')).get('/admin/api/users/7/prep');
    expect(res.status).toBe(200);
    expect(res.body.engagement).toBeNull();
    expect(res.body.has_safety_plan).toBe(false);
    expect(res.body.latest_case_note).toBeNull();
  });

  it('the therapist brief still carries tier=therapist and its full sections', async () => {
    const res = await request(appAs(1, 'therapist')).get('/admin/api/users/7/prep');
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('therapist');
    expect(res.body).toHaveProperty('clinician_note');
    expect(res.body).toHaveProperty('recent_crisis_flags');
    expect(dbMocks.listEscalations).not.toHaveBeenCalled();
    expect(dbMocks.listCaseworkerRoster).not.toHaveBeenCalled();
  });
});
