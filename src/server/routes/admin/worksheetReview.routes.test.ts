// Worksheet review routes (ai-therapist-89): researcher-only, the detail read
// is audited as participant-content access, promote/reject lifecycle, and the
// server-side refusal of a template that still carries an answer.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../config/db.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn(), on: vi.fn() },
}));

const dbMocks = vi.hoisted(() => ({
  listWorksheetInstancesForReview: vi.fn(),
  getWorksheetInstanceForReview: vi.fn(),
  markWorksheetRejected: vi.fn(),
  promoteWorksheetToKnowledgeChunk: vi.fn(),
  logDataAccess: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../db/index.js', () => dbMocks);

const embedText = vi.hoisted(() => vi.fn().mockResolvedValue([0.1, 0.2, 0.3]));
vi.mock('../../services/embeddings.service.js', () => ({ embedText }));

import worksheetReviewRoutes from './worksheetReview.routes.js';

function appAs(role: string | null, username: string | null = 'reviewer') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = role
      ? ({ userId: 5, userRole: role, ...(username ? { username } : {}) } as unknown as typeof req.session)
      : ({} as unknown as typeof req.session);
    next();
  });
  app.use(worksheetReviewRoutes());
  return app;
}

const ANSWER = 'My manager Priya said the Q3 report was sloppy in front of the whole team.';

function instance(overrides: Record<string, unknown> = {}) {
  return {
    instance_id: 7,
    session_id: 'sess-1',
    user_id: 42,
    template_chunk_id: 21,
    template_title: 'Evidence list',
    title: 'Evidence list for the report criticism',
    intro: 'After what you told me about Priya',
    sections: [
      { type: 'textarea', label: 'What happened?' },
      { type: 'scale', label: 'How strongly do you believe it now?' },
    ],
    responses: { 'What happened?': ANSWER, 'How strongly do you believe it now?': '70' },
    status: 'completed',
    promoted: false,
    created_at: new Date(),
    completed_at: new Date(),
    review_status: 'pending',
    reviewed_by: null,
    reviewed_at: null,
    review_note: null,
    promoted_chunk_id: null,
    template_content: 'A CBT evidence exercise.',
    template_topic: 'anxiety',
    template_metadata: { render_tool: 'show_journaling_prompt' },
    ...overrides,
  };
}

beforeEach(() => {
  Object.values(dbMocks).forEach(m => m.mockClear());
  embedText.mockClear();
  dbMocks.listWorksheetInstancesForReview.mockResolvedValue({ rows: [{ instance_id: 7 }], total: 1 });
  dbMocks.getWorksheetInstanceForReview.mockResolvedValue(instance());
  dbMocks.markWorksheetRejected.mockResolvedValue(true);
  dbMocks.promoteWorksheetToKnowledgeChunk.mockResolvedValue({ outcome: 'promoted', chunk_id: 99 });
});

describe('role matrix', () => {
  const cases: Array<[string, (app: express.Express) => request.Test]> = [
    ['GET queue', app => request(app).get('/admin/api/worksheets/review')],
    ['GET detail', app => request(app).get('/admin/api/worksheets/review/7')],
    ['POST promote', app => request(app).post('/admin/api/worksheets/review/7/promote').send({ content: 'x' })],
    ['POST reject', app => request(app).post('/admin/api/worksheets/review/7/reject').send({ note: 'x' })],
  ];
  for (const [name, call] of cases) {
    it(`${name}: researcher only`, async () => {
      await call(appAs(null)).expect(401);
      await call(appAs('therapist')).expect(403);
      await call(appAs('caseworker')).expect(403);
      await call(appAs('participant')).expect(403);
      expect(dbMocks.logDataAccess).not.toHaveBeenCalled();
      expect(dbMocks.promoteWorksheetToKnowledgeChunk).not.toHaveBeenCalled();
      expect(dbMocks.markWorksheetRejected).not.toHaveBeenCalled();
    });
  }
});

describe('GET /admin/api/worksheets/review (queue)', () => {
  it('returns the queue with paging and does not audit (no participant content)', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/worksheets/review?limit=10&offset=20').expect(200);
    expect(res.body).toEqual({ instances: [{ instance_id: 7 }], total: 1 });
    expect(dbMocks.listWorksheetInstancesForReview).toHaveBeenCalledWith({ limit: 10, offset: 20 });
    expect(dbMocks.logDataAccess).not.toHaveBeenCalled();
  });
});

describe('GET /admin/api/worksheets/review/:id (detail)', () => {
  it('returns the filled instance plus the stripped template and writes a worksheet_review audit row', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/worksheets/review/7').expect(200);
    expect(res.body.instance.responses['What happened?']).toBe(ANSWER);
    expect(res.body.template.title).toBe('Evidence list for the report criticism');
    expect(res.body.template.content).toContain('1. [textarea] What happened?');
    expect(res.body.template.content).toContain('Rationale: A CBT evidence exercise.');
    expect(res.body.template.content).not.toContain('Priya');
    expect(dbMocks.logDataAccess).toHaveBeenCalledTimes(1);
    expect(dbMocks.logDataAccess).toHaveBeenCalledWith({
      accessedBy: 5, role: 'researcher', action: 'worksheet_review',
      sessionId: 'sess-1', userId: 42, detail: { instance_id: 7 },
    });
  });

  it('404s an unknown instance without an audit row; 400s a bad id', async () => {
    dbMocks.getWorksheetInstanceForReview.mockResolvedValueOnce(null);
    await request(appAs('researcher')).get('/admin/api/worksheets/review/999').expect(404);
    await request(appAs('researcher')).get('/admin/api/worksheets/review/abc').expect(400);
    expect(dbMocks.logDataAccess).not.toHaveBeenCalled();
  });
});

describe('POST /admin/api/worksheets/review/:id/promote', () => {
  const CLEAN = 'Worksheet template: Evidence list\n\nSections (2):\n1. [textarea] What happened?\n2. [scale] How strongly do you believe it now?';

  it('embeds the confirmed template and promotes with provenance inputs', async () => {
    const res = await request(appAs('researcher'))
      .post('/admin/api/worksheets/review/7/promote')
      .send({ title: 'Evidence list (general)', content: CLEAN, note: 'good general form' })
      .expect(201);
    expect(res.body).toEqual({ success: true, chunk_id: 99, active: false });
    expect(embedText).toHaveBeenCalledWith(CLEAN);
    const input = dbMocks.promoteWorksheetToKnowledgeChunk.mock.calls[0][0];
    expect(input).toMatchObject({
      instanceId: 7, reviewer: 'reviewer', note: 'good general form',
      title: 'Evidence list (general)', content: CLEAN, embedding: [0.1, 0.2, 0.3],
      topic: 'anxiety', template_kind: 'vetted_template',
      metadata: { sections: [{ type: 'textarea' }, { type: 'scale' }], render_tool: 'show_journaling_prompt', template_chunk_id: 21 },
    });
    expect(input.content_hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('refuses a template that still carries a participant answer (422) before embedding', async () => {
    const res = await request(appAs('researcher'))
      .post('/admin/api/worksheets/review/7/promote')
      .send({ content: `${CLEAN}\n   Example: the q3 report was sloppy in front of everyone` })
      .expect(422);
    expect(res.body.section).toBe('What happened?');
    expect(embedText).not.toHaveBeenCalled();
    expect(dbMocks.promoteWorksheetToKnowledgeChunk).not.toHaveBeenCalled();
  });

  it('checks the title too', async () => {
    await request(appAs('researcher'))
      .post('/admin/api/worksheets/review/7/promote')
      .send({ title: ANSWER, content: CLEAN })
      .expect(422);
    expect(dbMocks.promoteWorksheetToKnowledgeChunk).not.toHaveBeenCalled();
  });

  it('labels a custom (template-less) instance as custom_worksheet', async () => {
    dbMocks.getWorksheetInstanceForReview.mockResolvedValueOnce(instance({ template_chunk_id: null, template_metadata: null, template_topic: null }));
    await request(appAs('researcher')).post('/admin/api/worksheets/review/7/promote').send({ content: CLEAN }).expect(201);
    const input = dbMocks.promoteWorksheetToKnowledgeChunk.mock.calls[0][0];
    expect(input.template_kind).toBe('custom_worksheet');
    expect(input.title).toBe('Evidence list for the report criticism'); // falls back to the instance title
    expect(input.metadata).toEqual({ sections: [{ type: 'textarea' }, { type: 'scale' }] });
  });

  it('maps query outcomes: already_promoted 200, duplicate 409, not_pending 409', async () => {
    const app = appAs('researcher');
    dbMocks.promoteWorksheetToKnowledgeChunk.mockResolvedValueOnce({ outcome: 'already_promoted', chunk_id: 99 });
    const again = await request(app).post('/admin/api/worksheets/review/7/promote').send({ content: CLEAN }).expect(200);
    expect(again.body).toEqual({ success: true, chunk_id: 99, already_promoted: true });
    dbMocks.promoteWorksheetToKnowledgeChunk.mockResolvedValueOnce({ outcome: 'duplicate_content' });
    await request(app).post('/admin/api/worksheets/review/7/promote').send({ content: CLEAN }).expect(409);
    dbMocks.promoteWorksheetToKnowledgeChunk.mockResolvedValueOnce({ outcome: 'not_pending' });
    await request(app).post('/admin/api/worksheets/review/7/promote').send({ content: CLEAN }).expect(409);
  });

  it('409s an instance that is not completed or already reviewed, without embedding', async () => {
    dbMocks.getWorksheetInstanceForReview.mockResolvedValueOnce(instance({ review_status: 'rejected' }));
    await request(appAs('researcher')).post('/admin/api/worksheets/review/7/promote').send({ content: CLEAN }).expect(409);
    dbMocks.getWorksheetInstanceForReview.mockResolvedValueOnce(instance({ status: 'draft' }));
    await request(appAs('researcher')).post('/admin/api/worksheets/review/7/promote').send({ content: CLEAN }).expect(409);
    expect(embedText).not.toHaveBeenCalled();
  });

  it('400s a missing content body or an unidentified admin; 404s an unknown instance', async () => {
    await request(appAs('researcher')).post('/admin/api/worksheets/review/7/promote').send({}).expect(400);
    await request(appAs('researcher', null)).post('/admin/api/worksheets/review/7/promote').send({ content: CLEAN }).expect(400);
    dbMocks.getWorksheetInstanceForReview.mockResolvedValueOnce(null);
    await request(appAs('researcher')).post('/admin/api/worksheets/review/7/promote').send({ content: CLEAN }).expect(404);
    expect(dbMocks.promoteWorksheetToKnowledgeChunk).not.toHaveBeenCalled();
  });
});

describe('POST /admin/api/worksheets/review/:id/reject', () => {
  it('requires a note and stamps the reviewer', async () => {
    await request(appAs('researcher')).post('/admin/api/worksheets/review/7/reject').send({}).expect(400);
    await request(appAs('researcher')).post('/admin/api/worksheets/review/7/reject').send({ note: '   ' }).expect(400);
    expect(dbMocks.markWorksheetRejected).not.toHaveBeenCalled();
    const res = await request(appAs('researcher')).post('/admin/api/worksheets/review/7/reject').send({ note: ' too specific ' }).expect(200);
    expect(res.body).toEqual({ success: true, id: 7, review_status: 'rejected' });
    expect(dbMocks.markWorksheetRejected).toHaveBeenCalledWith(7, 'reviewer', 'too specific');
  });

  it('409s when the instance is not pending any more', async () => {
    dbMocks.markWorksheetRejected.mockResolvedValueOnce(false);
    await request(appAs('researcher')).post('/admin/api/worksheets/review/7/reject').send({ note: 'x' }).expect(409);
  });
});
