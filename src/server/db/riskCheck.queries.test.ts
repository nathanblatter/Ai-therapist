// Read surface for the structured risk ladder (ai-therapist-198). The folding
// logic is what the admin panels and any future analytics read as "how far did
// the assessment get and where did it land", so it is tested directly rather
// than through the UI.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { poolQueryMock } = vi.hoisted(() => ({ poolQueryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({ pool: { query: poolQueryMock } }));

const {
  summarizeRiskCheckSteps,
  getParticipantRiskCheckLadders,
  getSessionRiskCheckLadder,
  sessionHasRiskCheck,
} = await import('./riskCheck.queries.js');

type Row = Parameters<typeof summarizeRiskCheckSteps>[1][number];

let seq = 0;
function step(partial: Partial<Row> & Pick<Row, 'step' | 'risk_band'>): Row {
  seq += 1;
  return {
    check_step_id: seq,
    session_id: 's1',
    crisis_event_id: null,
    answer: 'an answer',
    sequence: seq,
    created_at: new Date(`2026-09-0${Math.min(seq, 9)}T00:00:00.000Z`),
    ...partial,
  } as Row;
}

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
});

describe('summarizeRiskCheckSteps', () => {
  it('resolves to the HIGHEST band reached, not the last one logged', () => {
    // A ladder that peaks at high and then records protective factors as
    // "low" must not read as a low-risk assessment.
    const ladder = summarizeRiskCheckSteps('s1', [
      step({ step: 'ideation', risk_band: 'moderate' }),
      step({ step: 'plan', risk_band: 'high' }),
      step({ step: 'protective_factors', risk_band: 'low' }),
    ]);
    expect(ladder.resolved_band).toBe('high');
  });

  it('tracks the deepest CORE rung; protective_factors is not a rung', () => {
    const ladder = summarizeRiskCheckSteps('s1', [
      step({ step: 'ideation', risk_band: 'moderate' }),
      step({ step: 'protective_factors', risk_band: 'low' }),
    ]);
    expect(ladder.furthest_step).toBe('ideation');
    expect(ladder.completed).toBe(false);
  });

  it('is complete only once intent is logged', () => {
    const steps = [
      step({ step: 'ideation', risk_band: 'high' }),
      step({ step: 'plan', risk_band: 'high' }),
      step({ step: 'means', risk_band: 'high' }),
      step({ step: 'timeframe', risk_band: 'high' }),
    ];
    expect(summarizeRiskCheckSteps('s1', steps).completed).toBe(false);
    steps.push(step({ step: 'intent', risk_band: 'imminent' }));
    const done = summarizeRiskCheckSteps('s1', steps);
    expect(done.completed).toBe(true);
    expect(done.furthest_step).toBe('intent');
    expect(done.resolved_band).toBe('imminent');
  });

  it('handles an empty ladder without inventing a band', () => {
    const ladder = summarizeRiskCheckSteps('s1', []);
    expect(ladder).toMatchObject({
      session_id: 's1', resolved_band: null, furthest_step: null,
      completed: false, started_at: null, last_step_at: null,
    });
  });

  it('normalizes timestamps to ISO strings for the JSON surface', () => {
    const ladder = summarizeRiskCheckSteps('s1', [step({ step: 'ideation', risk_band: 'low' })]);
    expect(ladder.started_at).toBe('2026-09-01T00:00:00.000Z');
    expect(ladder.last_step_at).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('sessionHasRiskCheck', () => {
  it('is false when the session has logged nothing', async () => {
    poolQueryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await sessionHasRiskCheck('s1')).toBe(false);
  });

  it('is true on any row, and stays LIMIT 1 (it runs per risky turn)', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 });
    expect(await sessionHasRiskCheck('s1')).toBe(true);
    expect(String(poolQueryMock.mock.calls[0][0])).toContain('LIMIT 1');
  });
});

describe('getSessionRiskCheckLadder', () => {
  it('returns the folded ladder for one session', async () => {
    poolQueryMock.mockResolvedValue({
      rows: [step({ step: 'ideation', risk_band: 'moderate' })],
      rowCount: 1,
    });
    const ladder = await getSessionRiskCheckLadder('s1');
    expect(ladder.session_id).toBe('s1');
    expect(ladder.resolved_band).toBe('moderate');
  });
});

describe('getParticipantRiskCheckLadders', () => {
  it('groups by session, orders newest-last-step first, and scopes by user in SQL', async () => {
    poolQueryMock.mockResolvedValue({
      rows: [
        { ...step({ step: 'ideation', risk_band: 'low' }), session_id: 'old' },
        { ...step({ step: 'ideation', risk_band: 'high' }), session_id: 'new' },
      ],
      rowCount: 2,
    });
    const ladders = await getParticipantRiskCheckLadders(7);
    expect(ladders.map(l => l.session_id)).toEqual(['new', 'old']);
    expect(ladders[0].resolved_band).toBe('high');
    // Ownership enforced by the join, not by a caller-supplied session list.
    const sql = String(poolQueryMock.mock.calls[0][0]);
    expect(sql).toContain('JOIN therapy_sessions');
    expect(sql).toContain('ts.user_id = $1');
    expect(poolQueryMock.mock.calls[0][1]).toEqual([7]);
  });

  it('honours the limit', async () => {
    poolQueryMock.mockResolvedValue({
      rows: [
        { ...step({ step: 'ideation', risk_band: 'low' }), session_id: 'a' },
        { ...step({ step: 'ideation', risk_band: 'low' }), session_id: 'b' },
      ],
      rowCount: 2,
    });
    expect(await getParticipantRiskCheckLadders(7, 1)).toHaveLength(1);
  });
});
