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
    // Resolves (never rejects) with whether the page was delivered.
    await expect(sendCrisisAlert('test message')).resolves.toBe(true);
  });

  it('never throws when the network request fails (fail-safe)', async () => {
    getSystemConfigMock.mockResolvedValue({ crisis_alert: { enabled: true, phone: '+19995551111' } });
    fetchMock.mockRejectedValue(new Error('network error'));

    const { sendCrisisAlert } = await import('./crisisAlert.service.js');
    await expect(sendCrisisAlert('test message')).resolves.toBe(false);
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

  it('a page that was not delivered does not use up the hour', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502 }).mockRejectedValueOnce(new Error('pager down'));
    const { reportOpenAIQuotaExhausted } = await import('./crisisAlert.service.js');
    await reportOpenAIQuotaExhausted('risk_assessor', 'insufficient_quota');
    await reportOpenAIQuotaExhausted('risk_assessor', 'insufficient_quota');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The pager is back: the very next detection pages, and that one starts the hour.
    await reportOpenAIQuotaExhausted('moderation', 'insufficient_quota');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await reportOpenAIQuotaExhausted('moderation', 'insufficient_quota');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('concurrent detections send one page, not one each', async () => {
    const { reportOpenAIQuotaExhausted } = await import('./crisisAlert.service.js');
    await Promise.all([
      reportOpenAIQuotaExhausted('moderation', 'insufficient_quota'),
      reportOpenAIQuotaExhausted('risk_assessor', 'insufficient_quota'),
      reportOpenAIQuotaExhausted('voice_session_mint', 'insufficient_quota'),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never throws, even when the pager itself is down', async () => {
    fetchMock.mockRejectedValue(new Error('pager down'));
    const { reportOpenAIQuotaExhausted } = await import('./crisisAlert.service.js');
    await expect(reportOpenAIQuotaExhausted('risk_assessor', null)).resolves.toBeUndefined();
  });
});

// ai-therapist-190 residual: an assessor outage that is NOT the spend cap (a
// mistyped crisis.risk_model, a revoked key, an OpenAI incident) reaches the
// on-call too, once per outage.
describe('reportRiskAssessorOutage', () => {
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

  it('pages with an operational message that names the cause and cannot be read as a participant crisis', async () => {
    const { reportRiskAssessorOutage } = await import('./crisisAlert.service.js');
    await expect(reportRiskAssessorOutage('other', 'model_not_found', 2)).resolves.toBe(true);

    const [message] = sentMessages();
    expect(message).toContain('risk assessor is failing');
    expect(message).toContain('2 assessments in a row');
    expect(message).toContain('model_not_found');
    expect(message).toContain('not a participant crisis');
    expect(message).toContain('keyword screen only');
    expect(message).toContain('crisis.risk_model');
    // Operational only: no session id, no link to a session.
    expect(message).not.toMatch(/session|#/i);
  });

  it('delivers at most one page an hour, however often it is asked (a flapping assessor)', async () => {
    const { reportRiskAssessorOutage } = await import('./crisisAlert.service.js');
    await expect(reportRiskAssessorOutage('timeout', null, 2)).resolves.toBe(true);
    for (let i = 0; i < 20; i++) await expect(reportRiskAssessorOutage('timeout', null, 2)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await expect(reportRiskAssessorOutage('timeout', null, 2)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('concurrent failures send one page, not one each', async () => {
    const { reportRiskAssessorOutage } = await import('./crisisAlert.service.js');
    const results = await Promise.all([
      reportRiskAssessorOutage('timeout', null, 2),
      reportRiskAssessorOutage('timeout', null, 3),
      reportRiskAssessorOutage('timeout', null, 4),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a page that was not delivered does not use up the hour', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502 });
    const { reportRiskAssessorOutage } = await import('./crisisAlert.service.js');
    await expect(reportRiskAssessorOutage('timeout', null, 2)).resolves.toBe(false);
    await expect(reportRiskAssessorOutage('timeout', null, 3)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('has its own throttle: a spend-cap page does not silence a different outage, or the reverse', async () => {
    const { reportRiskAssessorOutage, reportOpenAIQuotaExhausted } = await import('./crisisAlert.service.js');
    await reportOpenAIQuotaExhausted('risk_assessor', 'insufficient_quota');
    await expect(reportRiskAssessorOutage('timeout', null, 2)).resolves.toBe(true);
    await reportOpenAIQuotaExhausted('risk_assessor', 'insufficient_quota');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends nothing when paging is disabled, and says so', async () => {
    getSystemConfigMock.mockResolvedValue({ crisis_alert: { enabled: false } });
    const { reportRiskAssessorOutage } = await import('./crisisAlert.service.js');
    await expect(reportRiskAssessorOutage('timeout', null, 2)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws, even when the pager itself is down', async () => {
    fetchMock.mockRejectedValue(new Error('pager down'));
    const { reportRiskAssessorOutage } = await import('./crisisAlert.service.js');
    await expect(reportRiskAssessorOutage('timeout', null, 2)).resolves.toBe(false);
  });
});
