// Out-of-band crisis paging: high-severity flags send an iMessage/SMS to the
// on-call phone via the same local iMessage HTTP API personal-site uses
// (X-API-Key auth, {recipient, message} body). The admin dashboard socket
// alert only reaches a dashboard someone has open; this reaches a human.
// Best-effort by design — an alert failure must never break the crisis flow.
import { createLogger } from '../utils/logger.js';

const log = createLogger('crisisAlert');

const IMESSAGE_API_URL = process.env.IMESSAGE_API_URL || 'http://100.79.61.79:8899';
const IMESSAGE_API_KEY = process.env.IMESSAGE_API_KEY || '';
const ALERT_PHONE = process.env.CRISIS_ALERT_PHONE || '';

/**
 * Page the on-call phone. No-ops (with a one-line warning) when the API key
 * or recipient isn't configured, so local dev never tries to send.
 */
export async function sendCrisisAlert(message: string): Promise<void> {
  if (!IMESSAGE_API_KEY || !ALERT_PHONE) {
    log.warn('[alert] crisis SMS not configured (IMESSAGE_API_KEY / CRISIS_ALERT_PHONE); skipping');
    return;
  }
  try {
    const res = await fetch(`${IMESSAGE_API_URL}/send`, {
      method: 'POST',
      headers: { 'X-API-Key': IMESSAGE_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: ALERT_PHONE, message }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log.error(`[alert] crisis SMS failed: HTTP ${res.status}`);
    } else {
      log.info('[alert] crisis SMS sent');
    }
  } catch (err) {
    log.error({ err }, '[alert] crisis SMS failed');
  }
}
