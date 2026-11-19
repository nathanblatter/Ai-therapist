// Find, and optionally re-check, redacted messages whose leak check errored
// (ai-therapist-288).
//
// Until 2026-11-19 an errored check was written as flagged=false, so it never
// reached the review queue. The largest known batch is the ai-therapist-284
// outage: while the Decisions request shape was wrong every check 400'd with
// "Missing required parameter: questions" and each row got
// {p_leak: -1, flagged: false, error: ...}. db/leakCheckSql.ts counts those
// rows as errored now, so they show in the queue; this module lets an operator
// list them and, behind an explicit flag, run the verifier over them again.
//
// Listing reads metadata only (ids, dates, the error text, the length of the
// redacted text); it never reads or prints message text. Re-checking reads
// content_redacted (never raw content) and makes one OpenAI call per row
// through verifyRedactedMessages, which overwrites the row's redaction_check
// with the new verdict (checked, or errored again).
import { pool } from '../config/db.js';
import { leakCheckErroredSql, leakCheckReviewedSql } from '../db/leakCheckSql.js';
import { redactableRowsSql } from '../db/redactionScope.js';
import { getBackendModel } from '../utils/backendModels.js';
import {
  DECISIONS_MODEL,
  RESPONSES_MODEL,
  verifyRedactedMessages,
  type VerifySummary,
} from './redactionVerifier.service.js';

export interface ErroredLeakCheckRow {
  message_id: number;
  session_id: string;
  message_created_at: string;
  checked_at: string | null;
  error: string | null;
  reviewed: boolean;
  /** Length of content_redacted, for the cost estimate. */
  chars: number;
}

export interface ListOptions {
  /** Also list errored rows a researcher has already reviewed (default: no). */
  includeReviewed?: boolean;
  sessionId?: string | null;
  limit?: number | null;
}

export async function listErroredLeakChecks(opts: ListOptions = {}): Promise<ErroredLeakCheckRow[]> {
  const { rows } = await pool.query<{
    message_id: string;
    session_id: string;
    message_created_at: string;
    checked_at: string | null;
    error: string | null;
    reviewed: boolean;
    chars: number;
  }>(
    `SELECT m.message_id::text AS message_id, m.session_id, m.created_at::text AS message_created_at,
            m.metadata->'redaction_check'->>'checked_at' AS checked_at,
            m.metadata->'redaction_check'->>'error' AS error,
            ${leakCheckReviewedSql('m')} AS reviewed,
            char_length(m.content_redacted) AS chars
       FROM messages m
      WHERE m.content_redacted IS NOT NULL AND btrim(m.content_redacted) <> ''
        AND ${redactableRowsSql('m')}
        AND ${leakCheckErroredSql('m')}
        AND ($1::boolean OR NOT ${leakCheckReviewedSql('m')})
        AND ($2::text IS NULL OR m.session_id = $2::text)
      ORDER BY m.created_at, m.message_id
      LIMIT $3`,
    [opts.includeReviewed === true, opts.sessionId ?? null, opts.limit ?? null],
  );
  return rows.map((r) => ({ ...r, message_id: Number(r.message_id), chars: Number(r.chars) }));
}

// Token estimate per re-check: the leak question and instructions (about 200
// tokens), plus the text at about 4 characters per token. Output: the
// Decisions API answers with a probability (a few tokens); the Responses
// fallback reasons at low effort before its JSON, budgeted at 300 tokens.
const PROMPT_OVERHEAD_TOKENS = 200;
const DECISIONS_OUTPUT_TOKENS = 5;
const RESPONSES_OUTPUT_TOKENS = 300;

export interface RecheckCostEstimate {
  rows: number;
  inputTokens: number;
  /** All rows answered by the Decisions API (the configured default). */
  decisionsUsd: number;
  /** All rows answered by the Responses fallback (the upper bound). */
  responsesUsd: number;
}

function rate(model: string): { input: number; output: number } {
  const m = getBackendModel(model);
  // Unknown model: price it high rather than at zero.
  return m ? { input: m.inputPerMillion, output: m.outputPerMillion } : { input: 2, output: 10 };
}

export function estimateRecheckCost(rows: Array<Pick<ErroredLeakCheckRow, 'chars'>>): RecheckCostEstimate {
  const inputTokens = rows.reduce((sum, r) => sum + PROMPT_OVERHEAD_TOKENS + Math.ceil(r.chars / 4), 0);
  const usd = (model: string, outPerRow: number) => {
    const r = rate(model);
    return (inputTokens * r.input + rows.length * outPerRow * r.output) / 1_000_000;
  };
  return {
    rows: rows.length,
    inputTokens,
    decisionsUsd: usd(DECISIONS_MODEL, DECISIONS_OUTPUT_TOKENS),
    responsesUsd: usd(RESPONSES_MODEL, RESPONSES_OUTPUT_TOKENS),
  };
}

export interface ErroredSummary {
  total: number;
  reviewed: number;
  sessions: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  /** Rows per distinct error text (clipped), most common first. */
  byError: Array<{ error: string; count: number }>;
}

export function summarizeErrored(rows: ErroredLeakCheckRow[]): ErroredSummary {
  const byError = new Map<string, number>();
  for (const r of rows) {
    const key = (r.error ?? '(no error text)').slice(0, 100);
    byError.set(key, (byError.get(key) ?? 0) + 1);
  }
  return {
    total: rows.length,
    reviewed: rows.filter((r) => r.reviewed).length,
    sessions: new Set(rows.map((r) => r.session_id)).size,
    firstMessageAt: rows[0]?.message_created_at ?? null,
    lastMessageAt: rows.at(-1)?.message_created_at ?? null,
    byError: [...byError.entries()].map(([error, count]) => ({ error, count })).sort((a, b) => b.count - a.count),
  };
}

type Verify = (sessionId: string, items: Array<{ id: number; text: string }>) => Promise<VerifySummary>;

/**
 * Run the verifier again over the given rows, one session at a time. Makes
 * one OpenAI call per row. Reviewed rows are skipped: a researcher's sign-off
 * stands. Rows whose redacted text has since gone blank are skipped too.
 */
export async function recheckErroredLeakChecks(
  rows: ErroredLeakCheckRow[],
  verify: Verify = verifyRedactedMessages,
): Promise<VerifySummary & { sessions: number }> {
  const total = { checked: 0, flagged: 0, errored: 0, sessions: 0 };
  const bySession = new Map<string, number[]>();
  for (const r of rows) {
    if (r.reviewed) continue;
    const ids = bySession.get(r.session_id) ?? [];
    ids.push(r.message_id);
    bySession.set(r.session_id, ids);
  }
  for (const [sessionId, ids] of bySession) {
    const { rows: texts } = await pool.query<{ message_id: string; content_redacted: string }>(
      `SELECT message_id::text AS message_id, content_redacted
         FROM messages
        WHERE message_id = ANY($1::bigint[]) AND content_redacted IS NOT NULL AND btrim(content_redacted) <> ''`,
      [ids],
    );
    if (texts.length === 0) continue;
    const summary = await verify(
      sessionId,
      texts.map((t) => ({ id: Number(t.message_id), text: t.content_redacted })),
    );
    total.checked += summary.checked;
    total.flagged += summary.flagged;
    total.errored += summary.errored;
    total.sessions++;
  }
  return total;
}
