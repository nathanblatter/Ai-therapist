// Participant messaging route tests (caseworker portal, messaging slice):
// self-scoped thread access with 404-over-403, frozen-thread 409 on send,
// risk-field scrubbing (participants see a flagged boolean, never scores),
// and the fire-and-forget safety scan on send.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  getThreadById: vi.fn(),
  listThreadsForClient: vi.fn(),
  listThreadMessages: vi.fn(),
  insertThreadMessage: vi.fn(),
  markThreadRead: vi.fn(),
  countUnreadForUser: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);

const { scanMock } = vi.hoisted(() => ({ scanMock: vi.fn() }));
vi.mock('../../services/messageSafety.service.js', () => ({
  scanThreadMessage: scanMock,
  userRoom: (id: number) => `user:${id}`,
}));

import publicMessagingRoutes from './messaging.routes.js';

const CLIENT_ID = 42;
const CLINICIAN_ID = 9;

function threadRow(overrides: Record<string, unknown> = {}) {
  return {
    thread_id: 5,
    org_id: 1,
    client_id: CLIENT_ID,
    clinician_id: CLINICIAN_ID,
    clinician_role: 'caseworker',
    status: 'active',
    frozen_at: null,
    frozen_reason: null,
    is_sandbox: false,
    created_at: '2026-08-27T00:00:00Z',
    last_message_at: null,
    ...overrides,
  };
}

function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    message_id: 101,
    thread_id: 5,
    sender_id: CLIENT_ID,
    sender_role: 'participant',
    body: 'hello there',
    created_at: '2026-08-27T00:00:01Z',
    risk_score: 55,
    risk_severity: 'medium',
    scan_status: 'flagged',
    crisis_event_id: 900,
    ...overrides,
  };
}

function appAs(userId: number | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = userId
      ? { userId, userRole: 'participant', username: 'p42' }
      : {};
    next();
  });
  app.use(publicMessagingRoutes());
  return app;
}

const emitMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getThreadById.mockResolvedValue(threadRow());
  dbMocks.listThreadsForClient.mockResolvedValue([
    { ...threadRow(), counterpart_username: 'cw1', unread_count: 2, last_message_preview: 'hi' },
  ]);
  dbMocks.listThreadMessages.mockResolvedValue([messageRow()]);
  dbMocks.insertThreadMessage.mockResolvedValue(
    messageRow({ risk_score: null, risk_severity: null, scan_status: 'pending', crisis_event_id: null })
  );
  dbMocks.markThreadRead.mockResolvedValue(undefined);
  dbMocks.countUnreadForUser.mockResolvedValue(2);
  // @ts-expect-error minimal socket.io stand-in
  global.io = { to: vi.fn(() => ({ emit: emitMock })) };
});

describe('GET /api/messaging/threads', () => {
  it('returns the caller threads with unread total, scrubbing org internals', async () => {
    const res = await request(appAs(CLIENT_ID)).get('/api/messaging/threads');
    expect(res.status).toBe(200);
    expect(res.body.unread_total).toBe(2);
    expect(res.body.threads[0]).toMatchObject({
      thread_id: 5, counterpart_username: 'cw1', unread_count: 2, status: 'active',
    });
    expect(res.body.threads[0]).not.toHaveProperty('org_id');
    expect(res.body.threads[0]).not.toHaveProperty('is_sandbox');
    expect(dbMocks.listThreadsForClient).toHaveBeenCalledWith(CLIENT_ID);
  });

  it('requires authentication', async () => {
    expect((await request(appAs(null)).get('/api/messaging/threads')).status).toBe(401);
  });
});

describe('GET /api/messaging/threads/:threadId/messages', () => {
  it('returns messages with risk fields scrubbed to a flagged boolean', async () => {
    const res = await request(appAs(CLIENT_ID)).get('/api/messaging/threads/5/messages');
    expect(res.status).toBe(200);
    expect(res.body.messages[0]).toMatchObject({ message_id: 101, body: 'hello there', flagged: true });
    expect(res.body.messages[0]).not.toHaveProperty('risk_score');
    expect(res.body.messages[0]).not.toHaveProperty('risk_severity');
    expect(res.body.messages[0]).not.toHaveProperty('scan_status');
    expect(res.body.messages[0]).not.toHaveProperty('crisis_event_id');
  });

  it('404s when the thread belongs to someone else (404-over-403)', async () => {
    dbMocks.getThreadById.mockResolvedValue(threadRow({ client_id: 777 }));
    const res = await request(appAs(CLIENT_ID)).get('/api/messaging/threads/5/messages');
    expect(res.status).toBe(404);
    expect(dbMocks.listThreadMessages).not.toHaveBeenCalled();
  });

  it('404s on a missing thread', async () => {
    dbMocks.getThreadById.mockResolvedValue(null);
    expect((await request(appAs(CLIENT_ID)).get('/api/messaging/threads/5/messages')).status).toBe(404);
  });
});

describe('POST /api/messaging/threads/:threadId/messages', () => {
  it('inserts a pending-scan message, fires the scan, and notifies the clinician room', async () => {
    const res = await request(appAs(CLIENT_ID))
      .post('/api/messaging/threads/5/messages')
      .send({ body: 'hello there' });
    expect(res.status).toBe(201);
    expect(res.body.message).toMatchObject({ message_id: 101, flagged: false });
    expect(res.body.message).not.toHaveProperty('risk_score');
    expect(dbMocks.insertThreadMessage).toHaveBeenCalledWith({
      threadId: 5, senderId: CLIENT_ID, senderRole: 'participant',
      body: 'hello there', scanStatus: 'pending',
    });
    expect(scanMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith('messaging:new-message', expect.objectContaining({ threadId: 5 }));
  });

  it('409s thread_frozen on a frozen thread', async () => {
    dbMocks.getThreadById.mockResolvedValue(threadRow({ status: 'frozen', frozen_reason: 'unassigned' }));
    const res = await request(appAs(CLIENT_ID))
      .post('/api/messaging/threads/5/messages')
      .send({ body: 'hello' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('thread_frozen');
    expect(dbMocks.insertThreadMessage).not.toHaveBeenCalled();
  });

  it('400s on empty and over-length bodies', async () => {
    expect(
      (await request(appAs(CLIENT_ID)).post('/api/messaging/threads/5/messages').send({ body: '   ' })).status
    ).toBe(400);
    expect(
      (await request(appAs(CLIENT_ID)).post('/api/messaging/threads/5/messages').send({ body: 'x'.repeat(4001) })).status
    ).toBe(400);
    expect(dbMocks.insertThreadMessage).not.toHaveBeenCalled();
  });

  it('404s a non-party sender', async () => {
    dbMocks.getThreadById.mockResolvedValue(threadRow({ client_id: 777 }));
    const res = await request(appAs(CLIENT_ID))
      .post('/api/messaging/threads/5/messages')
      .send({ body: 'hello' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/messaging/threads/:threadId/read', () => {
  it('advances the read pointer and echoes to the clinician', async () => {
    const res = await request(appAs(CLIENT_ID))
      .post('/api/messaging/threads/5/read')
      .send({ last_read_message_id: 101 });
    expect(res.status).toBe(200);
    expect(dbMocks.markThreadRead).toHaveBeenCalledWith(5, CLIENT_ID, 101);
    expect(emitMock).toHaveBeenCalledWith('messaging:read', {
      threadId: 5, lastReadMessageId: 101, readerId: CLIENT_ID,
    });
  });

  it('400s on a bad pointer', async () => {
    const res = await request(appAs(CLIENT_ID))
      .post('/api/messaging/threads/5/read')
      .send({ last_read_message_id: 'nope' });
    expect(res.status).toBe(400);
    expect(dbMocks.markThreadRead).not.toHaveBeenCalled();
  });
});
