// GET /admin/api/sessions/:sessionId/session-features (ai-therapist-172):
// researcher-only, scoped to the caller's organisation through the session,
// read-only, withheld while a blind human rating is owed.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  getLatestSessionFeatures: vi.fn(),
  // Blind-rating state (eval program WP2).
  getRatingQueueRowForSession: vi.fn(),
  hasHumanRating: vi.fn(),
  // Transitive: caseload middleware + org scoping.
  getSessionAccessInfo: vi.fn(),
  isAssigned: vi.fn(async () => true),
  getOrganizationIdForUser: vi.fn(async () => 1),
  getIrbStudyOrgId: vi.fn(async () => 1),
}));
vi.mock('../../db/index.js', () => dbMocks);

const { default: evalsRoutes } = await import('./evals.routes.js');

function appAs(role: string, userId = 1, orgId = 1) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = {
      userId,
      userRole: role,
      username: 'tester',
      orgId,
    };
    next();
  });
  app.use(evalsRoutes());
  return app;
}

const ROW = {
  feature_row_id: '7',
  session_id: 'sess_1',
  feature_set_version: 'features-v1',
  status: 'extracted',
  features: {
    topic_sleep: { kind: 'predicate', p: 0.97, present: true },
    topic_family: { kind: 'predicate', p: 0.5, present: null },
    topic_substance_use: { kind: 'unknown', reason: 'refused' },
    followup_status: { kind: 'choice', value: 'not_done', confidence: 0.85, p: { not_done: 0.85 } },
  },
  unknown_count: 1,
  transcript_truncated: false,
  transcript_fingerprint: 'abc',
  model: 'gpt-6-luna',
  error: null,
  extracted_at: '2026-11-27T00:00:00Z',
  stale: false,
};
const URL_ = '/admin/api/sessions/sess_1/session-features';

type Group = { group: string; items: Array<{ name: string; state: string; p: number | null }> };
const itemOf = (groups: Group[], name: string) => groups.flatMap((g) => g.items).find((i) => i.name === name);

beforeEach(() => {
  dbMocks.getLatestSessionFeatures.mockReset();
  dbMocks.getLatestSessionFeatures.mockResolvedValue(ROW);
  dbMocks.getSessionAccessInfo.mockReset();
  dbMocks.getSessionAccessInfo.mockResolvedValue({ user_id: 42, status: 'ended', owner_organization_id: 1 });
  dbMocks.getRatingQueueRowForSession.mockReset();
  dbMocks.getRatingQueueRowForSession.mockResolvedValue(null);
  dbMocks.hasHumanRating.mockReset();
  dbMocks.hasHumanRating.mockResolvedValue(false);
});

describe('session features read', () => {
  it('returns the stored answers by codebook group to a researcher in the session owner organisation', async () => {
    const res = await request(appAs('researcher')).get(URL_);
    expect(res.status).toBe(200);
    expect(res.body.blind).toBe(false);
    expect(res.body.features).toMatchObject({
      status: 'extracted',
      stale: false,
      feature_set_version: 'features-v1',
      unknown_count: 1,
    });
    const groups = res.body.features.groups as Group[];
    expect(groups.map((g) => g.group)).toEqual([
      'topics',
      'coping',
      'help_seeking',
      'follow_through',
      'rupture_repair',
      'reported_change',
    ]);
    expect(itemOf(groups, 'topic_sleep')).toMatchObject({ state: 'present', p: 0.97 });
    // Uncertain, unknown and not-stored are their own states, never absent.
    expect(itemOf(groups, 'topic_family')).toMatchObject({ state: 'uncertain', p: 0.5 });
    expect(itemOf(groups, 'topic_substance_use')).toMatchObject({ state: 'unknown', p: null });
    expect(itemOf(groups, 'topic_finances')).toMatchObject({ state: 'not_stored', p: null });
    expect(itemOf(groups, 'followup_status')).toMatchObject({ state: 'not_done', p: 0.85 });
    expect(dbMocks.getLatestSessionFeatures).toHaveBeenCalledWith('sess_1');
    // Internal columns stay server-side.
    expect(JSON.stringify(res.body)).not.toContain('transcript_fingerprint');
    expect(res.body.features).not.toHaveProperty('error');
    expect(res.body.features).not.toHaveProperty('session_id');
  });

  it('passes the stale flag through and returns no groups for a session that was not coded', async () => {
    dbMocks.getLatestSessionFeatures.mockResolvedValue({
      ...ROW,
      status: 'errored',
      features: null,
      error: '503',
      stale: true,
    });
    const res = await request(appAs('researcher')).get(URL_);
    expect(res.status).toBe(200);
    expect(res.body.features).toMatchObject({ status: 'errored', stale: true, groups: [] });
    expect(JSON.stringify(res.body)).not.toContain('503');
  });

  it('withholds the answers while the caller still owes a blind human rating for the session', async () => {
    dbMocks.getRatingQueueRowForSession.mockResolvedValue({ queue_id: 3, session_id: 'sess_1', status: 'queued' });
    const res = await request(appAs('researcher')).get(URL_);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ features: null, blind: true });
    expect(dbMocks.getLatestSessionFeatures).not.toHaveBeenCalled();

    // Once their own rating is stored, it is shown.
    dbMocks.hasHumanRating.mockResolvedValue(true);
    expect((await request(appAs('researcher')).get(URL_)).body.blind).toBe(false);
  });

  it('is 404 when the session has no row', async () => {
    dbMocks.getLatestSessionFeatures.mockResolvedValue(null);
    expect((await request(appAs('researcher')).get(URL_)).status).toBe(404);
  });

  it.each(['therapist', 'caseworker', 'participant'])('refuses the %s role', async (role) => {
    const res = await request(appAs(role)).get(URL_);
    expect(res.status).toBe(403);
    expect(dbMocks.getLatestSessionFeatures).not.toHaveBeenCalled();
  });

  it('does not read a session owned by another organisation', async () => {
    dbMocks.getSessionAccessInfo.mockResolvedValue({ user_id: 42, status: 'ended', owner_organization_id: 2 });
    const res = await request(appAs('researcher')).get(URL_);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(dbMocks.getLatestSessionFeatures).not.toHaveBeenCalled();
  });
});
