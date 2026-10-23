// Rating queue + blind rating routes (eval program WP2): role matrix, the
// org / caseload 404 rule on claim and skip, and - the load-bearing part -
// that the session eval and human-ratings payloads omit every judge field
// and other raters' scores while the caller has not rated a queued session.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  getSessionEval: vi.fn(),
  getSession: vi.fn(async () => ({ session_id: 'sess_1', status: 'ended' })),
  getSessionHumanRatings: vi.fn(async () => []),
  upsertSessionHumanRating: vi.fn(async () => ({ rating_id: 1, rater_user_id: 1 })),
  getCalibrationPromptVersions: vi.fn(async () => ['v1']),
  acknowledgeDriftAlert: vi.fn(),
  listHarnessRuns: vi.fn(),
  getHarnessRun: vi.fn(),
  getRatingQueueRowForSession: vi.fn(async () => null),
  hasHumanRating: vi.fn(async () => false),
  linkRatingToQueue: vi.fn(async () => null),
  listRatingQueue: vi.fn(async () => []),
  getRatingQueueCounts: vi.fn(async () => ({ queued: 0, in_progress: 0, rated: 0, skipped: 0, awaiting_second_rater: 0, double_rated: 0 })),
  getRatingQueueRow: vi.fn(),
  claimRatingQueueRow: vi.fn(),
  skipRatingQueueRow: vi.fn(),
  countUnadjudicatedCrisisEvents: vi.fn(async () => 2),
  // Calibration fetchers behind GET /admin/api/evals/calibration.
  getCalibrationPairs: vi.fn(async () => []),
  getSessionEvalJudgeRuns: vi.fn(async () => []),
  getHighDisagreementEvals: vi.fn(async () => []),
  getHumanRatingPairs: vi.fn(async () => []),
  // Transitive: caseload middleware + org scoping.
  getSessionAccessInfo: vi.fn(async () => ({ user_id: 42, status: 'ended', owner_organization_id: 1 })),
  isAssigned: vi.fn(async () => true),
  getMessageOwner: vi.fn(),
  getCareNoteById: vi.fn(),
  getEscalationById: vi.fn(),
  getOrganizationIdForUser: vi.fn(async () => 1),
  getIrbStudyOrgId: vi.fn(async () => 1),
}));
vi.mock('../../db/index.js', () => dbMocks);

const samplerMocks = vi.hoisted(() => ({
  getSecondRaterFraction: vi.fn(async () => 0.2),
  enqueueStratifiedSample: vi.fn(async () => ({ dry_run: true, picks: [], allocations: [], inserted: [], candidate_count: 0, since: '', seed: 1, second_rater_fraction: 0.2 })),
  enqueueSessions: vi.fn(async (ids: string[]) => ({ inserted: ids.map(id => ({ session_id: id })), skipped: [] })),
}));
vi.mock('../../services/ratingSampler.service.js', () => samplerMocks);

const { default: evalsRoutes } = await import('./evals.routes.js');

function appAs(role: string, userId = 1, orgId = 1) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = { userId, userRole: role, username: 'tester', orgId };
    next();
  });
  app.use(evalsRoutes());
  return app;
}

const EVAL = {
  eval_id: 7, session_id: 'sess_1', judge_model: 'gpt-4o-mini', prompt_version: 'v1', created_at: '2026-10-20T00:00:00Z',
  rubric: { empathy: { score: 4, rationale: 'quotes the participant verbatim' } },
  overall_comments: 'secret judge comment', judge_spread: { empathy: 1 },
};
const QUEUE_OPEN = { queue_id: 3, session_id: 'sess_1', status: 'in_progress', stratum: 'chat|none|2026-W42', source: 'stratified', assigned_to: 1, second_rater_id: null, needs_second_rater: true };

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getSessionEval.mockResolvedValue(EVAL);
  dbMocks.getRatingQueueRowForSession.mockResolvedValue(null);
  dbMocks.hasHumanRating.mockResolvedValue(false);
  dbMocks.getSessionAccessInfo.mockResolvedValue({ user_id: 42, status: 'ended', owner_organization_id: 1 });
  dbMocks.isAssigned.mockResolvedValue(true);
  dbMocks.getSessionHumanRatings.mockResolvedValue([]);
});

describe('blind rating on GET /admin/api/sessions/:id/eval', () => {
  it('returns the full eval when the session is not queued', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/sessions/sess_1/eval');
    expect(res.status).toBe(200);
    expect(res.body.blind).toBe(false);
    expect(res.body.eval.rubric.empathy.score).toBe(4);
  });

  it('strips rubric, rationale, comments and spread while the session is queued and the caller has not rated', async () => {
    dbMocks.getRatingQueueRowForSession.mockResolvedValue(QUEUE_OPEN as never);
    const res = await request(appAs('researcher')).get('/admin/api/sessions/sess_1/eval');
    expect(res.status).toBe(200);
    expect(res.body.blind).toBe(true);
    expect(res.body.eval).toEqual({ eval_id: 7, session_id: 'sess_1', judge_model: 'gpt-4o-mini', prompt_version: 'v1', created_at: '2026-10-20T00:00:00Z' });
    expect(JSON.stringify(res.body)).not.toContain('secret judge comment');
    expect(JSON.stringify(res.body)).not.toContain('verbatim');
    expect(res.body.queue.queue_id).toBe(3);
  });

  it('reveals the judge once the caller has stored a rating', async () => {
    dbMocks.getRatingQueueRowForSession.mockResolvedValue(QUEUE_OPEN as never);
    dbMocks.hasHumanRating.mockResolvedValue(true);
    const res = await request(appAs('therapist')).get('/admin/api/sessions/sess_1/eval');
    expect(res.body.blind).toBe(false);
    expect(res.body.eval.overall_comments).toBe('secret judge comment');
  });

  it('is not blind once the queue row is rated or skipped', async () => {
    dbMocks.getRatingQueueRowForSession.mockResolvedValue({ ...QUEUE_OPEN, status: 'rated' });
    const res = await request(appAs('researcher')).get('/admin/api/sessions/sess_1/eval');
    expect(res.body.blind).toBe(false);
    expect(dbMocks.hasHumanRating).not.toHaveBeenCalled();
  });
});

describe('blind rating on GET /admin/api/sessions/:id/human-ratings', () => {
  it('withholds other raters while blind and says so', async () => {
    dbMocks.getRatingQueueRowForSession.mockResolvedValue(QUEUE_OPEN);
    dbMocks.getSessionHumanRatings.mockResolvedValue([{ rating_id: 1, rater_user_id: 2, rubric: { empathy: { score: 5 } } }]);
    const res = await request(appAs('researcher', 1)).get('/admin/api/sessions/sess_1/human-ratings');
    expect(res.status).toBe(200);
    expect(res.body.blind).toBe(true);
    expect(res.body.others_hidden).toBe(true);
    expect(res.body.ratings).toEqual([]);
  });

  it('returns everyone once the caller has rated', async () => {
    dbMocks.getRatingQueueRowForSession.mockResolvedValue(QUEUE_OPEN);
    dbMocks.hasHumanRating.mockResolvedValue(true);
    dbMocks.getSessionHumanRatings.mockResolvedValue([{ rating_id: 1, rater_user_id: 2 }, { rating_id: 2, rater_user_id: 1 }]);
    const res = await request(appAs('researcher', 1)).get('/admin/api/sessions/sess_1/human-ratings');
    expect(res.body.blind).toBe(false);
    expect(res.body.ratings).toHaveLength(2);
  });
});

describe('PUT /admin/api/sessions/:id/human-rating links the queue row', () => {
  it('calls linkRatingToQueue after the upsert and returns the row', async () => {
    dbMocks.linkRatingToQueue.mockResolvedValue({ ...QUEUE_OPEN, status: 'rated' });
    const rubric = Object.fromEntries(['safety_protocol', 'empathy', 'modality_fidelity', 'disclaimer_compliance', 'non_directiveness', 'clinical_claims'].map(d => [d, { score: 4 }]));
    const res = await request(appAs('therapist', 1)).put('/admin/api/sessions/sess_1/human-rating').send({ rubric });
    expect(res.status).toBe(200);
    expect(dbMocks.linkRatingToQueue).toHaveBeenCalledWith('sess_1', 1);
    expect(res.body.queue.status).toBe('rated');
  });
});

describe('GET /admin/api/evals/rating-queue', () => {
  it('org-scopes a researcher and carries counts, the unadjudicated crisis count and the fraction', async () => {
    const res = await request(appAs('researcher', 1, 5)).get('/admin/api/evals/rating-queue?scope=mine&status=open');
    expect(res.status).toBe(200);
    expect(dbMocks.listRatingQueue).toHaveBeenCalledWith(expect.objectContaining({ userId: 1, orgId: 5, scopeTherapistId: null, mine: true, status: 'open' }));
    expect(dbMocks.countUnadjudicatedCrisisEvents).toHaveBeenCalledWith(null, 5);
    expect(res.body.unadjudicated_crisis_events).toBe(2);
    expect(res.body.second_rater_fraction).toBe(0.2);
  });

  it('caseload-scopes a therapist', async () => {
    await request(appAs('therapist', 7)).get('/admin/api/evals/rating-queue');
    expect(dbMocks.listRatingQueue).toHaveBeenCalledWith(expect.objectContaining({ scopeTherapistId: 7, orgId: null, mine: false }));
  });

  it('ignores an unknown status filter', async () => {
    await request(appAs('researcher')).get('/admin/api/evals/rating-queue?status=bogus');
    expect(dbMocks.listRatingQueue).toHaveBeenCalledWith(expect.objectContaining({ status: undefined }));
  });

  it('is denied to caseworkers and participants', async () => {
    expect((await request(appAs('caseworker')).get('/admin/api/evals/rating-queue')).status).toBe(403);
    expect((await request(appAs('participant')).get('/admin/api/evals/rating-queue')).status).toBe(403);
  });
});

describe('POST /admin/api/evals/rating-queue/sample', () => {
  it('is researcher-only', async () => {
    expect((await request(appAs('therapist')).post('/admin/api/evals/rating-queue/sample').send({ size: 5 })).status).toBe(403);
  });

  it('validates size and forwards the options', async () => {
    expect((await request(appAs('researcher')).post('/admin/api/evals/rating-queue/sample').send({ size: 0 })).status).toBe(400);
    expect((await request(appAs('researcher')).post('/admin/api/evals/rating-queue/sample').send({ size: 5, since: 'nope' })).status).toBe(400);
    const res = await request(appAs('researcher', 3)).post('/admin/api/evals/rating-queue/sample').send({ size: 5, dry_run: true, seed: 11, since: '2026-09-01' });
    expect(res.status).toBe(200);
    expect(samplerMocks.enqueueStratifiedSample).toHaveBeenCalledWith(expect.objectContaining({ size: 5, dryRun: true, seed: 11, enqueuedBy: 3 }));
  });
});

describe('POST /admin/api/evals/rating-queue/enqueue', () => {
  it('enqueues only sessions inside the researcher org and reports the rest as skipped', async () => {
    dbMocks.getSessionAccessInfo
      .mockResolvedValueOnce({ user_id: 42, status: 'ended', owner_organization_id: 1 })
      .mockResolvedValueOnce({ user_id: 43, status: 'ended', owner_organization_id: 2 });
    const res = await request(appAs('researcher', 1, 1)).post('/admin/api/evals/rating-queue/enqueue').send({ session_ids: ['in', 'out'], source: 'disagreement' });
    expect(res.status).toBe(200);
    expect(samplerMocks.enqueueSessions).toHaveBeenCalledWith(['in'], 'disagreement', 1);
    expect(res.body.skipped).toEqual(['out']);
  });

  it('rejects a bad source or id list', async () => {
    expect((await request(appAs('researcher')).post('/admin/api/evals/rating-queue/enqueue').send({ session_ids: ['a'], source: 'stratified' })).status).toBe(400);
    expect((await request(appAs('researcher')).post('/admin/api/evals/rating-queue/enqueue').send({ session_ids: [], source: 'manual' })).status).toBe(400);
  });
});

describe('claim and skip', () => {
  const ROW = { queue_id: 3, session_id: 'sess_1', status: 'queued' };

  it('claims for a therapist whose caseload holds the session', async () => {
    dbMocks.getRatingQueueRow.mockResolvedValue(ROW);
    dbMocks.claimRatingQueueRow.mockResolvedValue({ ...ROW, status: 'in_progress', assigned_to: 7 });
    const res = await request(appAs('therapist', 7)).post('/admin/api/evals/rating-queue/3/claim');
    expect(res.status).toBe(200);
    expect(dbMocks.claimRatingQueueRow).toHaveBeenCalledWith(3, 7);
  });

  it('404s (never 403) for a therapist off the caseload and for a researcher in another org', async () => {
    dbMocks.getRatingQueueRow.mockResolvedValue(ROW);
    dbMocks.isAssigned.mockResolvedValue(false);
    expect((await request(appAs('therapist', 7)).post('/admin/api/evals/rating-queue/3/claim')).status).toBe(404);
    expect((await request(appAs('researcher', 1, 9)).post('/admin/api/evals/rating-queue/3/skip')).status).toBe(404);
    expect(dbMocks.claimRatingQueueRow).not.toHaveBeenCalled();
    expect(dbMocks.skipRatingQueueRow).not.toHaveBeenCalled();
  });

  it('404s for an unknown row and 409s when not claimable', async () => {
    dbMocks.getRatingQueueRow.mockResolvedValueOnce(null);
    expect((await request(appAs('researcher')).post('/admin/api/evals/rating-queue/99/claim')).status).toBe(404);
    dbMocks.getRatingQueueRow.mockResolvedValue(ROW);
    dbMocks.claimRatingQueueRow.mockResolvedValue(null);
    expect((await request(appAs('researcher')).post('/admin/api/evals/rating-queue/3/claim')).status).toBe(409);
    dbMocks.skipRatingQueueRow.mockResolvedValue(null);
    expect((await request(appAs('researcher')).post('/admin/api/evals/rating-queue/3/skip')).status).toBe(409);
  });

  it('rejects a non-numeric id and the caseworker role', async () => {
    expect((await request(appAs('researcher')).post('/admin/api/evals/rating-queue/x/claim')).status).toBe(400);
    expect((await request(appAs('caseworker')).post('/admin/api/evals/rating-queue/3/claim')).status).toBe(403);
  });
});

describe('GET /admin/api/evals/calibration', () => {
  it('carries the human-human agreement next to the judge report', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/evals/calibration');
    expect(res.status).toBe(200);
    expect(res.body.human_agreement).toBeDefined();
    expect(res.body.human_agreement.target_pairs).toBe(20);
    expect(res.body.report).toBeDefined();
  });
});
