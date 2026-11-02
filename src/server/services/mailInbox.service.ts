// A researcher's own mailbox on the study domain (ai-therapist-283 phase 3).
//
// The gateway keeps one inbox for the whole catch-all domain; this layer turns
// it into per-person mailboxes by filtering on the envelope recipient and,
// on every single-message read, checking that the message was delivered to
// the caller's address. An id guessed from elsewhere therefore 404s rather
// than opening someone else's mail.
//
// Everything returned is text from strangers. The gateway already strips
// hidden HTML and flags instruction-shaped content; this layer passes only
// the plain-text body and the flags, never HTML, and the admin view renders
// it as text.
import { getUserById } from '../db/index.js';
import { studyEmailDomain } from './researcherEmail.service.js';
import {
  listInbox,
  getInboxMessage,
  markInboxRead,
  EmailApiError,
  type GatewayInboxSummary,
  type GatewayInboxMessage,
} from '../utils/emailApiClient.js';

export class MailInboxError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'MailInboxError';
  }
}

/** The caller's study address, or the reason they have no mailbox. */
export async function mailboxAddressFor(userId: number): Promise<string> {
  const user = await getUserById(userId);
  if (!user || user.role !== 'researcher')
    throw new MailInboxError('Only researcher accounts have a study mailbox', 403);
  const address = (user.email ?? '').toLowerCase();
  if (!address.endsWith(`@${studyEmailDomain()}`)) {
    throw new MailInboxError(`Provision a study address (name@${studyEmailDomain()}) on your account first`, 403);
  }
  return address;
}

export interface InboxSummary {
  id: string;
  received_at: string;
  from: string;
  from_name: string | null;
  subject: string;
  preview: string;
  read: boolean;
  suspicious: boolean;
  injection_suspected: boolean;
  attachments: number;
}

function toSummary(m: GatewayInboxSummary): InboxSummary {
  return {
    id: m.id,
    received_at: m.received_at,
    from: m.from,
    from_name: m.from_name ?? null,
    subject: m.subject,
    preview: m.preview,
    read: m.read,
    suspicious: m.suspicious,
    injection_suspected: m.injection_suspected,
    attachments: m.attachments,
  };
}

export interface InboxMessage extends InboxSummary {
  to: string[];
  cc: string[];
  reply_to: string | null;
  text: string;
  message_id: string | null;
  in_reply_to: string | null;
  injection_reasons: string[];
  attachment_files: Array<{ id: string; filename: string; content_type: string; size: number }>;
}

function toMessage(m: GatewayInboxMessage): InboxMessage {
  return {
    id: m.id,
    received_at: m.received_at,
    from: m.from,
    from_name: m.from_name ?? null,
    subject: m.subject,
    preview: (m.text ?? '').slice(0, 200),
    read: m.read,
    suspicious: m.suspicious,
    injection_suspected: m.injection_suspected,
    attachments: m.attachments?.length ?? 0,
    to: m.to ?? [],
    cc: m.cc ?? [],
    reply_to: m.reply_to ?? null,
    text: m.text ?? '',
    message_id: m.message_id ?? null,
    in_reply_to: m.in_reply_to ?? null,
    injection_reasons: m.injection_reasons ?? [],
    attachment_files: (m.attachments ?? []).map((a) => ({
      id: a.id,
      filename: a.filename,
      content_type: a.content_type,
      size: a.size,
    })),
  };
}

function rethrow(err: unknown): never {
  if (err instanceof EmailApiError) throw new MailInboxError(err.message, err.status);
  throw err;
}

export async function listMailboxFor(
  userId: number,
  opts: { limit?: number; unread?: boolean } = {},
): Promise<{ address: string; messages: InboxSummary[] }> {
  const address = await mailboxAddressFor(userId);
  try {
    const { messages } = await listInbox({ to: address, limit: opts.limit, unread: opts.unread });
    return { address, messages: messages.map(toSummary) };
  } catch (err) {
    rethrow(err);
  }
}

/** One message, only if it was delivered to the caller's address. */
export async function readMailboxMessage(userId: number, id: string): Promise<InboxMessage> {
  const address = await mailboxAddressFor(userId);
  let raw: GatewayInboxMessage;
  try {
    raw = await getInboxMessage(id);
  } catch (err) {
    rethrow(err);
  }
  if ((raw.envelope_to ?? '').toLowerCase() !== address) throw new MailInboxError('Message not found', 404);
  return toMessage(raw);
}

export async function markMailboxMessageRead(userId: number, id: string, read: boolean): Promise<void> {
  await readMailboxMessage(userId, id); // ownership check
  try {
    await markInboxRead(id, read);
  } catch (err) {
    rethrow(err);
  }
}
