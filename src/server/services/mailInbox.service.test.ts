import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getUserByIdMock, listInboxMock, getInboxMessageMock, markInboxReadMock } = vi.hoisted(() => ({
  getUserByIdMock: vi.fn(),
  listInboxMock: vi.fn(),
  getInboxMessageMock: vi.fn(),
  markInboxReadMock: vi.fn(),
}));
vi.mock('../db/index.js', () => ({ getUserById: getUserByIdMock }));
vi.mock('../utils/emailApiClient.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/emailApiClient.js')>('../utils/emailApiClient.js');
  return {
    ...actual,
    listInbox: listInboxMock,
    getInboxMessage: getInboxMessageMock,
    markInboxRead: markInboxReadMock,
  };
});

import { listMailboxFor, readMailboxMessage, markMailboxMessageRead } from './mailInbox.service.js';
import { EmailApiError } from '../utils/emailApiClient.js';

const JANE = { userid: 3, username: 'jane', role: 'researcher', email: 'jane@byuisresearch.com' };
const RAW = {
  id: 'm1',
  received_at: '2026-11-01T20:00:00Z',
  envelope_to: 'Jane@byuisresearch.com',
  from: 'vendor@example.com',
  to: ['jane@byuisresearch.com'],
  subject: 'Re: filter',
  text: 'Hello Jane',
  html: '<p>Hello <b>Jane</b></p>',
  message_id: '<abc@example.com>',
  suspicious: false,
  injection_suspected: false,
  read: false,
  attachments: [{ id: 'a1', filename: 'x.pdf', content_type: 'application/pdf', size: 10, object_key: 'secret' }],
};

beforeEach(() => {
  getUserByIdMock.mockReset().mockResolvedValue(JANE);
  listInboxMock.mockReset().mockResolvedValue({
    messages: [
      {
        id: 'm1',
        received_at: RAW.received_at,
        from: RAW.from,
        to: RAW.to,
        subject: RAW.subject,
        preview: 'Hello Jane',
        read: false,
        suspicious: false,
        injection_suspected: false,
        attachments: 1,
      },
    ],
  });
  getInboxMessageMock.mockReset().mockResolvedValue(RAW);
  markInboxReadMock.mockReset().mockResolvedValue(undefined);
  delete process.env.STUDY_EMAIL_DOMAIN;
});

describe('mailbox scoping (ai-therapist-283 phase 3)', () => {
  it('lists with the caller address as the envelope filter', async () => {
    const out = await listMailboxFor(3, { limit: 20, unread: true });
    expect(listInboxMock).toHaveBeenCalledWith({ to: 'jane@byuisresearch.com', limit: 20, unread: true });
    expect(out.address).toBe('jane@byuisresearch.com');
    expect(out.messages[0]).toMatchObject({ id: 'm1', from: 'vendor@example.com', attachments: 1 });
  });

  it('refuses non-researchers and accounts without a study address', async () => {
    getUserByIdMock.mockResolvedValue({ ...JANE, role: 'therapist' });
    await expect(listMailboxFor(3)).rejects.toMatchObject({ status: 403 });
    getUserByIdMock.mockResolvedValue({ ...JANE, email: 'jane@gmail.com' });
    await expect(listMailboxFor(3)).rejects.toMatchObject({ status: 403 });
    expect(listInboxMock).not.toHaveBeenCalled();
  });

  it('reads a message delivered to the caller, text only, without storage keys', async () => {
    const m = await readMailboxMessage(3, 'm1');
    expect(getInboxMessageMock).toHaveBeenCalledWith('m1', 'jane@byuisresearch.com');
    expect(m.text).toBe('Hello Jane');
    expect((m as unknown as Record<string, unknown>).html).toBeUndefined();
    expect(m.attachment_files[0]).toEqual({ id: 'a1', filename: 'x.pdf', content_type: 'application/pdf', size: 10 });
    expect(m.message_id).toBe('<abc@example.com>');
  });

  it("404s a message the gateway reports for someone else's address (belt and braces)", async () => {
    getInboxMessageMock.mockResolvedValue({ ...RAW, envelope_to: 'other@byuisresearch.com' });
    await expect(readMailboxMessage(3, 'm1', { markRead: true })).rejects.toMatchObject({ status: 404 });
    expect(markInboxReadMock).not.toHaveBeenCalled();
  });

  it('open-and-mark is one operation scoped to the caller', async () => {
    const m = await readMailboxMessage(3, 'm1', { markRead: true });
    expect(markInboxReadMock).toHaveBeenCalledWith('m1', 'jane@byuisresearch.com', true);
    expect(m.read).toBe(true);
    expect(getInboxMessageMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-mark an already-read message', async () => {
    getInboxMessageMock.mockResolvedValue({ ...RAW, read: true });
    await readMailboxMessage(3, 'm1', { markRead: true });
    expect(markInboxReadMock).not.toHaveBeenCalled();
  });

  it('mark-read passes the caller scope to the gateway', async () => {
    await markMailboxMessageRead(3, 'm1', false);
    expect(markInboxReadMock).toHaveBeenCalledWith('m1', 'jane@byuisresearch.com', false);
  });

  it('maps gateway errors to the status they carry', async () => {
    getInboxMessageMock.mockRejectedValue(new EmailApiError('Message not found', 404));
    await expect(readMailboxMessage(3, 'nope')).rejects.toMatchObject({ status: 404 });
    listInboxMock.mockRejectedValue(new EmailApiError('mail gateway not configured', 503));
    await expect(listMailboxFor(3)).rejects.toMatchObject({ status: 503 });
  });
});
