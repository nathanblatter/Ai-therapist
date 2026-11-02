// outbound_mail (120): the audit of staff email sent from the admin Mail
// view (ai-therapist-283 phase 2). Written by mailCompose.service only.
import { pool } from '../config/db.js';

export type OutboundMailStatus = 'sent' | 'queued' | 'failed';

export interface OutboundMailRow {
  mail_id: number;
  sent_by: number | null;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  reply_to: string | null;
  in_reply_to: string | null;
  subject: string;
  body_text: string;
  status: OutboundMailStatus;
  gateway_id: string | null;
  error: string | null;
  created_at: Date;
}

export interface InsertOutboundMailInput {
  sentBy: number;
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  replyTo?: string | null;
  inReplyTo?: string | null;
  subject: string;
  bodyText: string;
  status: OutboundMailStatus;
  gatewayId?: string | null;
  error?: string | null;
}

export async function insertOutboundMail(input: InsertOutboundMailInput): Promise<OutboundMailRow> {
  const result = await pool.query<OutboundMailRow>(
    `INSERT INTO outbound_mail
       (sent_by, from_address, to_addresses, cc_addresses, reply_to, in_reply_to, subject, body_text, status, gateway_id, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      input.sentBy,
      input.fromAddress,
      input.toAddresses,
      input.ccAddresses,
      input.replyTo ?? null,
      input.inReplyTo ?? null,
      input.subject,
      input.bodyText,
      input.status,
      input.gatewayId ?? null,
      input.error ?? null,
    ],
  );
  return result.rows[0];
}

/** A sender's own sent mail, newest first. Self-scoped by design. */
export async function listOutboundMailForUser(
  userid: number,
  opts: { limit: number; offset: number },
): Promise<OutboundMailRow[]> {
  const result = await pool.query<OutboundMailRow>(
    `SELECT * FROM outbound_mail WHERE sent_by = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [userid, opts.limit, opts.offset],
  );
  return result.rows;
}

/** Messages a sender has handed to the gateway since midnight UTC (the daily cap). */
export async function countOutboundMailToday(userid: number): Promise<number> {
  const result = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM outbound_mail
      WHERE sent_by = $1 AND status <> 'failed' AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [userid],
  );
  return Number(result.rows[0]?.n ?? 0);
}
