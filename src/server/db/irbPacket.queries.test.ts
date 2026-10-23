// IRB packet queries (ai-therapist-107): window/org params reach every SQL,
// count strings become numbers, and empty result sets give zeroed shapes.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({ pool: { query: queryMock, connect: vi.fn(), on: vi.fn() } }));

import {
  getIrbEnrollmentCounts,
  getIrbArmCounts,
  getIrbSessionCounts,
  getIrbSafetyCounts,
  getIrbAdverseEvents,
  getIrbDeviations,
  getIrbConsentVersions,
  getIrbMonitoringCounts,
  getIrbDataAccessCounts,
  type IrbWindow,
} from './irbPacket.queries.js';

const W: IrbWindow = {
  from: '2025-10-01T00:00:00.000Z',
  to: '2026-09-30T23:59:59.999Z',
  orgId: 1,
  includeUnattributed: true,
};

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [] });
});

function calls(): { sql: string; params: unknown[] }[] {
  return queryMock.mock.calls.map(([sql, params]) => ({ sql: String(sql), params: params as unknown[] }));
}

describe('window + scope params', () => {
  it('every session-scoped query binds from, to, orgId, includeUnattributed and excludes demo + sandbox', async () => {
    await getIrbEnrollmentCounts(W, 4);
    await getIrbArmCounts(W);
    await getIrbSessionCounts(W);
    await getIrbSafetyCounts(W);
    const scoped = calls().filter((c) => c.sql.includes('therapy_sessions ts'));
    expect(scoped.length).toBeGreaterThanOrEqual(8);
    for (const c of scoped) {
      expect(c.params.slice(0, 4)).toEqual([W.from, W.to, 1, true]);
      expect(c.sql).toContain('ts.is_demo IS NOT TRUE');
      expect(c.sql).toContain('su.is_sandbox IS TRUE');
      expect(c.sql).toContain('ou.organization_id = $3::int');
    }
    expect(calls()[0].params[4]).toBe(4); // expected sessions for "completed"
  });

  it('adverse events use the register scope clause (org or unattributed-for-IRB-org) and the occurred_at window', async () => {
    await getIrbAdverseEvents(W);
    const [c] = calls();
    expect(c.sql).toContain('occurred_at >= $1::timestamptz AND occurred_at <= $2::timestamptz');
    expect(c.sql).toContain("slug = 'irb-study'");
    expect(c.params).toEqual([W.from, W.to, 1]);
    for (const col of [
      'participant_ref',
      'user_id',
      'session_id',
      'transcript_excerpt',
      'created_by',
      'submitted_by',
      'closed_by',
    ]) {
      expect(c.sql.split('FROM')[0]).not.toContain(col);
    }
  });

  it('deviations and drift alerts are study-global (window only); harness excludes dry runs', async () => {
    await getIrbDeviations(W);
    await getIrbMonitoringCounts(W);
    const [dev, drift, harness] = calls();
    expect(dev.params).toEqual([W.from, W.to]);
    expect(drift.params).toEqual([W.from, W.to]);
    expect(harness.params).toEqual([W.from, W.to]);
    expect(harness.sql).toContain('dry_run IS NOT TRUE');
  });

  it('data access is scoped by actor OR participant org, like the Data Access view', async () => {
    await getIrbDataAccessCounts(W);
    const [c] = calls();
    expect(c.params).toEqual([W.from, W.to, 1]);
    expect(c.sql).toContain('actor.organization_id = $3::int OR participant.organization_id = $3::int');
  });

  it('consent versions in force: effective by `to`, not superseded before `from`', async () => {
    await getIrbConsentVersions({ ...W, includeUnattributed: false });
    const [c] = calls();
    expect(c.params).toEqual([W.from, W.to, 1, false]);
    expect(c.sql).toContain('d.effective_at <= $2::timestamptz');
    expect(c.sql).toContain('d.superseded_at IS NULL OR d.superseded_at >= $1::timestamptz');
  });
});

describe('result shaping', () => {
  it('zeroes every count on empty rows', async () => {
    expect(await getIrbEnrollmentCounts(W, 4)).toEqual({
      enrolled_in_window: 0,
      enrolled_to_date: 0,
      active: 0,
      paused: 0,
      withdrawn: 0,
      completed: 0,
      withdrawn_in_window: 0,
      paused_in_window: 0,
      anonymous_sessions_in_window: 0,
    });
    expect(await getIrbSessionCounts(W)).toEqual({
      total: 0,
      ended: 0,
      mean_duration_minutes: null,
      by_session_type: [],
      by_modality: [],
    });
    const safety = await getIrbSafetyCounts(W);
    expect(safety.flagged_sessions).toEqual({
      total: 0,
      unflagged_before_end: 0,
      still_flagged_at_end: 0,
      with_adverse_event_report: 0,
    });
    expect(safety.pages_sent).toBe(0);
    const mon = await getIrbMonitoringCounts(W);
    expect(mon.drift_alerts).toEqual({
      opened_in_window: 0,
      acknowledged_in_window: 0,
      open_at_end: 0,
      paged_in_window: 0,
    });
    expect(mon.harness_runs).toEqual([]);
  });

  it('parses pg count strings and derives pages_sent + harness pass rate', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM crisis_events')) return { rows: [{ event_type: 'flagged', severity: 'high', n: '3' }] };
      if (sql.includes('crisis_flagged_at >= $1'))
        return {
          rows: [{ total: '3', unflagged_before_end: '2', still_flagged_at_end: '1', with_adverse_event_report: '1' }],
        };
      if (sql.includes('FROM intervention_actions'))
        return {
          rows: [
            { action_type: 'crisis_sms_alert', n: '2' },
            { action_type: 'auto_flag', n: '3' },
          ],
        };
      if (sql.includes('FROM escalations')) return { rows: [{ status: 'open', urgency: 'urgent', n: '1' }] };
      if (sql.includes('FROM harness_runs'))
        return {
          rows: [
            { suite: 'voice', runs: '4', scenarios: '40', passed: '30', last_run_at: new Date('2026-09-01T00:00:00Z') },
          ],
        };
      if (sql.includes('FROM eval_drift_alerts'))
        return {
          rows: [{ opened_in_window: '2', acknowledged_in_window: '1', open_at_end: '1', paged_in_window: '0' }],
        };
      if (sql.includes('AVG(EXTRACT')) return { rows: [{ total: '10', ended: '8', mean_minutes: '23.456' }] };
      return { rows: [] };
    });
    const safety = await getIrbSafetyCounts(W);
    expect(safety.crisis_events).toEqual([{ event_type: 'flagged', severity: 'high', n: 3 }]);
    expect(safety.flagged_sessions.unflagged_before_end).toBe(2);
    expect(safety.pages_sent).toBe(2);
    expect(safety.escalations).toEqual([{ status: 'open', urgency: 'urgent', n: 1 }]);
    const mon = await getIrbMonitoringCounts(W);
    expect(mon.harness_runs[0]).toMatchObject({ suite: 'voice', runs: 4, scenarios: 40, passed: 30, pass_rate: 0.75 });
    expect(mon.drift_alerts.opened_in_window).toBe(2);
    const sessions = await getIrbSessionCounts(W);
    expect(sessions).toMatchObject({ total: 10, ended: 8, mean_duration_minutes: 23.5 });
  });

  it('labels null arm/modality values instead of dropping them', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("'proactive_offering' AS dimension"))
        return { rows: [{ dimension: 'proactive_offering', value: 'unassigned', sessions: '5', participants: '0' }] };
      if (sql.includes('sc.modality AS value')) return { rows: [{ value: null, n: '2' }] };
      return { rows: [] };
    });
    expect(await getIrbArmCounts(W)).toEqual([
      { dimension: 'proactive_offering', value: 'unassigned', sessions: 5, participants: 0 },
    ]);
    expect((await getIrbSessionCounts(W)).by_modality).toEqual([{ value: 'unknown', n: 2 }]);
  });
});
