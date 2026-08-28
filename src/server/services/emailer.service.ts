// SMTP email transport for care-team notifications (caseworker portal, spec
// section 5). Mirrors crisisAlert.service's fail-safe posture: every branch
// is caught here, a delivery problem can never propagate into the work-queue
// or crisis paths that (indirectly) trigger it.
//
// Degrades to a logged no-op when:
//   - the system_config 'email_notifications' kill switch is off,
//   - SMTP env (SMTP_HOST / EMAIL_FROM) is absent — local dev never sends,
//   - the nodemailer dependency is not installed yet (it is added to
//     package.json by the integration slice; we import it lazily via a
//     dynamic, non-statically-resolvable specifier so this module loads and
//     typechecks without it).
//
// PHI note: this module is transport only. Callers (notification.service)
// are responsible for the zero-client-PHI email-body rule; nothing here adds
// content.
import { getSystemConfigByKey } from '../db/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('emailer');

export type EmailSendResult = 'sent' | 'skipped' | 'failed';

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
}

/** The slice of a nodemailer transport we use. */
export interface MailTransport {
  sendMail(options: {
    from: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<unknown>;
}

type TransportFactory = () => Promise<MailTransport | null>;

let transportFactory: TransportFactory | null = null;
let cachedTransport: MailTransport | null = null;
let warnedMissingConfig = false;
let warnedMissingModule = false;

/** Test hook: inject a fake transport factory (and reset cached state). */
export function _setTransportFactoryForTests(factory: TransportFactory | null): void {
  transportFactory = factory;
  cachedTransport = null;
  warnedMissingConfig = false;
  warnedMissingModule = false;
}

function smtpEnv(): { host: string; port: number; user: string; pass: string; from: string } | null {
  const host = (process.env.SMTP_HOST ?? '').trim();
  const from = (process.env.EMAIL_FROM ?? '').trim();
  if (!host || !from) return null;
  return {
    host,
    port: Number(process.env.SMTP_PORT ?? '587'),
    user: (process.env.SMTP_USER ?? '').trim(),
    pass: (process.env.SMTP_PASS ?? '').trim(),
    from,
  };
}

/** Default factory: lazily import nodemailer and build an SMTP transport. */
async function defaultTransportFactory(): Promise<MailTransport | null> {
  const env = smtpEnv();
  if (!env) return null;
  try {
    // Variable specifier: TypeScript does not try to resolve the module, so
    // this file typechecks and tests run before the dependency is installed.
    const specifier = 'nodemailer';
    const nodemailer = (await import(specifier)) as {
      default?: { createTransport: (opts: unknown) => MailTransport };
      createTransport?: (opts: unknown) => MailTransport;
    };
    const createTransport = nodemailer.createTransport ?? nodemailer.default?.createTransport;
    if (!createTransport) throw new Error('nodemailer.createTransport not found');
    return createTransport({
      host: env.host,
      port: env.port,
      secure: env.port === 465,
      auth: env.user ? { user: env.user, pass: env.pass } : undefined,
    });
  } catch (err) {
    if (!warnedMissingModule) {
      warnedMissingModule = true;
      log.warn({ err: err instanceof Error ? err.message : err },
        '[email] nodemailer unavailable; email delivery is a no-op until the dependency is installed');
    }
    return null;
  }
}

/**
 * Admin kill switch: system_config key 'email_notifications'. Accepts either
 * a bare boolean value or { enabled: boolean }. A missing row or lookup
 * failure defaults to ENABLED — env absence is the real off switch, and a
 * config hiccup must not silently drop urgent alerts once SMTP is configured.
 */
async function emailNotificationsEnabled(): Promise<boolean> {
  try {
    const row = await getSystemConfigByKey('email_notifications');
    if (!row) return true;
    const value = row.config_value as boolean | { enabled?: boolean } | null;
    if (typeof value === 'boolean') return value;
    if (value && typeof value === 'object') return value.enabled !== false;
    return true;
  } catch (err) {
    log.error({ err }, '[email] failed to read email_notifications config; defaulting to enabled');
    return true;
  }
}

/**
 * Send one email. Never throws. Returns:
 *   'sent'    — handed to the SMTP transport successfully
 *   'skipped' — deliberately not sent (kill switch off, SMTP not configured,
 *               nodemailer missing, or no recipient address)
 *   'failed'  — transport error (logged)
 */
export async function sendEmail(email: OutgoingEmail): Promise<EmailSendResult> {
  try {
    if (!email.to || !email.to.trim()) {
      log.debug('[email] no recipient address; skipping');
      return 'skipped';
    }
    if (!(await emailNotificationsEnabled())) {
      log.warn('[email] email_notifications disabled via admin config; skipping');
      return 'skipped';
    }
    const env = smtpEnv();
    if (!env) {
      if (!warnedMissingConfig) {
        warnedMissingConfig = true;
        log.warn('[email] SMTP not configured (SMTP_HOST / EMAIL_FROM); email delivery is a no-op');
      }
      return 'skipped';
    }
    if (!cachedTransport) {
      cachedTransport = await (transportFactory ?? defaultTransportFactory)();
    }
    if (!cachedTransport) return 'skipped';

    await cachedTransport.sendMail({
      from: env.from,
      to: email.to,
      subject: email.subject,
      text: email.text,
    });
    log.info({ subject: email.subject }, '[email] sent');
    return 'sent';
  } catch (err) {
    log.error({ err }, '[email] send failed');
    return 'failed';
  }
}
