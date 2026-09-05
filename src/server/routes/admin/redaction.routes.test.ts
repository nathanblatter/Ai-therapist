// Redaction-verification routes: corrections and approvals are stamped with
// the reviewing researcher's session userId (accountability, 091).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  getRandomRedactedMessages: vi.fn(),
  updateRedactedContent: vi.fn(),
  recordRedactionApproval: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);

import redactionRoutes from './redaction.routes.js';

function appAs(role: string, userId = 7) {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
  app.use((req, _res, next) => {
    req.session.userId = userId;
    req.session.userRole = role;
    next();
  });
  app.use(redactionRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.updateRedactedContent.mockResolvedValue(true);
  dbMocks.recordRedactionApproval.mockResolvedValue(true);
});

describe('PUT /redact/api/messages/:id', () => {
  it('passes the reviewing researcher userId to updateRedactedContent', async () => {
    const res = await request(appAs('researcher', 7))
      .put('/redact/api/messages/42')
      .send({ content_redacted: '[REDACTED]' });
    expect(res.status).toBe(200);
    expect(dbMocks.updateRedactedContent).toHaveBeenCalledWith('42', '[REDACTED]', 7);
  });

  it('404s when the message does not exist', async () => {
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
    dbMocks.recordRedactionApproval.mockResolvedValue(false);
    const res = await request(appAs('researcher')).post('/redact/api/messages/999/approve');
    expect(res.status).toBe(404);
  });

  it('is researcher-only', async () => {
    const res = await request(appAs('caseworker')).post('/redact/api/messages/42/approve');
    expect(res.status).toBe(403);
    expect(dbMocks.recordRedactionApproval).not.toHaveBeenCalled();
  });
});
