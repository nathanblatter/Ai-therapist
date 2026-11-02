// Staff email from the admin Mail view (ai-therapist-283, phase 2).
//
// A researcher with a provisioned study address writes to outside parties
// (OpenAI, the PI, the IRB office) from name@byuisresearch.com through the
// email-api gateway. Every message is recorded in outbound_mail first and the
// gateway's verdict written back, so the study's correspondence is auditable.
//
// What this layer enforces, in order: the sender is a researcher with an
// address on the study domain (the gateway's SES policy only lets that domain
// send); recipients are well-formed and few; subject and body are bounded;
// the body carries nothing that looks like participant content (session ids);
// and a per-sender daily cap. Keeping participant data out of email is a
// standing policy the Mail view states on every compose; this guard is the
// cheap mechanical part of it, not a substitute.
import { getUserById, insertOutboundMail, countOutboundMailToday, type OutboundMailRow } from '../db/index.js';
import { sendMailFrom } from './emailer.service.js';
import { studyEmailDomain } from './researcherEmail.service.js';
import { isEmailShaped } from '../utils/emailShape.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('mailCompose');

export const MAX_RECIPIENTS = 10;
export const MAX_SUBJECT_CHARS = 200;
export const MAX_BODY_CHARS = 20_000;

/** Per-sender messages per UTC day; STAFF_MAIL_DAILY_CAP overrides. */
export function dailyCap(): number {
  const raw = Number(process.env.STAFF_MAIL_DAILY_CAP ?? '');
  return Number.isInteger(raw) && raw > 0 ? raw : 50;
}

export class MailComposeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'MailComposeError';
  }
}

/** Therapy session ids (live_u7_…, grok_…, chat_…) and the like: participant
 *  identifiers that have no business in outbound email. */
const PARTICIPANT_CONTENT = /\b(?:live|grok|chat|sess|session)_[A-Za-z0-9_-]{6,}\b/;

/** Why a body is refused as participant content, or null when it is clean. */
export function participantContentReason(text: string): string | null {
  const hit = PARTICIPANT_CONTENT.exec(text);
  if (hit) return `the body contains what looks like a participant session id (${hit[0].slice(0, 16)}…)`;
  return null;
}

/** Normalize a recipient list: trim, lower-case, dedupe, validate. */
export function normalizeRecipients(raw: unknown, label: string): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;\s]+/) : [];
  const out: string[] = [];
  for (const v of list) {
    if (typeof v !== 'string') throw new MailComposeError(`Invalid ${label} address`, 400);
    const addr = v.trim().toLowerCase();
    if (!addr) continue;
    if (!isEmailShaped(addr)) throw new MailComposeError(`Invalid ${label} address: ${addr.slice(0, 60)}`, 400);
    if (!out.includes(addr)) out.push(addr);
  }
  return out;
}

export interface ComposeInput {
  senderUserId: number;
  to: unknown;
  cc?: unknown;
  subject: unknown;
  text: unknown;
  /** Message-ID being replied to (phase 3 threading). */
  inReplyTo?: unknown;
}

export interface SenderStatus {
  address: string | null;
  domain: string;
  canSend: boolean;
  reason: string | null;
  sentToday: number;
  dailyCap: number;
}

/** What the Mail view needs to know before offering the compose form. */
export async function senderStatus(userId: number): Promise<SenderStatus> {
  const domain = studyEmailDomain();
  const user = await getUserById(userId);
  const address = user?.email?.toLowerCase() ?? null;
  const sentToday = await countOutboundMailToday(userId);
  let reason: string | null = null;
  if (!user || user.role !== 'researcher') reason = 'Only researcher accounts can send mail from the study.';
  else if (!address || !address.endsWith(`@${domain}`)) {
    reason = `Provision a study address (name@${domain}) on your account first.`;
  } else if (sentToday >= dailyCap()) reason = 'Daily sending cap reached; try again tomorrow (UTC).';
  return { address, domain, canSend: reason === null, reason, sentToday, dailyCap: dailyCap() };
}

export async function sendStaffMail(input: ComposeInput): Promise<OutboundMailRow> {
  const status = await senderStatus(input.senderUserId);
  if (!status.canSend || !status.address) {
    throw new MailComposeError(status.reason ?? 'Cannot send', status.reason?.startsWith('Daily') ? 429 : 403);
  }

  const to = normalizeRecipients(input.to, 'recipient');
  const cc = normalizeRecipients(input.cc ?? [], 'cc').filter((a) => !to.includes(a));
  if (to.length === 0) throw new MailComposeError('At least one recipient is required', 400);
  if (to.length + cc.length > MAX_RECIPIENTS) {
    throw new MailComposeError(`At most ${MAX_RECIPIENTS} recipients per message`, 400);
  }

  const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!subject) throw new MailComposeError('Subject is required', 400);
  if (subject.length > MAX_SUBJECT_CHARS) throw new MailComposeError('Subject is too long', 400);
  if (!text) throw new MailComposeError('Message body is required', 400);
  if (text.length > MAX_BODY_CHARS) throw new MailComposeError('Message body is too long', 400);
  const inReplyTo = typeof input.inReplyTo === 'string' && input.inReplyTo.trim() ? input.inReplyTo.trim() : null;

  const reason = participantContentReason(`${subject}\n${text}`);
  if (reason) throw new MailComposeError(`Not sent: ${reason}. Participant content never goes into email.`, 400);

  const user = await getUserById(input.senderUserId);
  const fromAddress = status.address;
  const from = `${user?.username ?? 'Study staff'} (AI Therapist Study) <${fromAddress}>`;

  const outcome = await sendMailFrom({
    from,
    to,
    cc,
    subject,
    text,
    replyTo: fromAddress,
    headers: inReplyTo ? { 'In-Reply-To': inReplyTo, References: inReplyTo } : undefined,
  });

  const row = await insertOutboundMail({
    sentBy: input.senderUserId,
    fromAddress,
    toAddresses: to,
    ccAddresses: cc,
    replyTo: fromAddress,
    inReplyTo,
    subject,
    bodyText: text,
    status: outcome.status,
    gatewayId: outcome.gatewayId ?? null,
    error: outcome.error ?? null,
  });
  log.info(
    { mailId: row.mail_id, sentBy: input.senderUserId, to: to.length, cc: cc.length, status: outcome.status },
    'staff mail handed to the gateway',
  );
  if (outcome.status === 'failed') {
    throw new MailComposeError(`The mail gateway refused the message: ${outcome.error ?? 'unknown error'}`, 502);
  }
  return row;
}
