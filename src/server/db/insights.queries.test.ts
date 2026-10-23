// Session insights data-access (ai-therapist-236 chunk 4): upsert
// serialisation (affect_curve null stays SQL NULL), the ended-session and
// non-null summary predicates behind memory injection, rowCount-driven
// booleans, and null defaults for missing rows.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({ pool: { query: queryMock, connect: vi.fn(), on: vi.fn() } }));

import {
  getSessionInsights,
  upsertSessionInsights,
  markSoapReviewed,
  getRecentUserSummaries,
  countUserEndedSessions,
  setSessionCheckin,
  getUserMemoryEnabled,
  setUserMemoryEnabled,
  setSessionNotesForNextSession,
  getLatestClinicianNote,
} from './insights.queries.js';

function lastCall(): [string, unknown[]] {
  return queryMock.mock.calls[queryMock.mock.calls.length - 1] as [string, unknown[]];
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('getSessionInsights', () => {
  it('returns the row or null', async () => {
    await expect(getSessionInsights('s1')).resolves.toBeNull();
    expect(lastCall()).toEqual(['SELECT * FROM session_insights WHERE session_id = $1', ['s1']]);
    const row = { session_id: 's1', summary: null };
    queryMock.mockResolvedValue({ rows: [row] });
    await expect(getSessionInsights('s1')).resolves.toBe(row);
  });
});

describe('upsertSessionInsights', () => {
  const summary = { headline: 'h', topics: ['sleep'], safety: '' };
  const soap = { subjective: 's', plan: 'p' };

  it('serialises the JSON columns and refreshes them on conflict', async () => {
    const curve = [{ turn: 1, valence: -0.2, arousal: 0.4, label: 'flat' }];
    await upsertSessionInsights('s1', 42, summary, soap, 'gpt-5.2', curve);
    const [sql, params] = lastCall();
    expect(sql).toMatch(/INSERT INTO session_insights \(session_id, user_id, summary, soap_note, model, affect_curve\)\s+VALUES \(\$1, \$2, \$3, \$4, \$5, \$6\)/);
    expect(sql).toContain('ON CONFLICT (session_id) DO UPDATE');
    for (const col of ['summary', 'soap_note', 'model', 'affect_curve']) {
      expect(sql).toContain(`${col} = EXCLUDED.${col}`);
    }
    expect(sql).toContain('updated_at = CURRENT_TIMESTAMP');
    // A re-run must not overwrite reviewer state.
    expect(sql).not.toContain('soap_status');
    expect(sql).not.toContain('soap_reviewed');
    expect(params).toEqual(['s1', 42, JSON.stringify(summary), JSON.stringify(soap), 'gpt-5.2', JSON.stringify(curve)]);
  });

  it('keeps a null affect curve as SQL NULL rather than the string "null"', async () => {
    await upsertSessionInsights('s1', null, summary, soap, 'gpt-5.2');
    const [, params] = lastCall();
    expect(params[1]).toBeNull();
    expect(params[5]).toBeNull();
  });
});

describe('markSoapReviewed', () => {
  it('stamps the reviewer and reports whether a row changed', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await expect(markSoapReviewed('s1', 'dr_t')).resolves.toBe(true);
    const [sql, params] = lastCall();
    expect(sql).toContain("SET soap_status = 'reviewed', soap_reviewed_by = $2, soap_reviewed_at = CURRENT_TIMESTAMP");
    expect(sql).toContain('WHERE session_id = $1');
    expect(params).toEqual(['s1', 'dr_t']);

    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(markSoapReviewed('missing', 'dr_t')).resolves.toBe(false);
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: null });
    await expect(markSoapReviewed('missing', 'dr_t')).resolves.toBe(false);
  });
});

describe('getRecentUserSummaries', () => {
  it('only surfaces ended sessions with a summary, newest first, default limit 3', async () => {
    await getRecentUserSummaries(42);
    const [sql, params] = lastCall();
    expect(sql).toContain('JOIN therapy_sessions ts ON ts.session_id = si.session_id');
    expect(sql).toContain("WHERE si.user_id = $1 AND si.summary IS NOT NULL AND ts.status = 'ended'");
    expect(sql).toMatch(/ORDER BY si\.created_at DESC\s+LIMIT \$2/);
    expect(params).toEqual([42, 3]);

    await getRecentUserSummaries(42, 10);
    expect(lastCall()[1]).toEqual([42, 10]);
  });
});

describe('countUserEndedSessions', () => {
  it('parses the count and defaults a missing row to 0', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ n: '4' }] });
    await expect(countUserEndedSessions(42)).resolves.toBe(4);
    const [sql, params] = lastCall();
    expect(sql).toContain("FROM therapy_sessions WHERE user_id = $1 AND status = 'ended'");
    expect(params).toEqual([42]);

    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(countUserEndedSessions(42)).resolves.toBe(0);
  });
});

describe('setSessionCheckin', () => {
  it('stores the check-in as JSON against the session', async () => {
    const checkin = { mood: 3, topic: 'work', goal: 'calm', submitted_at: '2026-01-01T00:00:00Z' };
    await setSessionCheckin('s1', checkin);
    expect(lastCall()).toEqual(['UPDATE therapy_sessions SET checkin = $2 WHERE session_id = $1', ['s1', JSON.stringify(checkin)]]);
  });
});

describe('memory consent flag', () => {
  it('reads false when the user is missing or the flag is null', async () => {
    await expect(getUserMemoryEnabled(42)).resolves.toBe(false);
    expect(lastCall()).toEqual(['SELECT memory_enabled FROM users WHERE userid = $1', [42]]);
    queryMock.mockResolvedValueOnce({ rows: [{ memory_enabled: null }] });
    await expect(getUserMemoryEnabled(42)).resolves.toBe(false);
    queryMock.mockResolvedValueOnce({ rows: [{ memory_enabled: true }] });
    await expect(getUserMemoryEnabled(42)).resolves.toBe(true);
  });

  it('writes the flag with the session id first', async () => {
    await setUserMemoryEnabled(42, true);
    const [sql, params] = lastCall();
    expect(sql).toContain('UPDATE users SET memory_enabled = $2, updated_at = CURRENT_TIMESTAMP WHERE userid = $1');
    expect(params).toEqual([42, true]);
  });
});

describe('therapist notes for the next session', () => {
  it('setSessionNotesForNextSession stamps author and time and reports the row count', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await expect(setSessionNotesForNextSession('s1', 'Try the breathing exercise', 'dr_t')).resolves.toBe(true);
    const [sql, params] = lastCall();
    expect(sql).toContain('SET notes_for_next_session = $2, notes_author = $3, notes_created_at = CURRENT_TIMESTAMP');
    expect(sql).toContain('WHERE session_id = $1');
    expect(params).toEqual(['s1', 'Try the breathing exercise', 'dr_t']);

    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(setSessionNotesForNextSession('missing', 'x', 'dr_t')).resolves.toBe(false);
  });

  it('getLatestClinicianNote takes the newest non-empty note across the user sessions', async () => {
    const created = new Date('2026-01-05T00:00:00Z');
    queryMock.mockResolvedValueOnce({ rows: [{ session_id: 's9', notes_for_next_session: 'Follow up on sleep', notes_author: 'dr_t', notes_created_at: created }] });
    await expect(getLatestClinicianNote(42)).resolves.toEqual({ notes: 'Follow up on sleep', author: 'dr_t', created_at: created, session_id: 's9' });
    const [sql, params] = lastCall();
    expect(sql).toContain("WHERE user_id = $1 AND notes_for_next_session IS NOT NULL AND notes_for_next_session != ''");
    expect(sql).toMatch(/ORDER BY notes_created_at DESC\s+LIMIT 1/);
    expect(params).toEqual([42]);
  });

  it('getLatestClinicianNote returns null when the user has no notes', async () => {
    await expect(getLatestClinicianNote(42)).resolves.toBeNull();
  });
});
