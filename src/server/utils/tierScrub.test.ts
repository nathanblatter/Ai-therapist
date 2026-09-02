// Summary-tier allowlist projections (ai-therapist-146). These tests pin two
// things: (1) the projection mechanics (unknown fields NEVER pass through —
// the whole point of moving off deny-lists), and (2) that no verbatim-bearing
// column is ever present in a summary allowlist.
import { describe, it, expect } from 'vitest';
import {
  projectRow,
  projectRows,
  CRISIS_EVENT_SUMMARY_FIELDS,
  RISK_HISTORY_SUMMARY_FIELDS,
  INTERVENTION_SUMMARY_FIELDS,
  FLAGGED_EVENT_SUMMARY_FIELDS,
  SESSION_INSIGHTS_SUMMARY_FIELDS,
} from './tierScrub.js';

describe('projectRow / projectRows', () => {
  it('keeps only allowlisted fields and leaves absent fields absent (not null)', () => {
    const row = { a: 1, b: 'keep', secret: 'nope' };
    const out = projectRow(row, ['a', 'b', 'missing']);
    expect(out).toEqual({ a: 1, b: 'keep' });
    expect('secret' in out).toBe(false);
    expect('missing' in out).toBe(false); // client "render if present" contract
  });

  it('a NEW column added to a source query does not reach summary tier', () => {
    // the regression class that motivated the rewrite (ai-therapist-143):
    // simulate a future migration adding a verbatim-bearing column
    const rows = [{ event_id: 1, severity: 'high', future_verbatim_col: 'the user said ...' }];
    const out = projectRows(rows, CRISIS_EVENT_SUMMARY_FIELDS);
    expect(out[0]).toEqual({ event_id: 1, severity: 'high' });
  });

  it('does not mutate the input rows', () => {
    const row = { event_id: 1, notes: 'verbatim' };
    projectRows([row], CRISIS_EVENT_SUMMARY_FIELDS);
    expect(row.notes).toBe('verbatim');
  });
});

describe('summary allowlists never contain verbatim-bearing columns', () => {
  const VERBATIM_COLUMNS = [
    // crisis_events / intervention_actions / risk_score_history
    'risk_factors', 'intervention_details', 'notes', 'action_details', 'score_factors',
    // session_insights clinical documentation
    'soap_note', 'soap_status', 'soap_reviewed_by', 'soap_reviewed_at',
    'notes_for_next_session', 'notes_author', 'notes_created_at',
    // raw content columns, should any join ever drag them in
    'content', 'content_redacted', 'transcript_excerpt',
  ];

  for (const [name, allow] of [
    ['CRISIS_EVENT_SUMMARY_FIELDS', CRISIS_EVENT_SUMMARY_FIELDS],
    ['RISK_HISTORY_SUMMARY_FIELDS', RISK_HISTORY_SUMMARY_FIELDS],
    ['INTERVENTION_SUMMARY_FIELDS', INTERVENTION_SUMMARY_FIELDS],
    ['FLAGGED_EVENT_SUMMARY_FIELDS', FLAGGED_EVENT_SUMMARY_FIELDS],
    ['SESSION_INSIGHTS_SUMMARY_FIELDS', SESSION_INSIGHTS_SUMMARY_FIELDS],
  ] as const) {
    it(`${name} is verbatim-free`, () => {
      for (const col of VERBATIM_COLUMNS) {
        expect(allow, `${name} must not contain ${col}`).not.toContain(col);
      }
    });
  }

  it('the summary-tier insights allowlist DOES carry the derived affect curve (ai-therapist-86)', () => {
    expect(SESSION_INSIGHTS_SUMMARY_FIELDS).toContain('affect_curve');
    expect(SESSION_INSIGHTS_SUMMARY_FIELDS).toContain('summary');
    expect(SESSION_INSIGHTS_SUMMARY_FIELDS).toContain('safety_plan');
  });
});
