// Out-of-band crisis paging: high-severity flags text the on-call phone. Two
// channels, sent in parallel (see CHANNELS below): the local iMessage HTTP
// API personal-site uses (X-API-Key auth, {recipient, message} body), and,
// when configured, a carrier SMS through AWS End User Messaging. The admin
// dashboard socket alert only reaches a dashboard someone has open; this
// reaches a human.
// Best-effort by design — an alert failure must never break the crisis flow.
//
// ai-therapist-25a: the enable flag + destination phone are admin-configurable
// via system_config (key 'crisis_alert'), edited from the SystemConfig UI, so
// on-call rotation doesn't require a redeploy. The API URL/key stay env-only
// (infra secrets, not something an admin should be able to repoint at will).
// A missing/absent config row (e.g. pre-migration-033 environments) falls back
// to the legacy CRISIS_ALERT_PHONE env var, enabled by default.
import { createLogger } from '../utils/logger.js';
import { splitForSms, splitPageForSms, toE164 } from '../utils/smsText.js';
import { field, page, pageText, renderPage, type PageMessage } from '../utils/pageMessage.js';

const log = createLogger('crisisAlert');

const IMESSAGE_API_URL = process.env.IMESSAGE_API_URL || 'http://100.79.61.79:8899';
const IMESSAGE_API_KEY = process.env.IMESSAGE_API_KEY || '';
const ENV_ALERT_PHONE = process.env.CRISIS_ALERT_PHONE || '';

/** Longest the admin-config read may hold a page back. */
export const ALERT_CONFIG_TIMEOUT_MS = 2000;

interface CrisisAlertConfig {
  enabled?: boolean;
  phone?: string | null;
}

/** Resolve enabled + target phone from admin config, falling back to env.
 *  Never throws — any lookup failure is treated as "use env defaults" so a
 *  config problem can't silently swallow crisis alerts. */
async function resolveAlertTarget(): Promise<{ enabled: boolean; phone: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { getSystemConfig } = await import('../utils/sessionHelpers.js');
    // Bounded: this read sits inside the send path of every page. A database
    // that has stopped answering must not hold a page back indefinitely; past
    // the timeout the env defaults are used, exactly as for a failed read.
    const config = await Promise.race([
      getSystemConfig(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`crisis_alert config read timed out after ${ALERT_CONFIG_TIMEOUT_MS} ms`)),
          ALERT_CONFIG_TIMEOUT_MS,
        );
      }),
    ]);
    const alertConfig = config.crisis_alert as CrisisAlertConfig | undefined;
    if (!alertConfig) return { enabled: true, phone: ENV_ALERT_PHONE };
    return {
      enabled: alertConfig.enabled !== false,
      phone: (alertConfig.phone && alertConfig.phone.trim()) || ENV_ALERT_PHONE,
    };
  } catch (err) {
    log.error({ err }, '[alert] failed to resolve crisis_alert config; falling back to env');
    return { enabled: true, phone: ENV_ALERT_PHONE };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================
// CHANNELS (ai-therapist-355)
// ============================================
// A page goes out on every configured channel AT THE SAME TIME, and it counts
// as delivered when at least one of them accepted it:
//
//   imessage  the iMessage bridge on the Mac mini (the original channel).
//             Configured by IMESSAGE_API_KEY (+ IMESSAGE_API_URL).
//   aws_sms   a carrier SMS through AWS End User Messaging (SendTextMessage,
//             the pinpoint-sms-voice-v2 API). Configured by
//             CRISIS_SMS_AWS_REGION + CRISIS_SMS_ORIGINATION_IDENTITY, both
//             required; with either unset the channel does not exist and
//             nothing differs from before it was added. Credentials come from
//             the AWS SDK's default provider chain; this module never reads,
//             stores or logs one.
//
// Both go to the same on-call phone (system_config crisis_alert.phone, else
// CRISIS_ALERT_PHONE), so rotating the on-call in System Config moves both,
// and the same admin switch (crisis_alert.enabled) turns both off.
//
// Why two: the bridge is one machine. If the mini is down or asleep, nobody
// was paged, for prod as well as stage. The channels share nothing but the
// destination phone, so either one failing still pages.
//
// "Accepted" is the honest word for what is known here: the bridge returned
// 2xx, or AWS returned a MessageId. Neither confirms the text reached the
// handset (docs/on-call-sop.md says what the on-call does about that).

export type AlertChannelName = 'imessage' | 'aws_sms';

/** What one channel did with one page. Carries no phone number, no message
 *  text and no credential, so it can be stored on the page's audit row. */
export interface AlertChannelResult {
  channel: AlertChannelName;
  /** The channel accepted the whole page. */
  ok: boolean;
  /** Short machine-readable reason when not ok: 'timeout', 'http_502',
   *  'invalid_destination', or the AWS error name ('AccessDeniedException',
   *  'ThrottlingException', ...). Null when ok. */
  error: string | null;
  /** Provider message ids, one per SMS part (AWS MessageId). The bridge
   *  returns none. */
  messageIds: string[];
  /** SMS messages the page was sent as (1 unless it was split), and how many
   *  of them the provider accepted. */
  parts: number;
  partsAccepted: number;
  ms: number;
}

export interface AlertDelivery {
  /** At least one channel accepted the page. This is what "delivered" means
   *  to the paging policy (crisisPaging.service: only a delivered page can
   *  absorb a later one). */
  delivered: boolean;
  /** Why nothing was attempted, when nothing was: paging is switched off in
   *  admin config, or no channel is configured (local dev, CI, the harness). */
  skipped: 'disabled' | 'not_configured' | null;
  /** One entry per channel that was attempted, in a fixed order. */
  channels: AlertChannelResult[];
}

/** Longest one channel may take. Each channel has its own clock: a channel
 *  that hangs costs its own result, never the other's. */
export const ALERT_CHANNEL_TIMEOUT_MS = 5000;

/** A page that has not reached the handset in an hour is no longer a page. */
const SMS_TIME_TO_LIVE_SECONDS = 3600;

const AWS_SMS_REGION = (process.env.CRISIS_SMS_AWS_REGION || '').trim();
const AWS_SMS_ORIGINATION = (process.env.CRISIS_SMS_ORIGINATION_IDENTITY || '').trim();

/** Is the AWS SMS channel configured in this process? */
export function awsSmsConfigured(): boolean {
  return AWS_SMS_REGION !== '' && AWS_SMS_ORIGINATION !== '';
}

function imessageConfigured(): boolean {
  return IMESSAGE_API_KEY !== '';
}

/** A short, storable name for a failure. Never the message: an AWS error
 *  message can carry an account id or an ARN. */
function errorCode(err: unknown): string {
  if (err && typeof err === 'object') {
    const name = (err as { name?: unknown }).name;
    if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
    if (typeof name === 'string' && name !== '' && name !== 'Error') return name.slice(0, 60);
  }
  return 'error';
}

function channelTimeout(): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`channel timed out after ${ALERT_CHANNEL_TIMEOUT_MS} ms`);
      err.name = 'TimeoutError';
      reject(err);
    }, ALERT_CHANNEL_TIMEOUT_MS);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/** The iMessage bridge. Never throws. */
async function sendViaImessage(phone: string, message: string): Promise<AlertChannelResult> {
  const started = Date.now();
  const result: AlertChannelResult = {
    channel: 'imessage',
    ok: false,
    error: null,
    messageIds: [],
    parts: 1,
    partsAccepted: 0,
    ms: 0,
  };
  const timeout = channelTimeout();
  try {
    const res = await Promise.race([
      fetch(`${IMESSAGE_API_URL}/send`, {
        method: 'POST',
        headers: { 'X-API-Key': IMESSAGE_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: phone, message }),
        signal: AbortSignal.timeout(ALERT_CHANNEL_TIMEOUT_MS),
      }),
      timeout.promise,
    ]);
    if (res.ok) {
      result.ok = true;
      result.partsAccepted = 1;
      log.info('[alert] page accepted by the iMessage bridge');
    } else {
      result.error = `http_${res.status}`;
      log.error(`[alert] iMessage bridge refused the page: HTTP ${res.status}`);
    }
  } catch (err) {
    result.error = errorCode(err);
    log.error({ err }, '[alert] iMessage bridge failed');
  } finally {
    timeout.cancel();
  }
  result.ms = Date.now() - started;
  return result;
}

interface SmsClient {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<{ MessageId?: string }>;
}
let smsClient: { client: SmsClient; command: new (input: Record<string, unknown>) => unknown } | null = null;

/** The AWS client, built on first use so an environment without the channel
 *  never loads the SDK. Region and nothing else: credentials are the SDK's
 *  default provider chain (environment, shared config, container or instance
 *  role). */
async function getSmsClient(): Promise<NonNullable<typeof smsClient>> {
  if (!smsClient) {
    const sdk = await import('@aws-sdk/client-pinpoint-sms-voice-v2');
    smsClient = {
      // Two attempts at most: the channel's own timeout is the real bound.
      client: new sdk.PinpointSMSVoiceV2Client({ region: AWS_SMS_REGION, maxAttempts: 2 }) as unknown as SmsClient,
      command: sdk.SendTextMessageCommand as unknown as new (input: Record<string, unknown>) => unknown,
    };
  }
  return smsClient;
}

/** AWS End User Messaging SMS. Never throws. The page is sent as one SMS, or
 *  as numbered parts in order (utils/smsText: splitPageForSms for a
 *  structured page, whose part 1 stands on its own; splitForSms for plain
 *  text); the channel is ok only when every part was accepted. */
async function sendViaAwsSms(phone: string, message: string | PageMessage): Promise<AlertChannelResult> {
  const started = Date.now();
  const result: AlertChannelResult = {
    channel: 'aws_sms',
    ok: false,
    error: null,
    messageIds: [],
    parts: 0,
    partsAccepted: 0,
    ms: 0,
  };
  // Shaping is inside the "never throws" contract too: a rejection here would
  // fail Promise.all in sendCrisisAlertDetailed and record a page the bridge
  // DID deliver as undelivered.
  let parts: string[];
  let destination: string | null;
  try {
    parts = typeof message === 'string' ? splitForSms(message) : splitPageForSms(message);
    destination = toE164(phone);
  } catch (err) {
    result.error = errorCode(err) === 'error' ? 'text_shaping_failed' : errorCode(err);
    log.error(
      { error: result.error },
      '[alert] AWS SMS: could not shape the page for SMS; nothing sent on this channel',
    );
    result.ms = Date.now() - started;
    return result;
  }
  result.parts = parts.length;
  if (!destination) {
    result.error = 'invalid_destination';
    log.error('[alert] AWS SMS: the on-call phone is not a valid E.164 number; nothing sent on this channel');
    return result;
  }
  if (parts.length === 0) {
    result.error = 'empty_message';
    return result;
  }
  const abort = new AbortController();
  const timeout = channelTimeout();
  try {
    await Promise.race([
      (async () => {
        const { client, command: SendTextMessageCommand } = await getSmsClient();
        for (const body of parts) {
          const sent = await client.send(
            new SendTextMessageCommand({
              DestinationPhoneNumber: destination,
              OriginationIdentity: AWS_SMS_ORIGINATION,
              MessageBody: body,
              // Critical, time-sensitive, one recipient: the transactional route.
              MessageType: 'TRANSACTIONAL',
              TimeToLive: SMS_TIME_TO_LIVE_SECONDS,
            }),
            { abortSignal: abort.signal },
          );
          if (abort.signal.aborted) return;
          result.partsAccepted += 1;
          if (typeof sent?.MessageId === 'string') result.messageIds.push(sent.MessageId);
        }
      })(),
      timeout.promise,
    ]);
    result.ok = result.partsAccepted === parts.length;
    if (result.ok)
      log.info(`[alert] page accepted by AWS SMS (${parts.length} message${parts.length === 1 ? '' : 's'})`);
  } catch (err) {
    abort.abort();
    result.error = errorCode(err);
    // Name and status only: never the request, never anything from the
    // credential provider.
    log.error(
      { error: result.error, status: (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode },
      `[alert] AWS SMS failed after ${result.partsAccepted} of ${parts.length} message(s)`,
    );
  } finally {
    timeout.cancel();
  }
  result.ms = Date.now() - started;
  return result;
}

/**
 * Tell the admin dashboards that paging itself is failing: every configured
 * channel refused a page (nobody was paged), or one did (the redundancy is
 * gone). Same mechanism as the other operational failures of the safety
 * infrastructure (riskAssessorHealth: an error-level log line and a
 * `system:*` event to the researcher room); there is no pager to fall back
 * on for a pager failure. Carries channel names and error codes only.
 */
function reportChannelFailures(delivery: AlertDelivery): void {
  const failed = delivery.channels.filter((c) => !c.ok);
  if (failed.length === 0) return;
  const detail = failed.map((c) => `${c.channel} (${c.error ?? 'error'})`).join(', ');
  if (delivery.delivered) {
    log.error(
      { failed: failed.map((c) => ({ channel: c.channel, error: c.error })) },
      `[alert] ON-CALL PAGING DEGRADED: the page was delivered, but a channel failed: ${detail}`,
    );
  } else {
    log.error(
      { failed: failed.map((c) => ({ channel: c.channel, error: c.error })) },
      `[alert] ON-CALL PAGE NOT DELIVERED: every configured channel failed: ${detail}`,
    );
  }
  try {
    if (global.io) {
      global.io.to('admin-broadcast').emit('system:on-call-paging-failed', {
        component: 'on_call_paging',
        delivered: delivery.delivered,
        channels: delivery.channels.map((c) => ({ channel: c.channel, ok: c.ok, error: c.error })),
        at: new Date(),
        message: delivery.delivered
          ? `On-call paging degraded: the page went out, but ${detail} failed. Check the channel.`
          : `ON-CALL PAGE NOT DELIVERED: ${detail}. Nobody was texted. Watch the dashboard and check paging now.`,
      });
    }
  } catch (err) {
    log.error({ err }, '[alert] failed to broadcast the paging failure');
  }
}

/**
 * Page the on-call phone on every configured channel, in parallel, and say
 * what each channel did. Never throws, never rejects: every branch is caught
 * here so a paging failure (config lookup, network, a provider error) cannot
 * propagate into the crisis-detection or session path that called it.
 *
 * `message` is plain text (system alerts) or a structured page
 * (utils/pageMessage: the participant pages of crisisPaging.service). The
 * bridge gets the page's full text either way; the SMS channel splits a
 * structured page so that part 1 carries the headline, who is at risk, what
 * changed, the Why line and the link.
 */
export async function sendCrisisAlertDetailed(message: string | PageMessage): Promise<AlertDelivery> {
  try {
    const { enabled, phone } = await resolveAlertTarget();
    if (!enabled) {
      log.warn('[alert] on-call paging disabled via admin config; skipping');
      return { delivered: false, skipped: 'disabled', channels: [] };
    }
    const sends: Array<Promise<AlertChannelResult>> = [];
    const sendNames: AlertChannelName[] = [];
    if (phone && imessageConfigured()) {
      sends.push(sendViaImessage(phone, pageText(message)));
      sendNames.push('imessage');
    }
    if (phone && awsSmsConfigured()) {
      sends.push(sendViaAwsSms(phone, message));
      sendNames.push('aws_sms');
    }
    if (sends.length === 0) {
      log.warn(
        '[alert] on-call paging not configured (no on-call phone, or neither IMESSAGE_API_KEY nor CRISIS_SMS_*); skipping',
      );
      return { delivered: false, skipped: 'not_configured', channels: [] };
    }
    // Each sender is written never to reject; allSettled makes sure one that
    // does anyway cannot hide what the other channel did.
    const channels = (await Promise.allSettled(sends)).map(
      (settled, i): AlertChannelResult =>
        settled.status === 'fulfilled'
          ? settled.value
          : {
              channel: sendNames[i],
              ok: false,
              error: errorCode(settled.reason),
              messageIds: [],
              parts: 0,
              partsAccepted: 0,
              ms: 0,
            },
    );
    const delivery: AlertDelivery = { delivered: channels.some((c) => c.ok), skipped: null, channels };
    reportChannelFailures(delivery);
    return delivery;
  } catch (err) {
    // Never let a paging failure bubble up into the crisis-detection flow.
    log.error({ err }, '[alert] on-call page failed');
    return { delivered: false, skipped: null, channels: [] };
  }
}

/**
 * Page the on-call phone. Resolves true when at least one channel accepted
 * the page. No-ops (with a one-line warning) when paging is disabled or no
 * channel is configured, so local dev never tries to send. Never throws.
 */
export async function sendCrisisAlert(message: string | PageMessage): Promise<boolean> {
  return (await sendCrisisAlertDetailed(message)).delivered;
}

// ============================================
// TEST PAGE (ai-therapist-355)
// ============================================

export interface TestPageReport {
  /** True when every configured channel accepted its test page. */
  ok: boolean;
  enabled: boolean;
  /** Which channels this process has configuration for. */
  configured: Record<AlertChannelName, boolean>;
  /** Whether an on-call phone is set (never the number itself). */
  hasPhone: boolean;
  channels: AlertChannelResult[];
}

/** A test page for one channel. Says TEST first, names the channel so the
 *  on-call can tell which ones arrived, and carries nothing about any
 *  participant. Short enough to be one SMS. */
export function composeTestPage(channel: AlertChannelName, sentAt: Date): PageMessage {
  const label = channel === 'aws_sms' ? 'AWS SMS' : 'iMessage bridge';
  return page(
    field(
      'headline',
      'TEST PAGE: AI-Therapist on-call paging check. This is NOT a participant event; no action is needed.',
    ),
    field('detail', `Channel: ${label}. Sent ${sentAt.toISOString()}.`),
    field(
      'action',
      'You should get one TEST text per configured channel. If one is missing, tell the study coordinator.',
    ),
  );
}

/** The bridge text of composeTestPage. */
export function buildTestPageMessage(channel: AlertChannelName, sentAt: Date): string {
  return renderPage(composeTestPage(channel, sentAt));
}

/**
 * Send a clearly labelled TEST page through each configured channel and
 * report what each one did. Each channel gets its own text, so a missing one
 * can be told apart on the phone. Honours the admin switch: with paging
 * disabled nothing is sent, and the report says so.
 *
 * Reached only from the `page:test` npm script (src/server/scripts): there is
 * no HTTP route, socket event or model tool that calls it, so it cannot be
 * triggered from a participant session. Never throws.
 */
export async function sendTestPage(now: Date = new Date()): Promise<TestPageReport> {
  const report: TestPageReport = {
    ok: false,
    enabled: true,
    configured: { imessage: imessageConfigured(), aws_sms: awsSmsConfigured() },
    hasPhone: false,
    channels: [],
  };
  try {
    const { enabled, phone } = await resolveAlertTarget();
    report.enabled = enabled;
    report.hasPhone = phone !== '';
    if (!enabled || !phone) return report;
    const sends: Array<Promise<AlertChannelResult>> = [];
    if (report.configured.imessage) sends.push(sendViaImessage(phone, buildTestPageMessage('imessage', now)));
    if (report.configured.aws_sms) sends.push(sendViaAwsSms(phone, composeTestPage('aws_sms', now)));
    report.channels = await Promise.all(sends);
    report.ok = report.channels.length > 0 && report.channels.every((c) => c.ok);
  } catch (err) {
    log.error({ err }, '[alert] test page failed');
  }
  return report;
}

// ============================================
// OPENAI QUOTA EXHAUSTION (ai-therapist-190)
// ============================================
// The OpenAI org runs under a hard spend cap. Once it is hit every call is
// rejected with a billing-class 429 - the risk assessor, the moderation
// screen and the voice session mint alike - so crisis detection silently
// drops to the keyword screen for EVERY session until a human raises the
// limit. That is an operational failure of the safety infrastructure, the
// same class as an unmonitored voice session or a filter-terminated one, and
// it reaches a human the same way those do: the on-call page.
//
// Throttled in-process to one page per interval (the condition is global, not
// per session, and every participant message re-detects it); the first
// detection after a restart pages again, which is the safe direction.

export type OpenAIQuotaComponent = 'risk_assessor' | 'moderation' | 'voice_session_mint';

const QUOTA_PAGE_INTERVAL_MS = 60 * 60 * 1000;
let lastQuotaPageAt: number | null = null;

/**
 * Record that OpenAI rejected a safety-relevant call because a billing, spend
 * or usage ceiling was reached. Always logs at error level; pages the on-call
 * at most once per hour. Never throws.
 */
export async function reportOpenAIQuotaExhausted(component: OpenAIQuotaComponent, code: string | null): Promise<void> {
  try {
    log.error(
      { component, code },
      '[alert] OpenAI quota/spend limit reached: crisis detection is degraded to the keyword screen',
    );
    const now = Date.now();
    if (lastQuotaPageAt !== null && now - lastQuotaPageAt < QUOTA_PAGE_INTERVAL_MS) return;
    // Claim the hour before sending so concurrent detections (every message
    // re-detects the cap) cannot each page; hand it back if the page was not
    // delivered, so a pager blip does not silence this alert for an hour.
    const previous = lastQuotaPageAt;
    lastQuotaPageAt = now;
    let delivered = false;
    try {
      delivered = await sendCrisisAlert(
        `AI-Therapist: OpenAI is rejecting requests because the account spend or usage limit has been reached` +
          `${code ? ` (${code})` : ''}. This is a system alert, not a participant crisis. Until the limit is raised, ` +
          'crisis detection runs on the keyword screen only (no AI risk assessment, no moderation screen) and new ' +
          'voice sessions cannot start (chat replies fail too). Raise the limit in the OpenAI billing settings. Repeats hourly.',
      );
    } finally {
      if (!delivered && lastQuotaPageAt === now) lastQuotaPageAt = previous;
    }
  } catch (err) {
    log.error({ err }, '[alert] failed to report OpenAI quota exhaustion');
  }
}

// ============================================
// RISK ASSESSOR OUTAGE (ai-therapist-190)
// ============================================
// The spend cap is one way to lose the assessor; a mistyped crisis.risk_model,
// a revoked key or an OpenAI incident are others, and none of those returns a
// billing 429. riskAssessorHealth.service calls this when assessments have
// failed back to back (an incident), once per incident. The throttle here is
// the backstop against a flapping assessor opening incident after incident:
// at most one delivered page per interval, whatever the caller does.

const OUTAGE_PAGE_INTERVAL_MS = 60 * 60 * 1000;
let lastOutagePageAt: number | null = null;

/**
 * Page the on-call that the risk assessor is failing for a reason other than
 * the spend cap. Returns true only when a page was delivered; false when it
 * was throttled, disabled, unconfigured or failed. Never throws.
 */
export async function reportRiskAssessorOutage(kind: string, code: string | null, failures: number): Promise<boolean> {
  try {
    const now = Date.now();
    if (lastOutagePageAt !== null && now - lastOutagePageAt < OUTAGE_PAGE_INTERVAL_MS) return false;
    // Claim before sending (concurrent failures must not each page); hand the
    // claim back if nothing was delivered, as the quota page does.
    const previous = lastOutagePageAt;
    lastOutagePageAt = now;
    let delivered = false;
    try {
      delivered = await sendCrisisAlert(
        `AI-Therapist: the AI risk assessor is failing (${failures} assessments in a row, ${kind}` +
          `${code ? `, ${code}` : ''}). This is a system alert, not a participant crisis. Until it recovers, crisis ` +
          'detection runs on the keyword screen only, so risk stated without a crisis keyword can be missed. ' +
          'Check the OpenAI status page, the API key and the crisis.risk_model setting. One alert per outage.',
      );
    } finally {
      if (!delivered && lastOutagePageAt === now) lastOutagePageAt = previous;
    }
    return delivered;
  } catch (err) {
    log.error({ err }, '[alert] failed to report the risk assessor outage');
    return false;
  }
}
