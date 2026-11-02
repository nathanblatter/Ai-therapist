// outbound_mail (120): the audit of staff email sent from the admin Mail
// view (ai-therapist-283 phase 2). Written by mailCompose.service only.
import { pool } from '../config/db.js';

export type OutboundMailStatus = 'pending' | 'sent' | 'queued' | 'failed';

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

export interface ReserveOutboundMailInput {
  sentBy: number;
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  replyTo?: string | null;
  inReplyTo?: string | null;
  subject: string;
  bodyText: string;
}

/**
 * Record the message as 'pending' and count it against the sender's daily
 * cap in one transaction, serialized per sender by an advisory lock so
 * concurrent sends cannot all pass the cap check. Returns null when the cap
 * is reached (nothing written).
 */
export async function reserveOutboundMail(
  input: ReserveOutboundMailInput,
  dailyCap: number,
): Promise<OutboundMailRow | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('staff_mail'), $1)`, [input.sentBy]);
    const today = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM outbound_mail
        WHERE sent_by = $1 AND status <> 'failed'
          AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      [input.sentBy],
    );
    if (Number(today.rows[0]?.n ?? 0) >= dailyCap) {
      await client.query('ROLLBACK');
      return null;
    }
    const inserted = await client.query<OutboundMailRow>(
      `INSERT INTO outbound_mail
         (sent_by, from_address, to_addresses, cc_addresses, reply_to, in_reply_to, subject, body_text, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
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
      ],
    );
    await client.query('COMMIT');
    return inserted.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Write the gateway's verdict onto a reserved row. */
export async function setOutboundMailVerdict(
  mailId: number,
  verdict: { status: Exclude<OutboundMailStatus, 'pending'>; gatewayId?: string | null; error?: string | null },
): Promise<OutboundMailRow> {
  const result = await pool.query<OutboundMailRow>(
    `UPDATE outbound_mail SET status = $2, gateway_id = $3, error = $4 WHERE mail_id = $1 RETURNING *`,
    [mailId, verdict.status, verdict.gatewayId ?? null, verdict.error ?? null],
  );
  if (result.rows.length === 0) throw new Error('outbound_mail row not found');
  return result.rows[0];
}

/** List-view row: everything but the body. */
export type OutboundMailSummary = Omit<OutboundMailRow, 'body_text'>;

/** A sender's own sent mail, newest first, without bodies. Self-scoped by design. */
export async function listOutboundMailForUser(
  userid: number,
  opts: { limit: number; offset: number },
): Promise<OutboundMailSummary[]> {
  const result = await pool.query<OutboundMailSummary>(
    `SELECT mail_id, sent_by, from_address, to_addresses, cc_addresses, reply_to, in_reply_to, subject, status,
            gateway_id, error, created_at
       FROM outbound_mail WHERE sent_by = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
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
