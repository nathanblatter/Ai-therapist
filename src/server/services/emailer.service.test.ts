// Emailer degrade-to-no-op contract: no SMTP env, kill switch off, missing
// nodemailer dependency, and transport failures must all resolve without
// throwing — a delivery problem can never reach the callers in the crisis /
// work-queue paths.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getSystemConfigByKeyMock } = vi.hoisted(() => ({
  getSystemConfigByKeyMock: vi.fn(),
}));
vi.mock('../db/index.js', () => ({
  getSystemConfigByKey: getSystemConfigByKeyMock,
}));

import { sendEmail, _setTransportFactoryForTests, type MailTransport } from './emailer.service.js';

const SMTP_KEYS = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'EMAIL_FROM',
  'EMAIL_API_URL',
  'EMAIL_API_KEY',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of SMTP_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  getSystemConfigByKeyMock.mockResolvedValue(null); // no kill-switch row
  _setTransportFactoryForTests(null);
});

afterEach(() => {
  for (const key of SMTP_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  _setTransportFactoryForTests(null);
});

function configureSmtpEnv() {
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_PORT = '587';
  process.env.SMTP_USER = 'mailer';
  process.env.SMTP_PASS = 'secret';
  process.env.EMAIL_FROM = 'alerts@example.com';
}

function configureEmailApiEnv() {
  process.env.EMAIL_API_URL = 'http://email-api.test:4500/';
  process.env.EMAIL_API_KEY = 'k-test';
  process.env.EMAIL_FROM = 'AI Therapist <alerts@byuisresearch.com>';
}

const EMAIL = { to: 'cw@example.com', subject: 'Care team alert', text: 'body' };

describe('sendEmail', () => {
  it('skips when SMTP env is absent, without touching a transport', async () => {
    const factory = vi.fn();
    _setTransportFactoryForTests(factory);
    expect(await sendEmail(EMAIL)).toBe('skipped');
    expect(factory).not.toHaveBeenCalled();
  });

  it('skips when the recipient address is empty', async () => {
    configureSmtpEnv();
    expect(await sendEmail({ ...EMAIL, to: '  ' })).toBe('skipped');
  });

  it('skips when the email_notifications kill switch is off', async () => {
    configureSmtpEnv();
    const sendMail = vi.fn();
    _setTransportFactoryForTests(async () => ({ sendMail }));
    getSystemConfigByKeyMock.mockResolvedValue({ config_key: 'email_notifications', config_value: { enabled: false } });
    expect(await sendEmail(EMAIL)).toBe('skipped');
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('honors a bare-boolean kill switch value', async () => {
    configureSmtpEnv();
    getSystemConfigByKeyMock.mockResolvedValue({ config_key: 'email_notifications', config_value: false });
    expect(await sendEmail(EMAIL)).toBe('skipped');
  });

  it('sends via the transport with the configured from address', async () => {
    configureSmtpEnv();
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'x' });
    _setTransportFactoryForTests(async () => ({ sendMail }));
    expect(await sendEmail(EMAIL)).toBe('sent');
    expect(sendMail).toHaveBeenCalledWith({
      from: 'alerts@example.com',
      to: 'cw@example.com',
      subject: 'Care team alert',
      text: 'body',
    });
  });

  it('caches the transport across sends', async () => {
    configureSmtpEnv();
    const sendMail = vi.fn().mockResolvedValue({});
    const factory = vi.fn(async (): Promise<MailTransport> => ({ sendMail }));
    _setTransportFactoryForTests(factory);
    await sendEmail(EMAIL);
    await sendEmail(EMAIL);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it('returns failed (never throws) when the transport errors', async () => {
    configureSmtpEnv();
    _setTransportFactoryForTests(async () => ({
      sendMail: vi.fn().mockRejectedValue(new Error('smtp down')),
    }));
    expect(await sendEmail(EMAIL)).toBe('failed');
  });

  it('default factory never throws: unreachable SMTP resolves to failed (nodemailer installed)', async () => {
    configureSmtpEnv();
    // No injected factory: nodemailer is a real dependency now (integration
    // slice), so the lazy import succeeds and a real transport is built; the
    // send to the fake host must resolve to 'failed' without throwing.
    // (Before the dependency landed this same path degraded to 'skipped'.)
    expect(await sendEmail(EMAIL)).toBe('failed');
  });

  it('defaults to enabled when the kill-switch lookup fails', async () => {
    configureSmtpEnv();
    getSystemConfigByKeyMock.mockRejectedValue(new Error('db down'));
    const sendMail = vi.fn().mockResolvedValue({});
    _setTransportFactoryForTests(async () => ({ sendMail }));
    expect(await sendEmail(EMAIL)).toBe('sent');
  });

  describe('email-api transport', () => {
    const fetchMock = vi.fn();
    beforeEach(() => {
      fetchMock.mockReset();
      vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function reply(status: number, body: unknown = {}) {
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }

    it('POSTs /send with the key and the configured from address', async () => {
      configureEmailApiEnv();
      fetchMock.mockResolvedValue(reply(200, { status: 'sent' }));
      expect(await sendEmail(EMAIL)).toBe('sent');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://email-api.test:4500/send');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['X-API-Key']).toBe('k-test');
      expect(JSON.parse(String(init.body))).toEqual({
        from: 'AI Therapist <alerts@byuisresearch.com>',
        to: ['cw@example.com'],
        subject: 'Care team alert',
        text: 'body',
      });
    });

    it('treats 202 queued (email-api spooled it) as sent', async () => {
      configureEmailApiEnv();
      fetchMock.mockResolvedValue(reply(202, { status: 'queued', reason: 'relay_down' }));
      expect(await sendEmail(EMAIL)).toBe('sent');
    });

    it('returns failed (never throws) on a non-2xx answer or a network error', async () => {
      configureEmailApiEnv();
      fetchMock.mockResolvedValue(reply(401, { error: 'unauthorized' }));
      expect(await sendEmail(EMAIL)).toBe('failed');
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await sendEmail(EMAIL)).toBe('failed');
    });

    it('takes precedence over SMTP when both are configured', async () => {
      configureSmtpEnv();
      configureEmailApiEnv();
      fetchMock.mockResolvedValue(reply(200, { status: 'sent' }));
      expect(await sendEmail(EMAIL)).toBe('sent');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('is not used without a key: falls through to SMTP', async () => {
      configureSmtpEnv();
      process.env.EMAIL_API_URL = 'http://email-api.test:4500';
      const sendMail = vi.fn().mockResolvedValue({});
      _setTransportFactoryForTests(async () => ({ sendMail }));
      expect(await sendEmail(EMAIL)).toBe('sent');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sendMail).toHaveBeenCalledTimes(1);
    });
  });
});
