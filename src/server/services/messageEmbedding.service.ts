// Background sweep that embeds REDACTED message text for semantic-trajectory
// research analyses (adjacent-turn similarity, session drift — see
// semantic_metrics.csv in datasetExport.service.ts).
//
// Privacy invariants:
// - Embeds content_redacted ONLY, never raw content. A vector therefore never
//   encodes PHI beyond what the de-identified transcript export already carries.
// - Sandbox accounts are excluded (synthetic fixtures; cost with no research value).
//
// Shape mirrors the contentWipe redaction-gap sweep: idempotent 15-minute
// setInterval, config-gated via system_config, .unref() so it never holds the
// process open, and safe to run concurrently across blue-green pairs — the
// UPDATE is keyed by message_id and writing the same vector twice is harmless.
import { pool } from '../config/db.js';
import { embedTextBatch } from './embeddings.service.js';
import { toVectorLiteral } from '../db/knowledge.queries.js';

const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
// One sweep tick embeds at most this many messages (≤4 API calls). A busy day
// of sessions catches up within a few ticks; the backlog drains without ever
// creating a burst of large requests.
const SWEEP_BATCH_LIMIT = 400;

let sweepInterval: ReturnType<typeof setInterval> | null = null;

interface EmbeddingSettings {
  enabled: boolean;
}

async function getSettings(): Promise<EmbeddingSettings> {
  try {
    const result = await pool.query(
      `SELECT config_value FROM system_config WHERE config_key = 'message_embeddings'`
    );
    if (result.rows.length === 0) return { enabled: true };
    return result.rows[0].config_value as EmbeddingSettings;
  } catch (err) {
    console.error('[MessageEmbedding] failed to fetch settings:', err);
    return { enabled: false };
  }
}

/**
 * Embed a batch of pending messages (redacted, un-embedded, user/assistant,
 * non-sandbox). Returns the number embedded. Exported for tests and for the
 * admin backfill path; the scheduler just calls it on a timer.
 */
export async function sweepMessageEmbeddings(limit = SWEEP_BATCH_LIMIT): Promise<{ embedded: number }> {
  const settings = await getSettings();
  if (!settings.enabled) return { embedded: 0 };

  const pending = await pool.query<{ message_id: string; content_redacted: string }>(
    `SELECT m.message_id, m.content_redacted
       FROM messages m
       JOIN therapy_sessions ts ON ts.session_id = m.session_id
       LEFT JOIN users u ON u.userid = ts.user_id
      WHERE m.content_redacted IS NOT NULL
        AND m.content_redacted <> ''
        AND m.embedding IS NULL
        AND m.role IN ('user', 'assistant')
        AND u.is_sandbox IS NOT TRUE
      ORDER BY m.created_at
      LIMIT $1`,
    [limit]
  );
  if (pending.rows.length === 0) return { embedded: 0 };

  const vectors = await embedTextBatch(pending.rows.map(r => r.content_redacted));

  let embedded = 0;
  for (let i = 0; i < pending.rows.length; i++) {
    const result = await pool.query(
      `UPDATE messages SET embedding = $1::vector WHERE message_id = $2 AND embedding IS NULL`,
      [toVectorLiteral(vectors[i]), pending.rows[i].message_id]
    );
    embedded += result.rowCount ?? 0;
  }
  if (embedded > 0) {
    console.log(`[MessageEmbedding] embedded ${embedded} message(s)`);
  }
  return { embedded };
}

export function startMessageEmbeddingScheduler(): void {
  if (sweepInterval) return;
  sweepInterval = setInterval(() => {
    sweepMessageEmbeddings().catch(err => console.error('[MessageEmbedding] sweep failed:', err));
  }, SWEEP_INTERVAL_MS);
  sweepInterval.unref?.();
  // Catch up promptly after boot/restart instead of waiting a full interval.
  sweepMessageEmbeddings().catch(err => console.error('[MessageEmbedding] initial sweep failed:', err));
}

export function stopMessageEmbeddingScheduler(): void {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}
