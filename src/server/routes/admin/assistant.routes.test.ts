// Assistant chat endpoint: role gate, feature flag, payload validation, and
// context construction (session identity + org, never client-supplied).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const serviceMocks = vi.hoisted(() => ({
  runAssistantTurn: vi.fn(),
}));
vi.mock('../../services/assistant.service.js', () => ({
  ...serviceMocks,
}));

const orgMocks = vi.hoisted(() => ({ orgIdFor: vi.fn() }));
vi.mock('../../middleware/org.js', () => orgMocks);

import assistantRoutes from './assistant.routes.js';

function appAs(role: string | null, userId = 7) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = role
      ? { userId, userRole: role, username: `user${userId}` }
      : {};
    next();
  });
  app.use(assistantRoutes());
  return app;
}

const MSGS = { messages: [{ role: 'user', content: 'How many sessions this week?' }] };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ASSISTANT_ENABLED = 'true';
  orgMocks.orgIdFor.mockResolvedValue(1);
  serviceMocks.runAssistantTurn.mockResolvedValue({ answer: '42 sessions.', toolCalls: [{ name: 'session_stats', rowCount: 42 }] });
});

describe('POST /admin/api/assistant/chat', () => {
  it('rejects participants, demo, and anonymous', async () => {
    expect((await request(appAs('participant')).post('/admin/api/assistant/chat').send(MSGS)).status).toBe(403);
    expect((await request(appAs('demo')).post('/admin/api/assistant/chat').send(MSGS)).status).toBe(403);
    expect((await request(appAs(null)).post('/admin/api/assistant/chat').send(MSGS)).status).toBe(401);
  });

  it('503s when the flag is off', async () => {
    process.env.ASSISTANT_ENABLED = 'false';
    const res = await request(appAs('researcher')).post('/admin/api/assistant/chat').send(MSGS);
    expect(res.status).toBe(503);
    expect(serviceMocks.runAssistantTurn).not.toHaveBeenCalled();
  });

  it('400s malformed histories', async () => {
    const app = appAs('researcher');
    expect((await request(app).post('/admin/api/assistant/chat').send({ messages: [] })).status).toBe(400);
    expect((await request(app).post('/admin/api/assistant/chat').send({ messages: [{ role: 'system', content: 'x' }] })).status).toBe(400);
    expect((await request(app).post('/admin/api/assistant/chat').send({
      messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }],
    })).status).toBe(400); // must end with a user turn
  });

  it('builds the context from the session, not the request body', async () => {
    const res = await request(appAs('caseworker', 33))
      .post('/admin/api/assistant/chat')
      .send({ ...MSGS, userId: 999, role: 'researcher' });
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('42 sessions.');
    expect(serviceMocks.runAssistantTurn).toHaveBeenCalledWith(
      { userId: 33, role: 'caseworker', username: 'user33', orgId: 1 },
      MSGS.messages
    );
  });

  it('maps service failures to 502', async () => {
    serviceMocks.runAssistantTurn.mockRejectedValue(new Error('model down'));
    const res = await request(appAs('therapist')).post('/admin/api/assistant/chat').send(MSGS);
    expect(res.status).toBe(502);
  });
});
