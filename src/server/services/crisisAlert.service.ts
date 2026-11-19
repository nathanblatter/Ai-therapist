// Out-of-band crisis paging: high-severity flags send an iMessage/SMS to the
// on-call phone via the same local iMessage HTTP API personal-site uses
// (X-API-Key auth, {recipient, message} body). The admin dashboard socket
// alert only reaches a dashboard someone has open; this reaches a human.
// Best-effort by design — an alert failure must never break the crisis flow.
//
// ai-therapist-25a: the enable flag + destination phone are admin-configurable
// via system_config (key 'crisis_alert'), edited from the SystemConfig UI, so
// on-call rotation doesn't require a redeploy. The API URL/key stay env-only
// (infra secrets, not something an admin should be able to repoint at will).
// A missing/absent config row (e.g. pre-migration-033 environments) falls back
// to the legacy CRISIS_ALERT_PHONE env var, enabled by default.
import { createLogger } from '../utils/logger.js';

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

/**
 * Page the on-call phone. No-ops (with a one-line warning) when disabled, or
 * when the API key / destination aren't configured, so local dev never tries
 * to send. Fail-safe by design: every branch is caught here so a paging
 * failure (config lookup, network, non-2xx) can never propagate up and break
 * the crisis-detection/session path that calls it.
 */
export async function sendCrisisAlert(message: string): Promise<boolean> {
  try {
    const { enabled, phone } = await resolveAlertTarget();
    if (!enabled) {
      log.warn('[alert] crisis SMS disabled via admin config; skipping');
      return false;
    }
    if (!IMESSAGE_API_KEY || !phone) {
      log.warn('[alert] crisis SMS not configured (IMESSAGE_API_KEY / on-call phone); skipping');
      return false;
    }
    const res = await fetch(`${IMESSAGE_API_URL}/send`, {
      method: 'POST',
      headers: { 'X-API-Key': IMESSAGE_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: phone, message }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log.error(`[alert] crisis SMS failed: HTTP ${res.status}`);
      return false;
    }
    log.info('[alert] crisis SMS sent');
    return true;
  } catch (err) {
    // Never let a paging failure bubble up into the crisis-detection flow.
    log.error({ err }, '[alert] crisis SMS failed');
    return false;
  }
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
