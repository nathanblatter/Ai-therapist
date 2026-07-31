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

interface CrisisAlertConfig {
  enabled?: boolean;
  phone?: string | null;
}

/** Resolve enabled + target phone from admin config, falling back to env.
 *  Never throws — any lookup failure is treated as "use env defaults" so a
 *  config problem can't silently swallow crisis alerts. */
async function resolveAlertTarget(): Promise<{ enabled: boolean; phone: string }> {
  try {
    const { getSystemConfig } = await import('../utils/sessionHelpers.js');
    const config = await getSystemConfig();
    const alertConfig = config.crisis_alert as CrisisAlertConfig | undefined;
    if (!alertConfig) return { enabled: true, phone: ENV_ALERT_PHONE };
    return {
      enabled: alertConfig.enabled !== false,
      phone: (alertConfig.phone && alertConfig.phone.trim()) || ENV_ALERT_PHONE,
    };
  } catch (err) {
    log.error({ err }, '[alert] failed to resolve crisis_alert config; falling back to env');
    return { enabled: true, phone: ENV_ALERT_PHONE };
  }
}

/**
 * Page the on-call phone. No-ops (with a one-line warning) when disabled, or
 * when the API key / destination aren't configured, so local dev never tries
 * to send. Fail-safe by design: every branch is caught here so a paging
 * failure (config lookup, network, non-2xx) can never propagate up and break
 * the crisis-detection/session path that calls it.
 */
export async function sendCrisisAlert(message: string): Promise<void> {
  try {
    const { enabled, phone } = await resolveAlertTarget();
    if (!enabled) {
      log.warn('[alert] crisis SMS disabled via admin config; skipping');
      return;
    }
    if (!IMESSAGE_API_KEY || !phone) {
      log.warn('[alert] crisis SMS not configured (IMESSAGE_API_KEY / on-call phone); skipping');
      return;
    }
    const res = await fetch(`${IMESSAGE_API_URL}/send`, {
      method: 'POST',
      headers: { 'X-API-Key': IMESSAGE_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: phone, message }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log.error(`[alert] crisis SMS failed: HTTP ${res.status}`);
    } else {
      log.info('[alert] crisis SMS sent');
    }
  } catch (err) {
    // Never let a paging failure bubble up into the crisis-detection flow.
    log.error({ err }, '[alert] crisis SMS failed');
  }
}
