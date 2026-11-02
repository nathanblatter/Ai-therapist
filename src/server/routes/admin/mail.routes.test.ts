import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({ listOutboundMailForUser: vi.fn() }));
const svcMocks = vi.hoisted(() => ({ sendStaffMail: vi.fn(), senderStatus: vi.fn() }));
const inboxMocks = vi.hoisted(() => ({
  listMailboxFor: vi.fn(),
  readMailboxMessage: vi.fn(),
  markMailboxMessageRead: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);
vi.mock('../../services/mailCompose.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/mailCompose.service.js')>(
    '../../services/mailCompose.service.js',
  );
  return { ...actual, sendStaffMail: svcMocks.sendStaffMail, senderStatus: svcMocks.senderStatus };
});

vi.mock('../../services/mailInbox.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/mailInbox.service.js')>(
    '../../services/mailInbox.service.js',
  );
  return { ...actual, ...inboxMocks };
});

import mailRoutes from './mail.routes.js';
import { MailInboxError } from '../../services/mailInbox.service.js';
import { MailComposeError } from '../../services/mailCompose.service.js';

function appAs(role: string | null, userId = 3) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = role
      ? { userId, userRole: role, username: 'jane' }
      : {};
    next();
  });
  app.use(mailRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  svcMocks.senderStatus.mockResolvedValue({
    address: 'jane@byuisresearch.com',
    username: 'jane',
    domain: 'byuisresearch.com',
    canSend: true,
    blocked: null,
    reason: null,
    sentToday: 1,
    dailyCap: 50,
  });
  svcMocks.sendStaffMail.mockResolvedValue({ mail_id: 1, status: 'sent', body_text: 'secret body' });
  dbMocks.listOutboundMailForUser.mockResolvedValue([{ mail_id: 1, subject: 'x' }]);
  inboxMocks.listMailboxFor.mockResolvedValue({ address: 'jane@byuisresearch.com', messages: [] });
  inboxMocks.readMailboxMessage.mockResolvedValue({ id: 'm1', text: 'hi' });
  inboxMocks.markMailboxMessageRead.mockResolvedValue(undefined);
});

describe('mail routes (ai-therapist-283 phase 2)', () => {
  it('is researcher-only', async () => {
    for (const role of ['therapist', 'caseworker', 'participant', null]) {
      expect((await request(appAs(role)).get('/admin/api/mail/me')).status).toBeGreaterThanOrEqual(401);
      expect((await request(appAs(role)).post('/admin/api/mail/send').send({})).status).toBeGreaterThanOrEqual(401);
    }
    expect(svcMocks.sendStaffMail).not.toHaveBeenCalled();
  });

  it('GET /me returns the sender status', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/mail/me');
    expect(res.status).toBe(200);
    expect(res.body.address).toBe('jane@byuisresearch.com');
    expect(svcMocks.senderStatus).toHaveBeenCalledWith(3);
  });

  it('POST /send passes the body through as the caller and omits the body text in the reply', async () => {
    const res = await request(appAs('researcher', 7))
      .post('/admin/api/mail/send')
      .send({ to: 'a@b.co', subject: 's', text: 't', in_reply_to: '<m@x>' });
    expect(res.status).toBe(200);
    expect(svcMocks.sendStaffMail).toHaveBeenCalledWith({
      senderUserId: 7,
      to: 'a@b.co',
      cc: undefined,
      subject: 's',
      text: 't',
      inReplyTo: '<m@x>',
    });
    expect(res.body.mail.body_text).toBeUndefined();
  });

  it('maps MailComposeError to its status', async () => {
    svcMocks.sendStaffMail.mockRejectedValue(new MailComposeError('Not sent: participant content', 400));
    const res = await request(appAs('researcher')).post('/admin/api/mail/send').send({ to: 'a@b.co' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/participant content/);
  });

  it("GET /sent lists only the caller's mail", async () => {
    const res = await request(appAs('researcher', 7)).get('/admin/api/mail/sent?limit=10');
    expect(res.status).toBe(200);
    expect(dbMocks.listOutboundMailForUser).toHaveBeenCalledWith(7, { limit: 10, offset: 0 });
  });
});

describe('inbox routes (phase 3)', () => {
  it('are researcher-only and scoped to the caller', async () => {
    expect((await request(appAs('therapist')).get('/admin/api/mail/inbox')).status).toBeGreaterThanOrEqual(401);
    const res = await request(appAs('researcher', 7)).get('/admin/api/mail/inbox?limit=5&unread=1');
    expect(res.status).toBe(200);
    expect(inboxMocks.listMailboxFor).toHaveBeenCalledWith(7, { limit: 5, unread: true });
  });

  it('reads and marks a message through the service, mapping its errors', async () => {
    const read = await request(appAs('researcher', 7)).get('/admin/api/mail/inbox/m1?mark_read=1');
    expect(read.status).toBe(200);
    expect(inboxMocks.readMailboxMessage).toHaveBeenCalledWith(7, 'm1', { markRead: true });
    const mark = await request(appAs('researcher', 7)).post('/admin/api/mail/inbox/m1/read').send({ read: false });
    expect(mark.status).toBe(200);
    expect(inboxMocks.markMailboxMessageRead).toHaveBeenCalledWith(7, 'm1', false);
    inboxMocks.readMailboxMessage.mockRejectedValue(new MailInboxError('Message not found', 404));
    expect((await request(appAs('researcher', 7)).get('/admin/api/mail/inbox/other')).status).toBe(404);
  });
});
