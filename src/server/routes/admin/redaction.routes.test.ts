// Redaction-verification routes: corrections and approvals are stamped with
// the reviewing researcher's session userId (accountability, 091), and every
// surface is organization-scoped (ai-therapist-272): the queue/count queries
// take the caller's org, the by-id writes 404 a message whose session owner
// is in another org, anonymous sessions are irb-study custody.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  getRandomRedactedMessages: vi.fn(),
  countFlaggedUnreviewed: vi.fn(),
  updateRedactedContent: vi.fn(),
  recordRedactionApproval: vi.fn(),
  // Caseload middleware (requireMessageClientAccess) + org resolution.
  getMessageOwner: vi.fn(),
  isAssigned: vi.fn(),
  getSessionAccessInfo: vi.fn(),
  getCareNoteById: vi.fn(),
  getEscalationById: vi.fn(),
  getOrganizationIdForUser: vi.fn(),
  getIrbStudyOrgId: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);

import redactionRoutes from './redaction.routes.js';

const IRB_ORG = 1;
const PRACTICE_ORG = 2;

function appAs(role: string, userId = 7, orgId = IRB_ORG) {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
  app.use((req, _res, next) => {
    req.session.userId = userId;
    req.session.userRole = role;
    req.session.orgId = orgId;
    next();
  });
  app.use(redactionRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getRandomRedactedMessages.mockResolvedValue([{ message_id: 42 }]);
  dbMocks.countFlaggedUnreviewed.mockResolvedValue(1);
  dbMocks.updateRedactedContent.mockResolvedValue(true);
  dbMocks.recordRedactionApproval.mockResolvedValue(true);
  dbMocks.getMessageOwner.mockResolvedValue({ session_id: 's1', user_id: 9, owner_organization_id: IRB_ORG });
  dbMocks.getIrbStudyOrgId.mockResolvedValue(IRB_ORG);
});

describe('GET /redact/api/messages', () => {
  it('hands the caller org to the queue and the backlog count', async () => {
    const res = await request(appAs('researcher', 7, PRACTICE_ORG)).get('/redact/api/messages');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messages: [{ message_id: 42 }], flagged_unreviewed: 1 });
    expect(dbMocks.getRandomRedactedMessages).toHaveBeenCalledWith(PRACTICE_ORG);
    expect(dbMocks.countFlaggedUnreviewed).toHaveBeenCalledWith(PRACTICE_ORG);
  });

  it('is researcher-only', async () => {
    expect((await request(appAs('therapist')).get('/redact/api/messages')).status).toBe(403);
    expect(dbMocks.getRandomRedactedMessages).not.toHaveBeenCalled();
  });
});

describe('PUT /redact/api/messages/:id', () => {
  it('passes the reviewing researcher userId to updateRedactedContent', async () => {
    const res = await request(appAs('researcher', 7))
      .put('/redact/api/messages/42')
      .send({ content_redacted: '[REDACTED]' });
    expect(res.status).toBe(200);
    expect(dbMocks.getMessageOwner).toHaveBeenCalledWith(42);
    expect(dbMocks.updateRedactedContent).toHaveBeenCalledWith('42', '[REDACTED]', 7);
  });

  it('404s a researcher when the message session owner is in another org (no write)', async () => {
    dbMocks.getMessageOwner.mockResolvedValue({ session_id: 's1', user_id: 9, owner_organization_id: IRB_ORG });
    const res = await request(appAs('researcher', 7, PRACTICE_ORG))
      .put('/redact/api/messages/42')
      .send({ content_redacted: 'x' });
    expect(res.status).toBe(404);
    expect(dbMocks.updateRedactedContent).not.toHaveBeenCalled();
  });

  it('anonymous-session message: only the irb-study org may correct it', async () => {
    dbMocks.getMessageOwner.mockResolvedValue({ session_id: 's1', user_id: null, owner_organization_id: null });
    expect((await request(appAs('researcher', 7, PRACTICE_ORG)).put('/redact/api/messages/42').send({ content_redacted: 'x' })).status).toBe(404);
    expect(dbMocks.updateRedactedContent).not.toHaveBeenCalled();
    expect((await request(appAs('researcher', 7, IRB_ORG)).put('/redact/api/messages/42').send({ content_redacted: 'x' })).status).toBe(200);
  });

  it('404s when the message does not exist', async () => {
    dbMocks.getMessageOwner.mockResolvedValue(null);
    const res = await request(appAs('researcher'))
      .put('/redact/api/messages/999')
      .send({ content_redacted: 'x' });
    expect(res.status).toBe(404);
    expect(dbMocks.updateRedactedContent).not.toHaveBeenCalled();
  });

  it('404s when the message vanishes between the owner check and the write', async () => {
    dbMocks.updateRedactedContent.mockResolvedValue(false);
    const res = await request(appAs('researcher'))
      .put('/redact/api/messages/999')
      .send({ content_redacted: 'x' });
    expect(res.status).toBe(404);
  });

  it('is researcher-only', async () => {
    const res = await request(appAs('therapist'))
      .put('/redact/api/messages/42')
      .send({ content_redacted: 'x' });
    expect(res.status).toBe(403);
    expect(dbMocks.updateRedactedContent).not.toHaveBeenCalled();
  });
});

describe('POST /redact/api/messages/:id/approve', () => {
  it('records a no-change approval stamped with the reviewer', async () => {
    const res = await request(appAs('researcher', 9)).post('/redact/api/messages/42/approve');
    expect(res.status).toBe(200);
    expect(dbMocks.recordRedactionApproval).toHaveBeenCalledWith('42', 9);
  });

  it('404s when the message does not exist', async () => {
    dbMocks.getMessageOwner.mockResolvedValue(null);
    const res = await request(appAs('researcher')).post('/redact/api/messages/999/approve');
    expect(res.status).toBe(404);
    expect(dbMocks.recordRedactionApproval).not.toHaveBeenCalled();
  });

  it('404s a researcher approving a message owned outside their org; anonymous is irb-study only', async () => {
    dbMocks.getMessageOwner.mockResolvedValue({ session_id: 's1', user_id: 9, owner_organization_id: PRACTICE_ORG });
    expect((await request(appAs('researcher', 7, IRB_ORG)).post('/redact/api/messages/42/approve')).status).toBe(404);
    expect((await request(appAs('researcher', 7, PRACTICE_ORG)).post('/redact/api/messages/42/approve')).status).toBe(200);
    dbMocks.getMessageOwner.mockResolvedValue({ session_id: 's1', user_id: null, owner_organization_id: null });
    expect((await request(appAs('researcher', 7, PRACTICE_ORG)).post('/redact/api/messages/42/approve')).status).toBe(404);
    expect((await request(appAs('researcher', 7, IRB_ORG)).post('/redact/api/messages/42/approve')).status).toBe(200);
    expect(dbMocks.recordRedactionApproval).toHaveBeenCalledTimes(2);
  });

  it('is researcher-only', async () => {
    const res = await request(appAs('caseworker')).post('/redact/api/messages/42/approve');
    expect(res.status).toBe(403);
    expect(dbMocks.recordRedactionApproval).not.toHaveBeenCalled();
  });
});
