import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getUserByIdMock, reserveMock, verdictMock, countTodayMock, sendMailFromMock } = vi.hoisted(() => ({
  getUserByIdMock: vi.fn(),
  reserveMock: vi.fn(),
  verdictMock: vi.fn(),
  countTodayMock: vi.fn(),
  sendMailFromMock: vi.fn(),
}));
vi.mock('../db/index.js', () => ({
  getUserById: getUserByIdMock,
  reserveOutboundMail: reserveMock,
  setOutboundMailVerdict: verdictMock,
  countOutboundMailToday: countTodayMock,
}));
vi.mock('./emailer.service.js', () => ({ sendMailFrom: sendMailFromMock }));

import {
  sendStaffMail,
  senderStatus,
  normalizeRecipients,
  participantContentReason,
  MailComposeError,
} from './mailCompose.service.js';

const RESEARCHER = { userid: 3, username: 'jane', role: 'researcher', email: 'jane@byuisresearch.com' };

beforeEach(() => {
  getUserByIdMock.mockReset().mockResolvedValue(RESEARCHER);
  countTodayMock.mockReset().mockResolvedValue(0);
  sendMailFromMock.mockReset().mockResolvedValue({ status: 'sent', gatewayId: 'gw-1' });
  reserveMock.mockReset().mockImplementation(async (input: Record<string, unknown>) => ({
    mail_id: 11,
    status: 'pending',
    ...input,
  }));
  verdictMock.mockReset().mockImplementation(async (mailId: number, v: Record<string, unknown>) => ({
    mail_id: mailId,
    ...v,
  }));
  delete process.env.STUDY_EMAIL_DOMAIN;
  delete process.env.STAFF_MAIL_DAILY_CAP;
});

describe('helpers', () => {
  it('normalizeRecipients trims, lower-cases, dedupes, splits strings, rejects junk', () => {
    expect(normalizeRecipients(' A@X.com, b@y.org a@x.com ', 'recipient')).toEqual(['a@x.com', 'b@y.org']);
    expect(normalizeRecipients(['c@z.io'], 'recipient')).toEqual(['c@z.io']);
    expect(() => normalizeRecipients('nope', 'recipient')).toThrow(MailComposeError);
    expect(() => normalizeRecipients([42], 'cc')).toThrow(MailComposeError);
  });
  it('participantContentReason catches real session ids and not ordinary vocabulary', () => {
    expect(participantContentReason('see live_u7_Efaf4p3oNCT16l0N9RcC0aaKTqqx04Zf please')).toMatch(/session id/);
    expect(participantContentReason('grok_f0dc8564 was flagged')).toMatch(/session id/);
    expect(participantContentReason('chat_1762045678901_k3j9x ended')).toMatch(/session id/);
    expect(participantContentReason('Hello, following up on our call about the filter.')).toBeNull();
    expect(participantContentReason('the chat_completions endpoint and session_limits config')).toBeNull();
    expect(participantContentReason('live_delegation cost line')).toBeNull();
  });
});

describe('senderStatus', () => {
  it('requires a researcher with an address on the study domain, under the cap', async () => {
    expect((await senderStatus(3)).canSend).toBe(true);
    getUserByIdMock.mockResolvedValue({ ...RESEARCHER, role: 'therapist' });
    expect((await senderStatus(3)).reason).toMatch(/researcher/);
    getUserByIdMock.mockResolvedValue({ ...RESEARCHER, email: 'jane@gmail.com' });
    expect((await senderStatus(3)).reason).toMatch(/Provision a study address/);
    getUserByIdMock.mockResolvedValue(RESEARCHER);
    countTodayMock.mockResolvedValue(50);
    expect((await senderStatus(3)).reason).toMatch(/Daily sending cap/);
  });
});

describe('sendStaffMail', () => {
  it('sends from the study address, records the row, returns it', async () => {
    const row = await sendStaffMail({
      senderUserId: 3,
      to: 'contact@openai.com',
      cc: 'pi@byu.edu',
      subject: 'Content filter on GPT-Live',
      text: 'Hello,\n\nWe run an IRB-backed study...',
    });
    expect(sendMailFromMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '"jane (AI Therapist Study)" <jane@byuisresearch.com>',
        to: ['contact@openai.com'],
        cc: ['pi@byu.edu'],
        replyTo: 'jane@byuisresearch.com',
        subject: 'Content filter on GPT-Live',
      }),
    );
    // Reserved (pending, under the cap) BEFORE the gateway was asked; verdict written after.
    expect(reserveMock).toHaveBeenCalledWith(
      expect.objectContaining({ sentBy: 3, toAddresses: ['contact@openai.com'], ccAddresses: ['pi@byu.edu'] }),
      50,
    );
    expect(reserveMock.mock.invocationCallOrder[0]).toBeLessThan(sendMailFromMock.mock.invocationCallOrder[0]);
    expect(verdictMock).toHaveBeenCalledWith(11, { status: 'sent', gatewayId: 'gw-1', error: null });
    expect(row.mail_id).toBe(11);
  });

  it('quotes the display name so an email-shaped username cannot break the From header', async () => {
    getUserByIdMock.mockResolvedValue({ ...RESEARCHER, username: 'jane.doe@byu.edu' });
    await sendStaffMail({ senderUserId: 3, to: 'a@b.co', subject: 's', text: 't' });
    expect(sendMailFromMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: '"jane.doe@byu.edu (AI Therapist Study)" <jane@byuisresearch.com>' }),
    );
  });

  it('validates in_reply_to as a Message-ID', async () => {
    await expect(
      sendStaffMail({ senderUserId: 3, to: 'a@b.co', subject: 's', text: 't', inReplyTo: 'x\r\nBcc: evil@x.io' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(sendMailFromMock).not.toHaveBeenCalled();
  });

  it('the cap is enforced at reservation time too (concurrent senders)', async () => {
    reserveMock.mockResolvedValue(null);
    await expect(sendStaffMail({ senderUserId: 3, to: 'a@b.co', subject: 's', text: 't' })).rejects.toMatchObject({
      status: 429,
    });
    expect(sendMailFromMock).not.toHaveBeenCalled();
  });

  it('threads a reply through In-Reply-To / References', async () => {
    await sendStaffMail({ senderUserId: 3, to: 'a@b.co', subject: 'Re: x', text: 'y', inReplyTo: '<m1@x>' });
    expect(sendMailFromMock).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { 'In-Reply-To': '<m1@x>', References: '<m1@x>' } }),
    );
  });

  it('refuses participant content before touching the gateway', async () => {
    await expect(
      sendStaffMail({
        senderUserId: 3,
        to: 'a@b.co',
        subject: 'x',
        text: 'see session live_u7_Efaf4p3oNCT16l0N9RcC0aaKTqqx04Zf',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(sendMailFromMock).not.toHaveBeenCalled();
    expect(reserveMock).not.toHaveBeenCalled();
  });

  it('validates recipients, subject, body and the recipient count', async () => {
    const base = { senderUserId: 3, subject: 's', text: 't' };
    await expect(sendStaffMail({ ...base, to: '' })).rejects.toMatchObject({ status: 400 });
    await expect(sendStaffMail({ ...base, to: 'a@b.co', subject: '' })).rejects.toMatchObject({ status: 400 });
    await expect(sendStaffMail({ ...base, to: 'a@b.co', text: '   ' })).rejects.toMatchObject({ status: 400 });
    const many = Array.from({ length: 11 }, (_, i) => `r${i}@x.io`);
    await expect(sendStaffMail({ ...base, to: many })).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a non-researcher (403) and an exhausted cap (429)', async () => {
    getUserByIdMock.mockResolvedValue({ ...RESEARCHER, role: 'therapist' });
    await expect(sendStaffMail({ senderUserId: 3, to: 'a@b.co', subject: 's', text: 't' })).rejects.toMatchObject({
      status: 403,
    });
    getUserByIdMock.mockResolvedValue(RESEARCHER);
    process.env.STAFF_MAIL_DAILY_CAP = '2';
    countTodayMock.mockResolvedValue(2);
    await expect(sendStaffMail({ senderUserId: 3, to: 'a@b.co', subject: 's', text: 't' })).rejects.toMatchObject({
      status: 429,
    });
  });

  it('records a gateway refusal as failed and surfaces it as 502', async () => {
    sendMailFromMock.mockResolvedValue({ status: 'failed', error: 'email-api /send answered 400: bad address' });
    await expect(sendStaffMail({ senderUserId: 3, to: 'a@b.co', subject: 's', text: 't' })).rejects.toMatchObject({
      status: 502,
    });
    expect(verdictMock).toHaveBeenCalledWith(11, expect.objectContaining({ status: 'failed' }));
  });

  it('a queued verdict is returned as queued, not an error', async () => {
    sendMailFromMock.mockResolvedValue({ status: 'queued', gatewayId: 'q-9' });
    const row = await sendStaffMail({ senderUserId: 3, to: 'a@b.co', subject: 's', text: 't' });
    expect(row.status).toBe('queued');
  });
});
