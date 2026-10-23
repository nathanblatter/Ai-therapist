// Unit tests for the chart bundle shaping helpers (ai-therapist-199 item 3):
// the scope rule on verbatim columns, chronological interleave of events and
// interventions, SOAP-free summary rows, CSV header order and the README.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/index.js', () => ({}));

import {
  chartScopeFor,
  rowsToCsv,
  notesRows,
  NOTES_HEADERS,
  screenerRows,
  sessionSummaryRows,
  SESSION_SUMMARY_HEADERS,
  crisisHistoryRows,
  CRISIS_HISTORY_HEADERS,
  assignmentRows,
  escalationRows,
  buildChartReadme,
  chartZipFilename,
} from './clientChart.service.js';
import type { CareNoteRow } from '../db/careNotes.queries.js';
import type {
  ClientCrisisEventRow,
  ClientInterventionRow,
  ClientSessionSummaryRow,
} from '../db/clientChart.queries.js';

const note: CareNoteRow = {
  note_id: 1,
  org_id: 5,
  client_id: 42,
  author_id: 9,
  author_name: 'Dr T',
  author_role: 'therapist',
  note_type: 'progress',
  case_note_kind: null,
  session_id: 's1',
  seed_source: 'ai_soap',
  seed_model: 'm',
  content: { subjective: 'said "hi"' },
  status: 'amended',
  shared_with_care_team: true,
  signed_at: '2026-10-20 10:00:00+00',
  sign_hash: 'h1',
  amends_note_id: null,
  created_at: '2026-10-20 09:00:00+00',
  updated_at: '2026-10-20 10:00:00+00',
};

const event: ClientCrisisEventRow = {
  event_id: 11,
  session_id: 's1',
  origin: 'session',
  event_type: 'flagged',
  severity: 'high',
  previous_severity: 'medium',
  risk_score: 80,
  previous_risk_score: 55,
  triggered_by: 'system',
  trigger_method: 'auto',
  risk_factors: ['a', 'b'],
  notes: 'quoted text',
  created_at: new Date('2026-10-20T09:30:00Z'),
};
const intervention: ClientInterventionRow = {
  action_id: 21,
  session_id: 's1',
  action_type: 'high_risk_emergency',
  risk_score: 80,
  performed_by: 'system',
  performed_at: new Date('2026-10-20T09:20:00Z'),
  outcome: 'resources shown',
  notes: 'more quoted text',
};

describe('chartScopeFor', () => {
  it('therapist is full, researcher is summary', () => {
    expect(chartScopeFor('therapist')).toBe('full');
    expect(chartScopeFor('researcher')).toBe('summary');
  });
});

describe('notesRows', () => {
  it('keeps the ledger (signer, signed_at, hash) at both scopes and content only at full scope', () => {
    const full = notesRows([note], 'full')[0];
    const summary = notesRows([note], 'summary')[0];
    expect(full.sign_hash).toBe('h1');
    expect(full.signed_at).toBe('2026-10-20T10:00:00.000Z');
    expect(full.author_name).toBe('Dr T');
    expect(full.status).toBe('amended');
    expect(full.content).toEqual({ subjective: 'said "hi"' });
    expect(summary.sign_hash).toBe('h1');
    expect(summary.content).toBeNull();
  });

  it('serialises note content as a JSON cell', () => {
    const csv = rowsToCsv(NOTES_HEADERS, notesRows([note], 'full'));
    expect(csv.split('\n')[0]).toBe(NOTES_HEADERS.join(','));
    expect(csv).toContain('"{""subjective"":""said \\""hi\\""""}"');
  });
});

describe('screenerRows', () => {
  it('maps scale responses with ISO timestamps', () => {
    const rows = screenerRows([
      { session_id: 's1', scale: 'gad2', score: 4, answers: [2, 2], created_at: new Date('2026-10-20T09:00:00Z') },
    ]);
    expect(rows).toEqual([
      { session_id: 's1', scale: 'gad2', score: 4, answers: [2, 2], created_at: '2026-10-20T09:00:00.000Z' },
    ]);
  });
});

describe('sessionSummaryRows', () => {
  const session: ClientSessionSummaryRow = {
    session_id: 's1',
    session_name: 'Mon',
    session_type: 'chat',
    modality: 'act',
    started_at: new Date('2026-10-20T09:00:00Z'),
    ended_at: new Date('2026-10-20T09:30:00Z'),
    duration_minutes: 30,
    crisis_flagged: false,
    crisis_severity: null,
    summary: { headline: 'H', topics: ['t1', 't2'], techniques_helped: ['breathing'], follow_up: 'F', safety: '' },
  };

  it('flattens summary fields, joins lists, and defaults the risk band to none', () => {
    const [row] = sessionSummaryRows([session]);
    expect(row).toMatchObject({
      session_id: 's1',
      modality: 'act',
      session_type: 'chat',
      duration_minutes: 30,
      risk_band: 'none',
      crisis_flagged: false,
      headline: 'H',
      topics: 't1; t2',
      techniques_discussed: null,
      techniques_helped: 'breathing',
      follow_up: 'F',
      safety: '',
    });
    expect(Object.keys(row)).toEqual(SESSION_SUMMARY_HEADERS);
    expect(SESSION_SUMMARY_HEADERS.some((h) => /soap|subjective|objective|assessment|plan/.test(h))).toBe(false);
  });

  it('tolerates a session without a summary row', () => {
    const [row] = sessionSummaryRows([{ ...session, summary: null, crisis_severity: 'low', crisis_flagged: true }]);
    expect(row.headline).toBeNull();
    expect(row.risk_band).toBe('low');
    expect(row.crisis_flagged).toBe(true);
  });
});

describe('crisisHistoryRows', () => {
  it('interleaves events and interventions chronologically', () => {
    const rows = crisisHistoryRows([event], [intervention], 'full');
    expect(rows.map((r) => `${r.kind}:${r.id}`)).toEqual(['intervention:21', 'event:11']);
    expect(Object.keys(rows[0])).toEqual(CRISIS_HISTORY_HEADERS);
    expect(rows[1]).toMatchObject({
      severity: 'high',
      previous_severity: 'medium',
      risk_factors: 'a; b',
      actor: 'system',
    });
  });

  it('keeps free text only at full scope', () => {
    const full = crisisHistoryRows([event], [intervention], 'full');
    expect(full.find((r) => r.kind === 'event')?.notes).toBe('quoted text');
    expect(full.find((r) => r.kind === 'intervention')).toMatchObject({
      outcome: 'resources shown',
      notes: 'more quoted text',
    });

    const summary = crisisHistoryRows([event], [intervention], 'summary');
    for (const row of summary) {
      expect(row.notes).toBeNull();
      expect(row.outcome).toBeNull();
    }
    // Structured signal survives.
    expect(summary.find((r) => r.kind === 'event')).toMatchObject({
      type: 'flagged',
      severity: 'high',
      risk_score: 80,
    });
  });
});

describe('assignmentRows / escalationRows', () => {
  it('uses usernames for authored_by and cancelled_by', () => {
    const [row] = assignmentRows([
      {
        id: 7,
        user_id: 42,
        session_id: null,
        title: 'T',
        description: 'D',
        kind: 'worksheet',
        suggested_frequency: null,
        status: 'cancelled',
        assigned_at: new Date('2026-10-20T00:00:00Z'),
        completed_at: null,
        completion_note: null,
        source: 'therapist',
        authored_by: 9,
        cancelled_at: new Date('2026-10-21T00:00:00Z'),
        cancelled_by: 9,
        cancel_reason: 'superseded',
        reissued_from: null,
        authored_by_username: 'dr',
        cancelled_by_username: 'dr',
      },
    ]);
    expect(row).toMatchObject({
      authored_by: 'dr',
      cancelled_by: 'dr',
      cancel_reason: 'superseded',
      assigned_at: '2026-10-20T00:00:00.000Z',
    });
  });

  it('maps an escalation with its assignee username', () => {
    const [row] = escalationRows([
      {
        escalation_id: 3,
        org_id: 5,
        client_id: 42,
        raised_by: 9,
        raised_by_role: 'therapist',
        assigned_to: 4,
        reason: 'R',
        urgency: 'urgent',
        crisis_event_id: 11,
        session_id: 's1',
        note_id: null,
        status: 'acknowledged',
        acknowledged_by: 4,
        acknowledged_at: '2026-10-21T01:00:00Z',
        resolved_by: null,
        resolved_at: null,
        resolution_note: null,
        created_at: '2026-10-21T00:00:00Z',
        updated_at: '2026-10-21T01:00:00Z',
        client_username: 'p42',
        assigned_username: 'cw4',
      },
    ]);
    expect(row).toMatchObject({
      escalation_id: 3,
      assigned_to: 'cw4',
      urgency: 'urgent',
      crisis_event_id: 11,
      acknowledged_at: '2026-10-21T01:00:00.000Z',
    });
  });
});

describe('buildChartReadme / chartZipFilename', () => {
  it('names the client reference, exporter, time, scope, files and the audit note', () => {
    const text = buildChartReadme({
      client: { userid: 42, username: 'p42' },
      exporter: { userId: 9, username: 'dr', role: 'researcher' },
      generatedAt: '2026-10-22T12:00:00.000Z',
      scope: 'summary',
      files: [
        { name: 'notes.csv', rows: 2 },
        { name: 'README.txt', rows: null },
      ],
      omitted: ['safety_plan.json'],
    });
    expect(text).toContain('Client reference: p42 (id 42)');
    expect(text).toContain('Exported by: dr (id 9, role researcher)');
    expect(text).toContain('Generated at: 2026-10-22T12:00:00.000Z');
    expect(text).toContain('Scope: summary');
    expect(text).toContain('  notes.csv (2 rows)');
    expect(text).toContain('  README.txt\n');
    expect(text).toContain('Not included at this scope:\n  safety_plan.json');
    expect(text).toContain('data access log');
  });

  it('makes the filename path-safe', () => {
    expect(chartZipFilename({ userid: 42, username: 'p 42/../x' }, '2026-10-22T12:00:00.000Z')).toBe(
      'client-p_42_.._x-chart-2026-10-22.zip',
    );
    expect(chartZipFilename({ userid: 42, username: '///' }, '2026-10-22T12:00:00.000Z')).toBe(
      'client-_-chart-2026-10-22.zip',
    );
  });
});
