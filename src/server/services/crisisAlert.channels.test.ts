// The two paging channels (ai-therapist-355): the iMessage bridge and AWS SMS,
// sent in parallel. The AWS SDK is replaced by a fake for the whole file and
// fetch is stubbed, so nothing here can reach AWS, the bridge or a phone. The
// phone numbers and the origination number are fictitious (555 range).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getSystemConfigMock, awsSend, awsClientConfigs } = vi.hoisted(() => ({
  getSystemConfigMock: vi.fn(),
  awsSend: vi.fn(),
  awsClientConfigs: [] as Array<Record<string, unknown>>,
}));
vi.mock('../utils/sessionHelpers.js', () => ({ getSystemConfig: getSystemConfigMock }));
vi.mock('@aws-sdk/client-pinpoint-sms-voice-v2', () => ({
  PinpointSMSVoiceV2Client: class {
    constructor(config: Record<string, unknown>) {
      awsClientConfigs.push(config);
    }
    send = awsSend;
  },
  SendTextMessageCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

const fetchMock = vi.fn();
const emit = vi.fn();

const PHONE = '+18015550142';
const PAGE =
  'URGENT: AI-Therapist HIGH crisis flag\nWhy: RISK SCORE 82/100 from what the participant said.\n' +
  'Session live_u7_Eloycp3o...\nhttps://ai-therapist.example.org/admin#session=live_u7_Eloycp3oMNHnVh9M';

type Channels = { imessage?: boolean; aws?: boolean };

/** Load the module with the given channels configured (env is read at import). */
async function load(channels: Channels) {
  vi.resetModules();
  delete process.env.IMESSAGE_API_KEY;
  delete process.env.CRISIS_SMS_AWS_REGION;
  delete process.env.CRISIS_SMS_ORIGINATION_IDENTITY;
  if (channels.imessage) process.env.IMESSAGE_API_KEY = 'test-key';
  if (channels.aws) {
    process.env.CRISIS_SMS_AWS_REGION = 'us-test-1';
    process.env.CRISIS_SMS_ORIGINATION_IDENTITY = '+18335550100';
  }
  process.env.CRISIS_ALERT_PHONE = PHONE;
  return await import('./crisisAlert.service.js');
}

const awsInputs = (): Array<Record<string, unknown>> =>
  awsSend.mock.calls.map((c) => (c[0] as { input: Record<string, unknown> }).input);

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 });
  awsSend.mockReset().mockResolvedValue({ MessageId: 'aws-msg-1' });
  awsClientConfigs.length = 0;
  getSystemConfigMock.mockReset().mockResolvedValue({});
  emit.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  (global as { io?: unknown }).io = { to: vi.fn(() => ({ emit })) };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (global as { io?: unknown }).io;
  delete process.env.IMESSAGE_API_KEY;
  delete process.env.CRISIS_ALERT_PHONE;
  delete process.env.CRISIS_SMS_AWS_REGION;
  delete process.env.CRISIS_SMS_ORIGINATION_IDENTITY;
});

describe('unconfigured: the AWS channel does not exist and nothing changes', () => {
  it('bridge only: one request to the bridge, the SDK is never constructed, the result has one channel', async () => {
    const alert = await load({ imessage: true });
    expect(alert.awsSmsConfigured()).toBe(false);
    const delivery = await alert.sendCrisisAlertDetailed(PAGE);
    expect(delivery).toMatchObject({ delivered: true, skipped: null });
    expect(delivery.channels.map((c) => c.channel)).toEqual(['imessage']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The bridge gets the page exactly as written, as before.
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      recipient: PHONE,
      message: PAGE,
    });
    expect(awsClientConfigs).toHaveLength(0);
    expect(awsSend).not.toHaveBeenCalled();
    expect(await alert.sendCrisisAlert(PAGE)).toBe(true);
  });

  it('only one of the two AWS variables set is still "not configured"', async () => {
    vi.resetModules();
    process.env.CRISIS_SMS_AWS_REGION = 'us-test-1';
    process.env.CRISIS_ALERT_PHONE = PHONE;
    const alert = await import('./crisisAlert.service.js');
    expect(alert.awsSmsConfigured()).toBe(false);
    expect(await alert.sendCrisisAlertDetailed(PAGE)).toEqual({
      delivered: false,
      skipped: 'not_configured',
      channels: [],
    });
    expect(awsSend).not.toHaveBeenCalled();
  });

  it('AWS_REGION alone never turns the channel on', async () => {
    vi.resetModules();
    process.env.AWS_REGION = 'us-test-1';
    try {
      const alert = await import('./crisisAlert.service.js');
      expect(alert.awsSmsConfigured()).toBe(false);
    } finally {
      delete process.env.AWS_REGION;
    }
  });

  it('nothing configured (dev, CI, the harness): nothing is attempted and it is not an operational failure', async () => {
    const alert = await load({});
    expect(await alert.sendCrisisAlertDetailed(PAGE)).toEqual({
      delivered: false,
      skipped: 'not_configured',
      channels: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('both channels configured', () => {
  it('both succeed: sent on both at once, delivered, AWS message id recorded', async () => {
    const alert = await load({ imessage: true, aws: true });
    const delivery = await alert.sendCrisisAlertDetailed(PAGE);
    expect(delivery.delivered).toBe(true);
    expect(delivery.channels).toEqual([
      expect.objectContaining({ channel: 'imessage', ok: true, error: null, parts: 1, partsAccepted: 1 }),
      expect.objectContaining({ channel: 'aws_sms', ok: true, error: null, messageIds: ['aws-msg-1'], parts: 1 }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(awsInputs()).toEqual([
      {
        DestinationPhoneNumber: PHONE,
        OriginationIdentity: '+18335550100',
        MessageBody: PAGE,
        MessageType: 'TRANSACTIONAL',
        TimeToLive: 3600,
      },
    ]);
    expect(emit).not.toHaveBeenCalled();
  });

  it('the client is built with the region only: credentials are left to the SDK provider chain', async () => {
    const alert = await load({ imessage: true, aws: true });
    await alert.sendCrisisAlertDetailed(PAGE);
    await alert.sendCrisisAlertDetailed(PAGE);
    expect(awsClientConfigs).toEqual([{ region: 'us-test-1', maxAttempts: 2 }]);
    expect(Object.keys(awsClientConfigs[0])).not.toContain('credentials');
  });

  it('the bridge fails, AWS delivers: delivered, and the lost redundancy is reported', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502 });
    const alert = await load({ imessage: true, aws: true });
    const delivery = await alert.sendCrisisAlertDetailed(PAGE);
    expect(delivery.delivered).toBe(true);
    expect(delivery.channels).toEqual([
      expect.objectContaining({ channel: 'imessage', ok: false, error: 'http_502' }),
      expect.objectContaining({ channel: 'aws_sms', ok: true }),
    ]);
    expect(emit).toHaveBeenCalledWith(
      'system:on-call-paging-failed',
      expect.objectContaining({
        delivered: true,
        channels: [
          { channel: 'imessage', ok: false, error: 'http_502' },
          { channel: 'aws_sms', ok: true, error: null },
        ],
      }),
    );
  });

  it('AWS fails, the bridge delivers: delivered; only the error NAME is kept', async () => {
    const denied = Object.assign(new Error('User: arn:aws:iam::000000000000:user/x is not authorized'), {
      name: 'AccessDeniedException',
      $metadata: { httpStatusCode: 400 },
    });
    awsSend.mockRejectedValue(denied);
    const alert = await load({ imessage: true, aws: true });
    const delivery = await alert.sendCrisisAlertDetailed(PAGE);
    expect(delivery.delivered).toBe(true);
    expect(delivery.channels[1]).toMatchObject({ channel: 'aws_sms', ok: false, error: 'AccessDeniedException' });
    expect(JSON.stringify(delivery)).not.toContain('arn:aws');
    expect(JSON.stringify(emit.mock.calls)).not.toContain('arn:aws');
    expect(await alert.sendCrisisAlert(PAGE)).toBe(true);
  });

  it('both fail: not delivered, and admins are told nobody was texted', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    awsSend.mockRejectedValue(Object.assign(new Error('slow down'), { name: 'ThrottlingException' }));
    const alert = await load({ imessage: true, aws: true });
    const delivery = await alert.sendCrisisAlertDetailed(PAGE);
    expect(delivery.delivered).toBe(false);
    expect(delivery.skipped).toBeNull();
    expect(delivery.channels.map((c) => [c.channel, c.ok, c.error])).toEqual([
      ['imessage', false, 'error'],
      ['aws_sms', false, 'ThrottlingException'],
    ]);
    expect(emit).toHaveBeenCalledTimes(1);
    const [event, payload] = emit.mock.calls[0] as [string, { delivered: boolean; message: string }];
    expect(event).toBe('system:on-call-paging-failed');
    expect(payload.delivered).toBe(false);
    expect(payload.message).toMatch(/ON-CALL PAGE NOT DELIVERED: imessage \(error\), aws_sms \(ThrottlingException\)/);
    expect(payload.message).not.toContain(PHONE);
    expect(await alert.sendCrisisAlert(PAGE)).toBe(false);
  });

  it('a channel that hangs does not delay the other: the bridge is done at once, AWS times out alone', async () => {
    vi.useFakeTimers();
    awsSend.mockReturnValue(new Promise(() => undefined));
    let bridgeDoneAt: number | null = null;
    fetchMock.mockImplementation(async () => {
      bridgeDoneAt = Date.now();
      return { ok: true, status: 200 };
    });
    const alert = await load({ imessage: true, aws: true });
    const started = Date.now();
    const sending = alert.sendCrisisAlertDetailed(PAGE);
    await vi.advanceTimersByTimeAsync(10);
    // The bridge was called, and answered, without waiting on AWS.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(awsSend).toHaveBeenCalledTimes(1);
    expect((bridgeDoneAt ?? Infinity) - started).toBeLessThan(50);

    await vi.advanceTimersByTimeAsync(alert.ALERT_CHANNEL_TIMEOUT_MS);
    const delivery = await sending;
    expect(delivery.delivered).toBe(true);
    expect(delivery.channels[0]).toMatchObject({ channel: 'imessage', ok: true });
    expect(delivery.channels[0].ms).toBeLessThan(50);
    expect(delivery.channels[1]).toMatchObject({ channel: 'aws_sms', ok: false, error: 'timeout' });
  });

  it('and the other way round: a hanging bridge does not delay the SMS', async () => {
    vi.useFakeTimers();
    fetchMock.mockReturnValue(new Promise(() => undefined));
    const alert = await load({ imessage: true, aws: true });
    const sending = alert.sendCrisisAlertDetailed(PAGE);
    await vi.advanceTimersByTimeAsync(10);
    expect(awsSend).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(alert.ALERT_CHANNEL_TIMEOUT_MS);
    const delivery = await sending;
    expect(delivery.delivered).toBe(true);
    expect(delivery.channels.map((c) => [c.channel, c.ok, c.error])).toEqual([
      ['imessage', false, 'timeout'],
      ['aws_sms', true, null],
    ]);
  });

  it('the admin switch turns both channels off', async () => {
    getSystemConfigMock.mockResolvedValue({ crisis_alert: { enabled: false, phone: PHONE } });
    const alert = await load({ imessage: true, aws: true });
    expect(await alert.sendCrisisAlertDetailed(PAGE)).toEqual({ delivered: false, skipped: 'disabled', channels: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(awsSend).not.toHaveBeenCalled();
  });

  it('rotating the on-call phone in System Config moves both channels', async () => {
    getSystemConfigMock.mockResolvedValue({ crisis_alert: { enabled: true, phone: '(385) 555-0199' } });
    const alert = await load({ imessage: true, aws: true });
    await alert.sendCrisisAlertDetailed(PAGE);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).recipient).toBe('(385) 555-0199');
    expect(awsInputs()[0]['DestinationPhoneNumber']).toBe('+13855550199');
  });

  it('a phone AWS cannot use fails that channel only, without calling AWS', async () => {
    getSystemConfigMock.mockResolvedValue({ crisis_alert: { enabled: true, phone: 'on-call@example.org' } });
    const alert = await load({ imessage: true, aws: true });
    const delivery = await alert.sendCrisisAlertDetailed(PAGE);
    expect(delivery.delivered).toBe(true);
    expect(delivery.channels[1]).toMatchObject({ channel: 'aws_sms', ok: false, error: 'invalid_destination' });
    expect(awsSend).not.toHaveBeenCalled();
  });
});

describe('a long page over SMS is deliberately split, and says the same thing', () => {
  const LONG =
    'URGENT: AI-Therapist voice session ENDED BY THE VENDOR FILTER during a HIGH crisis flag\n' +
    'Why: VENDOR CUT, not a new risk score. The participant lost the assistant mid-conversation; their risk ' +
    'before the cut was HIGH (82/100).\n' +
    'Session live_u7_Eloycp3o.... The app tries to reconnect them under a new session id; further cuts in the ' +
    'next 15 minutes are recorded, not paged.\n' +
    'Review the transcript and consider reaching out.\n' +
    'https://ai-therapist.example.org/admin#session=live_u7_Eloycp3oMNHnVh9M';

  it('numbered parts in order, each within two segments; the bridge still gets the page whole', async () => {
    awsSend.mockResolvedValueOnce({ MessageId: 'm1' }).mockResolvedValueOnce({ MessageId: 'm2' });
    const alert = await load({ imessage: true, aws: true });
    const delivery = await alert.sendCrisisAlertDetailed(LONG);
    const bodies = awsInputs().map((i) => String(i['MessageBody']));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatch(/^\(1\/2\) URGENT: .*\nWhy: VENDOR CUT/s);
    expect(bodies[1]).toMatch(/^\(2\/2\) /);
    for (const body of bodies) expect(body.length).toBeLessThanOrEqual(300);
    // Same words, nothing dropped.
    const rejoined = bodies.map((b) => b.replace(/^\(\d\/\d\) /, '')).join('\n');
    expect(rejoined.replace(/\s+/g, ' ')).toBe(LONG.replace(/\s+/g, ' '));
    expect(delivery.channels[1]).toMatchObject({ ok: true, parts: 2, partsAccepted: 2, messageIds: ['m1', 'm2'] });
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).message).toBe(LONG);
  });

  it('a part that fails makes the SMS channel fail (the bridge still delivers), and says how far it got', async () => {
    awsSend
      .mockResolvedValueOnce({ MessageId: 'm1' })
      .mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'InternalServerException' }));
    const alert = await load({ imessage: true, aws: true });
    const delivery = await alert.sendCrisisAlertDetailed(LONG);
    expect(delivery.delivered).toBe(true);
    expect(delivery.channels[1]).toMatchObject({
      ok: false,
      error: 'InternalServerException',
      parts: 2,
      partsAccepted: 1,
      messageIds: ['m1'],
    });
  });
});

describe('sendTestPage', () => {
  it('sends one clearly labelled TEST text per configured channel and reports each', async () => {
    const alert = await load({ imessage: true, aws: true });
    const report = await alert.sendTestPage(new Date('2026-11-19T18:00:00Z'));
    expect(report).toMatchObject({
      ok: true,
      enabled: true,
      hasPhone: true,
      configured: { imessage: true, aws_sms: true },
    });
    expect(report.channels.map((c) => [c.channel, c.ok])).toEqual([
      ['imessage', true],
      ['aws_sms', true],
    ]);
    const bridgeText = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).message as string;
    const smsText = String(awsInputs()[0]['MessageBody']);
    for (const text of [bridgeText, smsText]) {
      expect(text).toMatch(/^TEST PAGE: AI-Therapist on-call paging check\. This is NOT a participant event/);
      expect(text).toContain('2026-11-19T18:00:00.000Z');
      expect(text).not.toMatch(/URGENT|crisis flag|RISK SCORE|Session /);
      expect(text.length).toBeLessThanOrEqual(320);
    }
    expect(bridgeText).toContain('Channel: iMessage bridge.');
    expect(smsText).toContain('Channel: AWS SMS.');
    expect(awsSend).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report)).not.toContain(PHONE.slice(2));
  });

  it('reports a failed channel; ok only when every configured channel accepted', async () => {
    awsSend.mockRejectedValue(Object.assign(new Error('x'), { name: 'ValidationException' }));
    const alert = await load({ imessage: true, aws: true });
    const report = await alert.sendTestPage();
    expect(report.ok).toBe(false);
    expect(report.channels[1]).toMatchObject({ channel: 'aws_sms', ok: false, error: 'ValidationException' });
  });

  it('sends nothing when paging is disabled, there is no phone, or no channel is configured', async () => {
    getSystemConfigMock.mockResolvedValue({ crisis_alert: { enabled: false, phone: PHONE } });
    let alert = await load({ imessage: true, aws: true });
    expect(await alert.sendTestPage()).toMatchObject({ ok: false, enabled: false, channels: [] });

    getSystemConfigMock.mockResolvedValue({});
    alert = await load({ imessage: true, aws: true });
    delete process.env.CRISIS_ALERT_PHONE;
    vi.resetModules();
    alert = await import('./crisisAlert.service.js');
    expect(await alert.sendTestPage()).toMatchObject({ ok: false, hasPhone: false, channels: [] });

    alert = await load({});
    expect(await alert.sendTestPage()).toMatchObject({
      ok: false,
      configured: { imessage: false, aws_sms: false },
      channels: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(awsSend).not.toHaveBeenCalled();
  });
});
