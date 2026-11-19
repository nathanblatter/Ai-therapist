// Find stored redactions that fail the redaction output validation
// (ai-therapist-382), so they can be re-redacted later.
//
//   npx tsx src/database/scripts/findInvalidRedactions.ts            list only (default)
//   npx tsx src/database/scripts/findInvalidRedactions.ts --re-redact
//
// LIST MODE (default) makes no model calls and writes nothing. It prints one
// line per row (message id, session prefix, role, day, reason) and a summary.
// It never prints message text. Three classes:
//   invalid       content_redacted is stored but is not a redaction of the
//                 original (a refusal, a reply, a fragment). Original still
//                 present, so it can be re-redacted.
//   rejected      the pipeline already refused to store a redaction
//                 (metadata.redaction_rejected); content_redacted is NULL.
//   unverifiable  the original was wiped, so only the opening can be checked:
//                 content_redacted opens like a refusal or names a crisis line.
//                 Counted only (assistant turns often open "I'm really sorry"
//                 legitimately); --show-unverifiable lists them. These cannot
//                 be re-redacted; a researcher has to review them.
//
// --re-redact (explicit; makes model calls and writes): for every invalid or
// rejected row whose original is still present, clears content_redacted, the
// embedding and the rejection mark, then re-runs the normal session job
// (redactSession), whose output goes through the same validation. Rows it
// rejects again are marked again; nothing loops.
import { pathToFileURL } from 'node:url';
import { REDACTABLE_ROWS_SQL } from '../../server/db/redactionScope.js';
import {
  looksLikeRefusal,
  mentionsCrisisResource,
  validateRedaction,
} from '../../server/services/redactionValidation.js';

export interface StoredRow {
  message_id: number | string;
  session_id: string;
  role: string;
  created_at: Date | string;
  content: string | null;
  content_redacted: string | null;
  rejected: boolean;
}

export type RowClass = 'ok' | 'invalid' | 'rejected' | 'unverifiable';

export function classifyStoredRow(row: StoredRow): { cls: RowClass; reason: string } {
  if (row.rejected && row.content_redacted === null) {
    return { cls: 'rejected', reason: row.content === null ? 'rejected (original wiped)' : 'rejected' };
  }
  if (row.content_redacted === null) return { cls: 'ok', reason: '' };
  if (row.content !== null) {
    const v = validateRedaction(row.content, row.content_redacted);
    return v.ok
      ? { cls: 'ok', reason: '' }
      : { cls: 'invalid', reason: `${v.reason}${v.detail ? ` ${v.detail}` : ''}` };
  }
  if (looksLikeRefusal(row.content_redacted)) return { cls: 'unverifiable', reason: 'opens like a refusal' };
  if (mentionsCrisisResource(row.content_redacted)) return { cls: 'unverifiable', reason: 'names a crisis line' };
  return { cls: 'ok', reason: '' };
}

type Query = (sql: string, params: unknown[]) => Promise<{ rows: StoredRow[] }>;

export interface Finding {
  messageId: string;
  sessionId: string;
  role: string;
  day: string;
  cls: Exclude<RowClass, 'ok'>;
  reason: string;
  reRedactable: boolean;
}

const PAGE = 1000;

/** Read-only scan, keyset-paged by message_id. */
export async function findInvalidRedactions(query: Query): Promise<Finding[]> {
  const findings: Finding[] = [];
  let after = 0;
  for (;;) {
    const { rows } = await query(
      `SELECT message_id, session_id, role, created_at, content, content_redacted,
              (COALESCE(metadata, '{}'::jsonb) ? 'redaction_rejected') AS rejected
         FROM messages
        WHERE ${REDACTABLE_ROWS_SQL}
          AND (content_redacted IS NOT NULL OR COALESCE(metadata, '{}'::jsonb) ? 'redaction_rejected')
          AND message_id > $1
        ORDER BY message_id ASC
        LIMIT $2`,
      [after, PAGE],
    );
    for (const row of rows) {
      const { cls, reason } = classifyStoredRow(row);
      if (cls === 'ok') continue;
      findings.push({
        messageId: String(row.message_id),
        sessionId: row.session_id,
        role: row.role,
        day: new Date(row.created_at).toISOString().slice(0, 10),
        cls,
        reason,
        reRedactable: cls !== 'unverifiable' && row.content !== null,
      });
    }
    if (rows.length < PAGE) break;
    after = Number(rows[rows.length - 1].message_id);
  }
  return findings;
}

export function summarize(findings: Finding[]): string[] {
  const lines: string[] = [];
  for (const cls of ['invalid', 'rejected', 'unverifiable'] as const) {
    const of = findings.filter((f) => f.cls === cls);
    const byRole = [...new Set(of.map((f) => f.role))].map((r) => `${r} ${of.filter((f) => f.role === r).length}`);
    lines.push(
      `${cls}: ${of.length} row(s) in ${new Set(of.map((f) => f.sessionId)).size} session(s)` +
        (byRole.length ? ` (${byRole.join(', ')})` : ''),
    );
  }
  lines.push(`re-redactable (original still present): ${findings.filter((f) => f.reRedactable).length}`);
  return lines;
}

async function main(argv: string[]): Promise<void> {
  const reRedact = argv.includes('--re-redact');
  const showUnverifiable = argv.includes('--show-unverifiable');
  const { pool } = await import('../../server/config/db.js');
  try {
    const findings = await findInvalidRedactions((sql, params) => pool.query(sql, params));
    for (const f of findings) {
      if (f.cls === 'unverifiable' && !showUnverifiable) continue;
      console.log(`${f.cls}\t${f.messageId}\t${f.sessionId.substring(0, 12)}\t${f.role}\t${f.day}\t${f.reason}`);
    }
    for (const line of summarize(findings)) console.log(line);
    if (!reRedact) {
      console.log('List only: no model calls, nothing written. Pass --re-redact to re-run redaction on these rows.');
      return;
    }

    const targets = findings.filter((f) => f.reRedactable);
    const bySession = new Map<string, string[]>();
    for (const f of targets) bySession.set(f.sessionId, [...(bySession.get(f.sessionId) ?? []), f.messageId]);
    const { redactSession } = await import('../../server/services/sessionRedaction.service.js');
    for (const [sessionId, ids] of bySession) {
      await pool.query(
        `UPDATE messages
            SET content_redacted = NULL,
                embedding = NULL,
                metadata = COALESCE(metadata, '{}'::jsonb) - 'redaction_rejected' - 'redaction_error'
          WHERE message_id = ANY($1::bigint[]) AND content IS NOT NULL`,
        [ids],
      );
      await redactSession(sessionId);
      console.log(`re-redacted session ${sessionId.substring(0, 12)} (${ids.length} row(s))`);
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error('[findInvalidRedactions] fatal:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
