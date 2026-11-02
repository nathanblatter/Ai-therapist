// Thin client for the email-api gateway's inbox (ai-therapist-283 phase 3).
// Reads only; sending goes through emailer.sendMailFrom. Everything that
// comes back is mail from strangers: callers treat it as untrusted text.
import { emailApiEnv } from '../services/emailer.service.js';

export interface GatewayInboxSummary {
  id: string;
  received_at: string;
  from_name?: string;
  from: string;
  to: string[];
  subject: string;
  preview: string;
  read: boolean;
  suspicious: boolean;
  injection_suspected: boolean;
  attachments: number;
}

export interface GatewayInboxMessage {
  id: string;
  received_at: string;
  envelope_to: string;
  from_name?: string;
  from: string;
  to: string[];
  cc?: string[];
  reply_to?: string;
  subject: string;
  text?: string;
  message_id?: string;
  in_reply_to?: string;
  references?: string;
  suspicious: boolean;
  injection_suspected: boolean;
  injection_reasons?: string[];
  read: boolean;
  attachments: Array<{ id: string; filename: string; content_type: string; size: number }>;
}

export class EmailApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'EmailApiError';
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const env = emailApiEnv();
  if (!env) throw new EmailApiError('mail gateway not configured (EMAIL_API_URL/EMAIL_API_KEY)', 503);
  const res = await fetch(`${env.url}${path}`, {
    ...init,
    headers: { 'X-API-Key': env.key, Accept: 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) throw new EmailApiError('Message not found', 404);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new EmailApiError(`mail gateway answered ${res.status}: ${body.slice(0, 160)}`, 502);
  }
  return (await res.json()) as T;
}

/** Mail delivered to exactly `to` (the gateway filters on the envelope recipient). */
export async function listInbox(opts: {
  to: string;
  limit?: number;
  unread?: boolean;
}): Promise<{ messages: GatewayInboxSummary[] }> {
  const params = new URLSearchParams({ to: opts.to, limit: String(opts.limit ?? 50) });
  if (opts.unread) params.set('unread', 'true');
  return call<{ messages: GatewayInboxSummary[] }>(`/inbox?${params.toString()}`);
}

export async function getInboxMessage(id: string): Promise<GatewayInboxMessage> {
  return call<GatewayInboxMessage>(`/inbox/${encodeURIComponent(id)}`);
}

export async function markInboxRead(id: string, read: boolean): Promise<void> {
  await call(`/inbox/${encodeURIComponent(id)}/read?read=${read ? 'true' : 'false'}`, { method: 'POST' });
}
