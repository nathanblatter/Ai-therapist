// Route coverage for adverse-event admin API (ai-therapist-95): auth (403 for
// participant) and invalid-transition 409.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const {
  listMock, countsMock, getByIdMock, submitMock,
} = vi.hoisted(() => ({
  listMock: vi.fn(),
  countsMock: vi.fn(),
  getByIdMock: vi.fn(),
  submitMock: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  listAdverseEvents: listMock,
  getAdverseEventCounts: countsMock,
  getAdverseEventById: getByIdMock,
  updateAdverseEventDraft: vi.fn(),
  submitAdverseEvent: submitMock,
  closeAdverseEvent: vi.fn(),
  reopenAdverseEvent: vi.fn(),
}));
vi.mock('../../utils/aePrintView.js', () => ({ renderAdverseEventPrintHtml: () => '<html></html>' }));

import adverseEventsRoutes from './adverseEvents.routes.js';

function appAs(role: string | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = role
      ? { userId: 1, userRole: role, username: 'tester' }
      : {};
    next();
  });
  app.use(adverseEventsRoutes());
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe('GET /admin/api/adverse-events', () => {
  it('returns counts + reports for a therapist', async () => {
    countsMock.mockResolvedValueOnce({ draft: 1, submitted: 0, overdue: 0, due_soon: 0 });
    listMock.mockResolvedValueOnce([{ report_id: 1 }]);
    const res = await request(appAs('therapist')).get('/admin/api/adverse-events?status=draft');
    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(1);
  });

  it('403s a participant', async () => {
    const res = await request(appAs('participant')).get('/admin/api/adverse-events');
    expect(res.status).toBe(403);
  });
});

describe('POST /admin/api/adverse-events/:id/submit', () => {
  it('409s when the report is not a draft (transition guard)', async () => {
    submitMock.mockResolvedValueOnce(false);
    getByIdMock.mockResolvedValueOnce({ report_id: 1, status: 'submitted' });
    const res = await request(appAs('researcher')).post('/admin/api/adverse-events/1/submit');
    expect(res.status).toBe(409);
  });

  it('signs off with the session username on success', async () => {
    submitMock.mockResolvedValueOnce(true);
    getByIdMock.mockResolvedValueOnce({ report_id: 1, status: 'submitted', submitted_by: 'tester' });
    const res = await request(appAs('therapist')).post('/admin/api/adverse-events/1/submit');
    expect(res.status).toBe(200);
    expect(submitMock).toHaveBeenCalledWith(1, 'tester');
  });

  it('403s a participant', async () => {
    const res = await request(appAs('participant')).post('/admin/api/adverse-events/1/submit');
    expect(res.status).toBe(403);
  });
});
