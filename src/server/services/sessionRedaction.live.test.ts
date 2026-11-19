// Rejected redactions against a REAL Postgres (ai-therapist-382). The unit
// tests mock the pool, so they cannot show that a rejected row really keeps
// content_redacted NULL, that the content wipe keeps its original, that the
// 15-minute sweep does not pick it up again, that the staff error count sees
// it, or that `NULL ? key` does not silently drop rows without metadata.
// Skipped unless asked for:
//
//   REDACTION_SQL_DATABASE_URL=postgresql://.../rt_scratch_db \
//     npx vitest run src/server/services/sessionRedaction.live.test.ts
//
// The database must be a THROWAWAY one at the migration head
// (src/database/scripts/migrateFromScratch.ts). The file refuses any database
// whose name does not start with `rt_` or contain `scratch`. The model is a
// mock (no network, no spend); it answers with recorded refusal shapes.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';

const URL_ = process.env.REDACTION_SQL_DATABASE_URL ?? '';
const dbName = (() => {
  try {
    return new URL(URL_).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
})();
const LIVE = URL_ !== '' && (dbName.startsWith('rt_') || dbName.includes('scratch'));

const { holder, createMock } = vi.hoisted(() => ({ holder: { pool: null as unknown }, createMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  get pool() {
    return holder.pool;
  },
}));
vi.mock('openai', () => ({
  default: class MockOpenAI {
    responses = { create: createMock };
  },
}));
vi.mock('./redactionVerifier.service.js', () => ({ verifyRedactedMessages: vi.fn(async () => undefined) }));

const { redactSession } = await import('./sessionRedaction.service.js');
const { findEndedSessionsWithRedactionGaps, executeContentWipe, getWipeStats } = await import(
  './contentWipe.service.js'
);
const { findInvalidRedactions } = await import('../../database/scripts/findInvalidRedactions.js');

const CRISIS = 'I have been saving my pills and tonight is the night';
const REFUSAL = 'I’m really sorry you’re feeling like this. You don’t have to go through this alone. Call or text 988.';

type Item = { i: number; text: string };
/** A single message under the default (legacy) wording arrives as bare text. */
function parseInput(input: string): Item[] | null {
  try {
    const v = JSON.parse(input) as unknown;
    return Array.isArray(v) ? (v as Item[]) : null;
  } catch {
    return null;
  }
}

/** Echoes every request: batch in the schema shape, bare text as itself. */
function echoReply(opts: { input: string }) {
  const sent = parseInput(opts.input);
  return Promise.resolve({ output_text: sent ? JSON.stringify({ items: sent }) : opts.input });
}

/** Refuses any request that contains the crisis message; echoes the rest. */
function model(opts: { input: string }) {
  const sent = parseInput(opts.input);
  if (!sent) {
    return Promise.resolve({
      output_text: opts.input === CRISIS ? REFUSAL : opts.input,
      usage: { input_tokens: 5, output_tokens: 5 },
    });
  }
  if (sent.some((s) => s.text === CRISIS))
    return Promise.resolve({ output_text: REFUSAL, usage: { input_tokens: 9, output_tokens: 9 } });
  return Promise.resolve({
    output_text: JSON.stringify({ items: sent }),
    usage: { input_tokens: 5, output_tokens: 5 },
  });
}

const tag = `redact382_${Date.now().toString(36)}`;
let pool: pg.Pool;
let userId = 0;
let sessionId = '';
const ids: Record<string, number> = {};
let callsInFirstRun = 0;
const q = (text: string, params: unknown[] = []) => pool.query(text, params);

describe.skipIf(!LIVE)('rejected redactions in Postgres (ai-therapist-382)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: URL_ });
    holder.pool = pool;
    const u = await q(
      `INSERT INTO users (username, password, role, organization_id) VALUES ($1, 'x', 'participant', 1) RETURNING userid`,
      [tag],
    );
    userId = u.rows[0].userid;
    const s = await q(
      `INSERT INTO therapy_sessions (user_id, status, ended_at) VALUES ($1, 'ended', now()) RETURNING session_id`,
      [userId],
    );
    sessionId = s.rows[0].session_id;
    // Created two days ago so the 24-hour wipe applies to them.
    const ins = async (key: string, role: string, content: string, metadata: string | null) => {
      const r = await q(
        `INSERT INTO messages (session_id, role, message_type, content, metadata, created_at)
         VALUES ($1, $2, 'text', $3, $4::jsonb, now() - interval '2 days') RETURNING message_id`,
        [sessionId, role, content, metadata],
      );
      ids[key] = Number(r.rows[0].message_id);
    };
    await ins('plain', 'user', 'I had a long week at work', '{}');
    await ins('crisis', 'user', CRISIS, null); // NULL metadata on purpose
    await ins('reply', 'assistant', 'That sounds like a lot to carry. What happened?', '{}');
  });

  afterAll(async () => {
    if (!pool) return;
    await q(`DELETE FROM session_llm_usage WHERE session_id = $1`, [sessionId]);
    await q(`DELETE FROM therapy_sessions WHERE session_id = $1`, [sessionId]);
    await q(`DELETE FROM users WHERE userid = $1`, [userId]);
    await pool.end();
  });

  it('stores the valid redactions and leaves the refused message unredacted and marked', async () => {
    createMock.mockImplementation(model);
    await redactSession(sessionId);
    callsInFirstRun = createMock.mock.calls.length;
    const { rows } = await q(
      `SELECT message_id, content, content_redacted, metadata FROM messages WHERE session_id = $1`,
      [sessionId],
    );
    const by = new Map(rows.map((r) => [Number(r.message_id), r]));
    expect(by.get(ids.plain)?.content_redacted).toBe('I had a long week at work');
    expect(by.get(ids.reply)?.content_redacted).toBe('That sounds like a lot to carry. What happened?');
    const crisis = by.get(ids.crisis);
    expect(crisis?.content_redacted).toBeNull();
    expect(crisis?.content).toBe(CRISIS);
    expect(crisis?.metadata.redaction_error).toMatch(/^Redaction output rejected: /);
    expect(crisis?.metadata.redaction_error).not.toContain('pills');
    expect(crisis?.metadata.redaction_rejected).toEqual(expect.any(String));
    // No stored text anywhere in the session contains the refusal.
    expect(rows.map((r) => r.content_redacted ?? '').join(' ')).not.toContain('sorry');
  });

  it('records one session_llm_usage row per model call (batch refusal, 3 singles, pass-2 batch)', async () => {
    // The insert is fire-and-forget (dynamic import of db/index.js first).
    let n = 0;
    for (let k = 0; k < 50 && n < 5; k++) {
      await new Promise((r) => setTimeout(r, 100));
      const { rows } = await q(`SELECT count(*)::int AS n FROM session_llm_usage WHERE session_id = $1`, [sessionId]);
      n = rows[0].n;
    }
    expect(callsInFirstRun).toBe(5);
    expect(n).toBe(callsInFirstRun);
  });

  it('the end-of-session job and the 15-minute sweep do not pick the rejected row up again', async () => {
    createMock.mockClear();
    expect(await findEndedSessionsWithRedactionGaps()).not.toContain(sessionId);
    await redactSession(sessionId);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('a row with NULL metadata and no redaction is still a gap (the COALESCE guard)', async () => {
    const r = await q(
      `INSERT INTO messages (session_id, role, message_type, content, metadata) VALUES ($1, 'user', 'text', 'ok then', NULL) RETURNING message_id`,
      [sessionId],
    );
    expect(await findEndedSessionsWithRedactionGaps()).toContain(sessionId);
    await q(`DELETE FROM messages WHERE message_id = $1`, [r.rows[0].message_id]);
  });

  it('the content wipe keeps the rejected original and wipes the redacted ones; staff see the error count', async () => {
    const before = (await getWipeStats()) as { stats: { redaction_errors: number } };
    expect(before.stats.redaction_errors).toBeGreaterThanOrEqual(1);
    const res = await executeContentWipe('manual', tag);
    expect(res.success).toBe(true);
    const { rows } = await q(`SELECT message_id, content FROM messages WHERE session_id = $1`, [sessionId]);
    const by = new Map(rows.map((r) => [Number(r.message_id), r.content]));
    expect(by.get(ids.plain)).toBeNull();
    expect(by.get(ids.reply)).toBeNull();
    expect(by.get(ids.crisis)).toBe(CRISIS);
  });

  it('the list-only script reports the rejected row and a stored refusal, without model calls', async () => {
    const r = await q(
      `INSERT INTO messages (session_id, role, message_type, content, content_redacted, metadata)
       VALUES ($1, 'user', 'text', $2, $3, '{}') RETURNING message_id`,
      [sessionId, 'I cannot keep doing this every single day', REFUSAL],
    );
    createMock.mockClear();
    const findings = (await findInvalidRedactions((sql, params) => pool.query(sql, params))).filter(
      (f) => f.sessionId === sessionId,
    );
    expect(createMock).not.toHaveBeenCalled();
    expect(findings.find((f) => f.messageId === String(ids.crisis))).toMatchObject({
      cls: 'rejected',
      reRedactable: true,
    });
    expect(findings.find((f) => f.messageId === String(r.rows[0].message_id))).toMatchObject({
      cls: 'invalid',
      reRedactable: true,
    });
    expect(findings.some((f) => f.messageId === String(ids.plain))).toBe(false);
  });

  it('call_cap rows are deferred, not rejected: error recorded, kept from the wipe, picked up by the sweep, then redacted', async () => {
    // Review of PR #102. Two messages: pass-1 batch refused, both singles
    // echo (budget 2 -> 0), pass-2 batch refused with no budget left.
    const s = await q(
      `INSERT INTO therapy_sessions (user_id, status, ended_at) VALUES ($1, 'ended', now()) RETURNING session_id`,
      [userId],
    );
    const sid = s.rows[0].session_id as string;
    const mk = async (content: string) =>
      Number(
        (
          await q(
            `INSERT INTO messages (session_id, role, message_type, content, metadata, created_at)
             VALUES ($1, 'user', 'text', $2, '{}', now() - interval '2 days') RETURNING message_id`,
            [sid, content],
          )
        ).rows[0].message_id,
      );
    const a = await mk('My week was fine');
    const b = await mk('Work is busy');
    createMock
      .mockReset()
      .mockResolvedValueOnce({ output_text: REFUSAL })
      .mockImplementationOnce(echoReply)
      .mockImplementationOnce(echoReply)
      .mockResolvedValueOnce({ output_text: REFUSAL });
    await redactSession(sid);
    const after1 = await q(`SELECT content, content_redacted, metadata FROM messages WHERE message_id = ANY($1)`, [
      [a, b],
    ]);
    for (const r of after1.rows) {
      expect(r.content_redacted).toBeNull();
      expect(r.metadata.redaction_error).toMatch(/^Redaction deferred: call_cap/);
      expect(r.metadata.redaction_rejected).toBeUndefined();
    }
    expect(await findEndedSessionsWithRedactionGaps()).toContain(sid);
    await executeContentWipe('manual', tag);
    const kept = await q(`SELECT count(*)::int AS n FROM messages WHERE message_id = ANY($1) AND content IS NOT NULL`, [
      [a, b],
    ]);
    expect(kept.rows[0].n).toBe(2);

    createMock.mockReset().mockImplementation(echoReply);
    await redactSession(sid);
    const after2 = await q(`SELECT content_redacted, metadata FROM messages WHERE message_id = ANY($1)`, [[a, b]]);
    for (const r of after2.rows) {
      expect(r.content_redacted).not.toBeNull();
      expect(r.metadata.redaction_error).toBeUndefined();
    }
    await q(`DELETE FROM session_llm_usage WHERE session_id = $1`, [sid]);
    await q(`DELETE FROM therapy_sessions WHERE session_id = $1`, [sid]);
  });

  it('with "require redaction complete" OFF the rejected original is wiped and nothing unredacted remains', async () => {
    const prev = await q(`SELECT config_value FROM system_config WHERE config_key = 'content_retention'`);
    await q(
      `INSERT INTO system_config (config_key, config_value) VALUES ('content_retention', $1::jsonb)
       ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value`,
      [
        JSON.stringify({
          enabled: true,
          retention_hours: 24,
          wipe_time: '03:00',
          require_redaction_complete: false,
          last_wipe_at: null,
          last_wipe_count: 0,
        }),
      ],
    );
    try {
      await executeContentWipe('manual', tag);
      const { rows } = await q(`SELECT content, content_redacted, metadata FROM messages WHERE message_id = $1`, [
        ids.crisis,
      ]);
      expect(rows[0].content).toBeNull();
      expect(rows[0].content_redacted).toBeNull();
      expect(rows[0].metadata.redaction_rejected).toEqual(expect.any(String));
      // A wiped row is no longer a gap: the sweep does not resend it.
      expect(await findEndedSessionsWithRedactionGaps()).not.toContain(sessionId);
    } finally {
      if (prev.rows.length === 0) await q(`DELETE FROM system_config WHERE config_key = 'content_retention'`);
      else
        await q(`UPDATE system_config SET config_value = $1::jsonb WHERE config_key = 'content_retention'`, [
          JSON.stringify(prev.rows[0].config_value),
        ]);
    }
  });
});
