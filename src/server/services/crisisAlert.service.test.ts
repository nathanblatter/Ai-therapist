import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getSystemConfigMock } = vi.hoisted(() => ({ getSystemConfigMock: vi.fn() }));
vi.mock('../utils/sessionHelpers.js', () => ({ getSystemConfig: getSystemConfigMock }));

const fetchMock = vi.fn();

describe('sendCrisisAlert', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    getSystemConfigMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    process.env.IMESSAGE_API_KEY = 'test-key';
    process.env.CRISIS_ALERT_PHONE = '+15550000000';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.IMESSAGE_API_KEY;
    delete process.env.CRISIS_ALERT_PHONE;
  });

  it('sends to the admin-configured phone when set, not the env fallback', async () => {
    getSystemConfigMock.mockResolvedValue({ crisis_alert: { enabled: true, phone: '+19995551111' } });
    fetchMock.mockResolvedValue({ ok: true });

    const { sendCrisisAlert } = await import('./crisisAlert.service.js');
    await sendCrisisAlert('test message');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.recipient).toBe('+19995551111');
  });

  it('falls back to the env phone when config has none set', async () => {
    getSystemConfigMock.mockResolvedValue({ crisis_alert: { enabled: true, phone: null } });
    fetchMock.mockResolvedValue({ ok: true });

    const { sendCrisisAlert } = await import('./crisisAlert.service.js');
    await sendCrisisAlert('test message');

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.recipient).toBe('+15550000000');
  });

  it('does not send when disabled via admin config', async () => {
    getSystemConfigMock.mockResolvedValue({ crisis_alert: { enabled: false, phone: '+19995551111' } });

    const { sendCrisisAlert } = await import('./crisisAlert.service.js');
    await sendCrisisAlert('test message');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a missing crisis_alert config as enabled (legacy env-only behavior)', async () => {
    getSystemConfigMock.mockResolvedValue({});
    fetchMock.mockResolvedValue({ ok: true });

    const { sendCrisisAlert } = await import('./crisisAlert.service.js');
    await sendCrisisAlert('test message');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never throws when the config lookup fails (fail-safe)', async () => {
    getSystemConfigMock.mockRejectedValue(new Error('db down'));
    fetchMock.mockResolvedValue({ ok: true });

    const { sendCrisisAlert } = await import('./crisisAlert.service.js');
    await expect(sendCrisisAlert('test message')).resolves.toBeUndefined();
  });

  it('never throws when the network request fails (fail-safe)', async () => {
    getSystemConfigMock.mockResolvedValue({ crisis_alert: { enabled: true, phone: '+19995551111' } });
    fetchMock.mockRejectedValue(new Error('network error'));

    const { sendCrisisAlert } = await import('./crisisAlert.service.js');
    await expect(sendCrisisAlert('test message')).resolves.toBeUndefined();
  });
});
