// Per-session redaction. Instead of redacting each message as it arrives (one
// slow double-pass model call per message, which gated live monitoring), we
// redact the whole session in a single batched job once the session ends.
import { pool } from '../config/db.js';
import { redactPHIBatch, type RedactionUsage } from './redaction.service.js';
import { REDACTABLE_ROWS_SQL, notRejectedSql } from '../db/redactionScope.js';
import { broadcastAdminEventForSession } from '../utils/adminBroadcast.js';
import { shouldSkipPostSessionWork } from './harnessPostSession.service.js';

interface RedactRow {
  message_id: number;
  content: string | null;
}

/**
 * Redact every not-yet-redacted participant-authored message in a session in
 * one batched (double-pass) model call, then persist + notify admins.
 * Fire-and-forget safe: never throws; failures are recorded in message metadata
 * for re-run.
 */
export async function redactSession(sessionId: string): Promise<void> {
  // A red-team harness session that did not opt in skips redaction and with it
  // the leak check (harnessPostSession.service.ts, ai-therapist-383). This
  // covers every end path and the 15-minute sweep, which all come through here.
  if (await shouldSkipPostSessionWork(sessionId, 'redaction')) return;

  const { rows } = await pool.query<RedactRow>(
    // Scope (including the tool_event_% rows whose body is participant free
    // text) comes from the shared fragment in db/redactionScope.ts so this job,
    // the content-wipe sweep and the admin status read cannot drift apart.
    // The other half of the tool-event fix is sessions.routes.ts no longer
    // pre-filling content_redacted.
    `SELECT message_id, content
       FROM messages
      WHERE session_id = $1
        AND content_redacted IS NULL
        AND ${REDACTABLE_ROWS_SQL}
        AND ${notRejectedSql()}
      ORDER BY message_id ASC`,
    [sessionId],
  );

  if (rows.length === 0) {
    return;
  }

  console.log(`Redacting session ${sessionId.substring(0, 12)}... (${rows.length} messages, batched)`);

  // Every model call the job makes lands here with its measured token usage
  // (ai-therapist-194): two per chunk in the happy path, more when single
  // messages are re-sent. One session_llm_usage row per call, recorded in the
  // finally below so a job that fails part-way still accounts for the calls it
  // made (ai-therapist-382; they used to be dropped on failure).
  const usage: RedactionUsage[] = [];
  // Messages whose output failed validation (ai-therapist-382): never stored
  // as redacted.
  const rejected = new Map<number, string>();
  // Messages never judged because the single-message call budget ran out:
  // marked with a redaction_error only, so the gap sweep retries them.
  const deferred = new Map<number, string>();
  try {
    const redacted = await redactPHIBatch(
      rows.map((r) => ({ id: r.message_id, content: r.content })),
      { usage, rejected, deferred },
    );
    const redactedAt = new Date().toISOString();

    // Persist each redacted message. A stale redaction_error from an earlier
    // failed attempt (and a redaction_rejected mark, when an explicit re-run
    // now succeeds) is cleared on success — leaving it would permanently
    // exclude the message from the content wipe (the wipe requires
    // redaction_error IS NULL) and inflate the ops error count forever.
    for (const [messageId, content] of redacted) {
      await pool.query(
        `UPDATE messages
            SET content_redacted = $1,
                metadata = (COALESCE(metadata, '{}'::jsonb) - 'redaction_error' - 'redaction_rejected')
                           || jsonb_build_object('redacted_at', $2::text)
          WHERE message_id = $3`,
        [content, redactedAt, messageId],
      );
    }

    // A rejected output is NOT stored: content_redacted stays NULL, so the
    // content wipe keeps the original, exports show the row as pending, and
    // the error count on the data-retention page shows it to staff.
    // redaction_rejected keeps the automatic jobs from re-sending it (see
    // notRejectedSql). The error text is a reason code, never message text.
    for (const [messageId, error] of rejected) {
      await pool.query(
        `UPDATE messages
            SET metadata = COALESCE(metadata, '{}'::jsonb)
                           || jsonb_build_object('redaction_error', $1::text, 'redaction_rejected', $2::text)
          WHERE message_id = $3 AND content_redacted IS NULL`,
        [error, redactedAt, messageId],
      );
    }
    // Deferred (call_cap): the model never saw these on their own, so they are
    // not rejections. redaction_error keeps them out of the content wipe and
    // in the staff error count; without redaction_rejected the 15-minute
    // sweep picks them up again, and each run judges up to the budget more,
    // so a long session converges instead of being stranded.
    for (const [messageId, error] of deferred) {
      await pool.query(
        `UPDATE messages
            SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('redaction_error', $1::text)
          WHERE message_id = $2 AND content_redacted IS NULL`,
        [error, messageId],
      );
    }
    if (rejected.size > 0) {
      console.warn(
        `Session ${sessionId.substring(0, 12)}... ${rejected.size} message(s) rejected by redaction validation; left unredacted and marked`,
      );
    }

    // Notify admin dashboards so a just-ended session's redacted view refreshes.
    if (global.io) {
      void broadcastAdminEventForSession(
        global.io,
        'session:redaction-complete',
        {
          sessionId,
          count: redacted.size,
          redactedAt,
        },
        sessionId,
      );
    }

    console.log(`Session ${sessionId.substring(0, 12)}... redacted (${redacted.size} messages)`);

    // Second opinion (ai-therapist-262): a decision model answers "does this
    // still contain an identifier?" per redacted message and flags misses for
    // the review queue. Fire-and-forget and fail-soft: it must never delay the
    // wipe, naming or insights, and only redacted text leaves the box.
    import('./redactionVerifier.service.js')
      .then((m) =>
        m.verifyRedactedMessages(
          sessionId,
          [...redacted].map(([id, text]) => ({ id, text })),
        ),
      )
      .catch((err) => console.error('[RedactionVerifier] leak-check failed (non-fatal):', err));
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Session redaction failed for ${sessionId}:`, errorMessage);

    // Mark the still-unredacted messages so the failure is visible and re-runnable.
    await pool
      .query(
        `UPDATE messages
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('redaction_error', $1::text)
        WHERE session_id = $2 AND content_redacted IS NULL AND ${REDACTABLE_ROWS_SQL} AND ${notRejectedSql()}`,
        [errorMessage, sessionId],
      )
      .catch((err) => console.error('Failed to record redaction error:', err));
  } finally {
    // Cost tracking (ai-therapist-25c): fire-and-forget, measured tokens.
    if (usage.length > 0) {
      import('../db/index.js')
        .then(({ recordLlmUsage }) =>
          Promise.all(usage.map((u) => recordLlmUsage(sessionId, 'redaction', u.model, u.tokensIn, u.tokensOut))),
        )
        .catch((err) => console.error('Failed to record redaction LLM usage (non-fatal):', err));
    }
  }
}
