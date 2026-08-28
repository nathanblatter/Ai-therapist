// Clinician messaging route tests (caseworker portal, messaging slice):
// role allowlist (researchers blocked v1), own-thread-only access with
// 404-over-403, assignment-verified get-or-create, frozen-thread 409, and
// the caseload-scoped flagged-message feed.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  // route queries
  getOrCreateThread: vi.fn(),
  getThreadForPair: vi.fn(),
  listThreadsForClinician: vi.fn(),
  listThreadMessages: vi.fn(),
  insertThreadMessage: vi.fn(),
  markThreadRead: vi.fn(),
  countUnreadForUser: vi.fn(),
  isSandboxAccount: vi.fn(),
  listMessageOriginCrisisEvents: vi.fn(),
  // middleware dependencies (caseload / messaging / org gates)
  isAssigned: vi.fn(),
  getThreadById: vi.fn(),
  getOrganizationIdForUser: vi.fn(),
  getIrbStudyOrgId: vi.fn(),
  getSessionAccessInfo: vi.fn(),
  getMessageOwner: vi.fn(),
  getCareNoteById: vi.fn(),
  getEscalationById: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);

import adminMessagingRoutes from './messaging.routes.js';

const CLINICIAN_ID = 9;
const CLIENT_ID = 42;

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

function appAs(role: string | null, userId = CLINICIAN_ID) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = role
      ? { userId, userRole: role, username: 'cw1', orgId: 1 }
      : {};
    next();
  });
  app.use(adminMessagingRoutes());
  return app;
}

const emitMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getThreadById.mockResolvedValue(threadRow());
  dbMocks.getThreadForPair.mockResolvedValue(threadRow());
  dbMocks.getOrCreateThread.mockResolvedValue(threadRow());
  dbMocks.listThreadsForClinician.mockResolvedValue([
    { ...threadRow(), counterpart_username: 'p42', unread_count: 1, last_message_preview: 'hi' },
  ]);
  dbMocks.listThreadMessages.mockResolvedValue([messageRow()]);
  dbMocks.insertThreadMessage.mockResolvedValue(
    messageRow({ sender_id: CLINICIAN_ID, sender_role: 'caseworker', risk_score: null, risk_severity: null, scan_status: 'not_applicable', crisis_event_id: null })
  );
  dbMocks.markThreadRead.mockResolvedValue(undefined);
  dbMocks.countUnreadForUser.mockResolvedValue(1);
  dbMocks.isSandboxAccount.mockResolvedValue(false);
  dbMocks.isAssigned.mockResolvedValue(true);
  dbMocks.getOrganizationIdForUser.mockResolvedValue(1);
  dbMocks.listMessageOriginCrisisEvents.mockResolvedValue([
    { event_id: 900, client_user_id: CLIENT_ID, severity: 'medium', thread_id: 5 },
  ]);
  // @ts-expect-error minimal socket.io stand-in
  global.io = { to: vi.fn(() => ({ emit: emitMock })) };
});

describe('GET /api/admin/messaging/inbox', () => {
  it('returns the clinician threads and unread total', async () => {
    const res = await request(appAs('caseworker')).get('/api/admin/messaging/inbox');
    expect(res.status).toBe(200);
    expect(res.body.unread_total).toBe(1);
    expect(res.body.threads[0]).toMatchObject({ thread_id: 5, counterpart_username: 'p42' });
    expect(dbMocks.listThreadsForClinician).toHaveBeenCalledWith(CLINICIAN_ID);
  });

  it('blocks researchers (clinical correspondence, not study data) and participants', async () => {
    expect((await request(appAs('researcher')).get('/api/admin/messaging/inbox')).status).toBe(403);
    expect((await request(appAs('participant')).get('/api/admin/messaging/inbox')).status).toBe(403);
    expect((await request(appAs(null)).get('/api/admin/messaging/inbox')).status).toBe(401);
  });
});

describe('POST /api/admin/messaging/threads', () => {
  it('creates (or revives) the pair thread for an assigned client', async () => {
    const res = await request(appAs('caseworker'))
      .post('/api/admin/messaging/threads')
      .send({ client_id: CLIENT_ID });
    expect(res.status).toBe(201);
    expect(res.body.thread.thread_id).toBe(5);
    expect(dbMocks.getOrCreateThread).toHaveBeenCalledWith({
      clientId: CLIENT_ID, clinicianId: CLINICIAN_ID, clinicianRole: 'caseworker',
      orgId: 1, isSandbox: false,
    });
  });

  it('404s (not 403) for a client not on the caseload', async () => {
    dbMocks.isAssigned.mockResolvedValue(false);
    const res = await request(appAs('caseworker'))
      .post('/api/admin/messaging/threads')
      .send({ client_id: CLIENT_ID });
    expect(res.status).toBe(404);
    expect(dbMocks.getOrCreateThread).not.toHaveBeenCalled();
  });

  it('stamps is_sandbox from the client account', async () => {
    dbMocks.isSandboxAccount.mockResolvedValue(true);
    await request(appAs('therapist')).post('/api/admin/messaging/threads').send({ client_id: CLIENT_ID });
    expect(dbMocks.getOrCreateThread).toHaveBeenCalledWith(
      expect.objectContaining({ isSandbox: true, clinicianRole: 'therapist' })
    );
  });

  it('400s on a non-numeric client_id', async () => {
    const res = await request(appAs('caseworker'))
      .post('/api/admin/messaging/threads')
      .send({ client_id: 'abc' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/admin/messaging/threads/:threadId/messages', () => {
  it('returns full message rows (scan fields included) for the own thread', async () => {
    const res = await request(appAs('caseworker')).get('/api/admin/messaging/threads/5/messages');
    expect(res.status).toBe(200);
    expect(res.body.messages[0]).toMatchObject({
      message_id: 101, scan_status: 'flagged', risk_severity: 'medium',
    });
  });

  it('404s another clinician thread (404-over-403)', async () => {
    dbMocks.getThreadById.mockResolvedValue(threadRow({ clinician_id: 777 }));
    const res = await request(appAs('caseworker')).get('/api/admin/messaging/threads/5/messages');
    expect(res.status).toBe(404);
    expect(dbMocks.listThreadMessages).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/messaging/threads/:threadId/messages', () => {
  it('sends with the session role, unscanned, and echoes to the client room', async () => {
    const res = await request(appAs('caseworker'))
      .post('/api/admin/messaging/threads/5/messages')
      .send({ body: 'checking in' });
    expect(res.status).toBe(201);
    expect(dbMocks.insertThreadMessage).toHaveBeenCalledWith({
      threadId: 5, senderId: CLINICIAN_ID, senderRole: 'caseworker',
      body: 'checking in', scanStatus: 'not_applicable',
    });
    expect(emitMock).toHaveBeenCalledWith('messaging:new-message', expect.objectContaining({ threadId: 5 }));
    // Participant echo carries no scan internals.
    const echoed = emitMock.mock.calls.find((c) => c[0] === 'messaging:new-message')?.[1];
    expect(echoed.message).not.toHaveProperty('risk_score');
    expect(echoed.message).not.toHaveProperty('scan_status');
  });

  it('409s thread_frozen on a frozen thread', async () => {
    dbMocks.getThreadById.mockResolvedValue(threadRow({ status: 'frozen', frozen_reason: 'unassigned' }));
    const res = await request(appAs('caseworker'))
      .post('/api/admin/messaging/threads/5/messages')
      .send({ body: 'hello' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('thread_frozen');
  });

  it('400s empty bodies', async () => {
    const res = await request(appAs('caseworker'))
      .post('/api/admin/messaging/threads/5/messages')
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/admin/messaging/threads/:threadId/read', () => {
  it('advances the pointer and echoes to the client', async () => {
    const res = await request(appAs('caseworker'))
      .post('/api/admin/messaging/threads/5/read')
      .send({ last_read_message_id: 101 });
    expect(res.status).toBe(200);
    expect(dbMocks.markThreadRead).toHaveBeenCalledWith(5, CLINICIAN_ID, 101);
    expect(emitMock).toHaveBeenCalledWith('messaging:read', {
      threadId: 5, lastReadMessageId: 101, readerId: CLINICIAN_ID,
    });
  });
});

describe('GET /api/admin/messaging/clients/:userId/threads', () => {
  it('returns only the caller own thread with the client', async () => {
    const res = await request(appAs('caseworker')).get(`/api/admin/messaging/clients/${CLIENT_ID}/threads`);
    expect(res.status).toBe(200);
    expect(res.body.threads).toHaveLength(1);
    expect(dbMocks.getThreadForPair).toHaveBeenCalledWith(CLIENT_ID, CLINICIAN_ID);
  });

  it('404s off-caseload clients for care-team members', async () => {
    dbMocks.isAssigned.mockResolvedValue(false);
    const res = await request(appAs('caseworker')).get(`/api/admin/messaging/clients/${CLIENT_ID}/threads`);
    expect(res.status).toBe(404);
    expect(dbMocks.getThreadForPair).not.toHaveBeenCalled();
  });

  it('returns an empty list when no thread exists yet', async () => {
    dbMocks.getThreadForPair.mockResolvedValue(null);
    const res = await request(appAs('therapist')).get(`/api/admin/messaging/clients/${CLIENT_ID}/threads`);
    expect(res.status).toBe(200);
    expect(res.body.threads).toEqual([]);
  });
});

describe('GET /api/admin/messaging/flagged', () => {
  it('scopes care-team members to their caseload', async () => {
    const res = await request(appAs('caseworker')).get('/api/admin/messaging/flagged');
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(dbMocks.listMessageOriginCrisisEvents).toHaveBeenCalledWith(CLINICIAN_ID);
  });

  it('researchers read org-scoped (C13)', async () => {
    await request(appAs('researcher', 7)).get('/api/admin/messaging/flagged');
    expect(dbMocks.listMessageOriginCrisisEvents).toHaveBeenCalledWith(null, 1);
  });

  it('legacy null-org researchers resolve to the irb-study default org (orgIdFor contract)', async () => {
    dbMocks.getOrganizationIdForUser.mockResolvedValue(null);
    dbMocks.getIrbStudyOrgId.mockResolvedValue(1);
    // Session without an orgId stamp so orgIdFor must resolve.
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { session: Record<string, unknown> }).session = {
        userId: 7, userRole: 'researcher', username: 'r1',
      };
      next();
    });
    app.use(adminMessagingRoutes());
    const res = await request(app).get('/api/admin/messaging/flagged');
    expect(res.status).toBe(200);
    expect(dbMocks.listMessageOriginCrisisEvents).toHaveBeenCalledWith(null, 1);
  });

  it('researchers fail closed (500, no unscoped read) when the org lookup fails', async () => {
    dbMocks.getOrganizationIdForUser.mockRejectedValue(new Error('db down'));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { session: Record<string, unknown> }).session = {
        userId: 7, userRole: 'researcher', username: 'r1',
      };
      next();
    });
    app.use(adminMessagingRoutes());
    const res = await request(app).get('/api/admin/messaging/flagged');
    expect(res.status).toBe(500);
    expect(dbMocks.listMessageOriginCrisisEvents).not.toHaveBeenCalled();
  });

  it('participants are blocked', async () => {
    expect((await request(appAs('participant')).get('/api/admin/messaging/flagged')).status).toBe(403);
  });

  // ai-therapist-143: message-origin crisis_events carry risk_factors/notes that
  // can quote verbatim participant keywords on the LLM-fallback path. Caseworkers
  // (summary tier) must never receive those fields; therapists (full tier) do.
  it('strips verbatim crisis fields (risk_factors/notes) for caseworkers', async () => {
    dbMocks.listMessageOriginCrisisEvents.mockResolvedValue([
      { event_id: 900, client_user_id: CLIENT_ID, severity: 'high', thread_id: 5,
        risk_factors: ['kill myself'], notes: 'Message risk score: 90 - Factors: kill myself',
        intervention_details: 'x' },
    ]);
    const res = await request(appAs('caseworker')).get('/api/admin/messaging/flagged');
    expect(res.status).toBe(200);
    const event = res.body.events[0];
    expect(event).not.toHaveProperty('risk_factors');
    expect(event).not.toHaveProperty('notes');
    expect(event).not.toHaveProperty('intervention_details');
    // Summary fields still pass through.
    expect(event).toMatchObject({ event_id: 900, severity: 'high' });
    expect(JSON.stringify(res.body)).not.toContain('kill myself');
  });

  it('keeps the full crisis fields for full-tier therapists', async () => {
    dbMocks.listMessageOriginCrisisEvents.mockResolvedValue([
      { event_id: 900, client_user_id: CLIENT_ID, severity: 'high', thread_id: 5,
        risk_factors: ['kill myself'], notes: 'detail' },
    ]);
    const res = await request(appAs('therapist')).get('/api/admin/messaging/flagged');
    expect(res.status).toBe(200);
    expect(res.body.events[0]).toHaveProperty('risk_factors', ['kill myself']);
    expect(res.body.events[0]).toHaveProperty('notes', 'detail');
  });
});
