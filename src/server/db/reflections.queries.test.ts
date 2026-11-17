// Participant reflections queries (ai-therapist-204): ownership scoping and
// the column allow-list are properties of the SQL itself, so they are pinned
// against the query text here.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({ pool: { query: queryMock, on: vi.fn() } }));

import { listOwnReflectionSessions, countOwnWorksheets } from './reflections.queries.js';

beforeEach(() => {
  queryMock.mockReset();
});

const normalize = (sql: string) => sql.replace(/\s+/g, ' ');

describe('listOwnReflectionSessions', () => {
  it('scopes to the caller and requires the insights row to carry the same owner', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listOwnReflectionSessions(7, 20);
    const [sql, params] = queryMock.mock.calls[0];
    const text = normalize(sql);
    expect(text).toContain("WHERE ts.user_id = $1 AND ts.status = 'ended'");
    expect(text).toContain('ON si.session_id = ts.session_id AND si.user_id = ts.user_id');
    // The only caller-derived parameter is the caller's own id: no session id.
    expect(params).toHaveLength(3);
    expect(params[0]).toBe(7);
    expect(params[1]).toBe(20);
    expect(Array.isArray(params[2])).toBe(true);
  });

  it('selects only participant-safe columns', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listOwnReflectionSessions(7);
    const text = normalize(queryMock.mock.calls[0][0]);
    const selectList = text.slice(0, text.indexOf(' FROM therapy_sessions ts'));
    const aliases = [...selectList.matchAll(/ AS ([a-z_]+)/g)].map((m) => m[1]);
    expect(aliases).toEqual([
      'session_date',
      'topics',
      'techniques',
      'checkin_topic',
      'checkin_goal',
      'worksheets_completed',
      'text_withheld',
    ]);
    expect(text).not.toMatch(/SELECT \*|si\.\*|ts\.\*/);
    for (const forbidden of [
      'soap_note',
      'affect_curve',
      'notes_for_next_session',
      'crisis_risk_score',
      'risk_score',
      'risk_band',
      'headline',
      'mood_trajectory',
      'follow_up',
      'session_name',
      'acoustic',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('withholds on every safety signal the summarizer treats as safety context', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listOwnReflectionSessions(7);
    const [sql, params] = queryMock.mock.calls[0];
    const text = normalize(sql);
    for (const signal of [
      'ts.crisis_flagged',
      'ts.crisis_severity IS NOT NULL',
      "summary->>'safety'",
      'FROM crisis_events',
      'FROM risk_check_steps',
      'FROM escalations',
      'FROM tool_invocations',
      'FROM adverse_event_reports',
    ]) {
      expect(text).toContain(signal);
    }
    expect(params[2]).toEqual([
      'show_resource_card',
      'get_crisis_resources',
      'create_safety_plan',
      'escalate_to_human',
    ]);
  });

  it('parses the worksheet count', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          session_date: new Date('2026-11-10T18:00:00Z'),
          topics: ['x'],
          techniques: null,
          checkin_topic: null,
          checkin_goal: null,
          worksheets_completed: '2',
          text_withheld: false,
        },
      ],
    });
    const rows = await listOwnReflectionSessions(7);
    expect(rows[0].worksheets_completed).toBe(2);
  });
});

describe('countOwnWorksheets', () => {
  it('counts through the session -> user join only', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ completed: '3', in_progress: '1' }] });
    const counts = await countOwnWorksheets(7);
    expect(counts).toEqual({ completed: 3, in_progress: 1 });
    const [sql, params] = queryMock.mock.calls[0];
    expect(normalize(sql)).toContain('WHERE ts.user_id = $1');
    expect(params).toEqual([7]);
  });
});
