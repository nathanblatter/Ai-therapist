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

// ai-therapist-190: a hard OpenAI spend cap takes down the risk assessor, the
// moderation screen and the session mint together. It reaches the on-call
// through the same pager the other safety-infrastructure failures use.
describe('reportOpenAIQuotaExhausted', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    fetchMock.mockReset().mockResolvedValue({ ok: true });
    getSystemConfigMock.mockReset().mockResolvedValue({});
    vi.stubGlobal('fetch', fetchMock);
    process.env.IMESSAGE_API_KEY = 'test-key';
    process.env.CRISIS_ALERT_PHONE = '+15550000000';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.IMESSAGE_API_KEY;
    delete process.env.CRISIS_ALERT_PHONE;
  });

  const sentMessages = () =>
    fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).message as string);

  it('pages the on-call with an operational message that cannot be mistaken for a participant crisis', async () => {
    const { reportOpenAIQuotaExhausted } = await import('./crisisAlert.service.js');
    await reportOpenAIQuotaExhausted('risk_assessor', 'organization_spend_limit_exceeded');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [message] = sentMessages();
    expect(message).toContain('spend or usage limit');
    expect(message).toContain('organization_spend_limit_exceeded');
    expect(message).toContain('not a participant crisis');
    expect(message).toContain('keyword screen only');
  });

  it('pages once per hour however many calls and components hit the limit', async () => {
    const { reportOpenAIQuotaExhausted } = await import('./crisisAlert.service.js');
    await reportOpenAIQuotaExhausted('moderation', 'insufficient_quota');
    await reportOpenAIQuotaExhausted('risk_assessor', 'insufficient_quota');
    await reportOpenAIQuotaExhausted('voice_session_mint', 'insufficient_quota');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000);
    await reportOpenAIQuotaExhausted('risk_assessor', 'insufficient_quota');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 1000);
    await reportOpenAIQuotaExhausted('risk_assessor', 'insufficient_quota');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never throws, even when the pager itself is down', async () => {
    fetchMock.mockRejectedValue(new Error('pager down'));
    const { reportOpenAIQuotaExhausted } = await import('./crisisAlert.service.js');
    await expect(reportOpenAIQuotaExhausted('risk_assessor', null)).resolves.toBeUndefined();
  });
});
