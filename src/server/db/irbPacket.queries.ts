// Data-access for the IRB continuing-review packet (ai-therapist-107). Every
// query here is COUNTS over an explicit [from, to] window, scoped to one
// organization, with demo + sandbox traffic excluded. The two record-level
// reads (adverse events, protocol deviations) return rows the IRB inherently
// needs as records, projected WITHOUT participant identifiers or verbatim
// excerpts. Composition + rendering live in services/irbPacket.service.ts.
//
// Organization scope (matches the adverse-event register, ai-therapist-228):
// a participant's data is in scope when users.organization_id = orgId; rows
// with no participant (anonymous sessions, unattributed reports) are in scope
// only for the irb-study org (`includeUnattributed`).
import { pool } from '../config/db.js';
import { adverseEventScopeClause } from './adverseEvents.queries.js';

export interface IrbWindow {
  /** Inclusive ISO lower bound. */
  from: string;
  /** Inclusive ISO upper bound. */
  to: string;
  orgId: number;
  /** True when orgId is the irb-study org: rows without a participant count. */
  includeUnattributed: boolean;
}

// $1 = from, $2 = to, $3 = orgId, $4 = includeUnattributed. Shared by every
// therapy_sessions-based query; `ts` is the therapy_sessions alias. Exported
// (with SESSION_IN_WINDOW and irbWindowParams) so the weekly digest
// (weeklyDigest.queries.ts) applies the identical scope rule instead of
// re-deriving it.
export const SESSION_SCOPE = `ts.is_demo IS NOT TRUE
  AND (ts.user_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM users su WHERE su.userid = ts.user_id AND su.is_sandbox IS TRUE))
  AND ((ts.user_id IS NULL AND $4::boolean)
       OR EXISTS (SELECT 1 FROM users ou WHERE ou.userid = ts.user_id AND ou.organization_id = $3::int))`;

export const SESSION_IN_WINDOW = `ts.created_at >= $1::timestamptz AND ts.created_at <= $2::timestamptz`;

export function irbWindowParams(w: IrbWindow): unknown[] {
  return [w.from, w.to, w.orgId, w.includeUnattributed];
}
const params = irbWindowParams;

const n = (v: string | number | null | undefined): number => {
  const x = typeof v === 'number' ? v : parseInt(v ?? '0', 10);
  return Number.isFinite(x) ? x : 0;
};

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

export interface IrbEnrollmentCounts {
  /** Participants whose FIRST in-scope session falls inside the window. */
  enrolled_in_window: number;
  /** Participants with >= 1 in-scope session on or before `to` (cumulative). */
  enrolled_to_date: number;
  /** Study status of the cumulative cohort (users.study_status). */
  active: number;
  paused: number;
  withdrawn: number;
  /** Cumulative participants with >= expected_sessions in-scope sessions. */
  completed: number;
  /** Status changes stamped inside the window (withdrawal survey / admin). */
  withdrawn_in_window: number;
  paused_in_window: number;
  anonymous_sessions_in_window: number;
}

export async function getIrbEnrollmentCounts(w: IrbWindow, expectedSessions: number): Promise<IrbEnrollmentCounts> {
  const r = await pool.query<Record<string, string>>(
    `WITH cohort AS (
       SELECT ts.user_id, MIN(ts.created_at) AS first_at, COUNT(*) AS n_sessions
         FROM therapy_sessions ts
        WHERE ${SESSION_SCOPE} AND ts.user_id IS NOT NULL AND ts.created_at <= $2::timestamptz
        GROUP BY ts.user_id
     )
     SELECT COUNT(*) FILTER (WHERE c.first_at >= $1::timestamptz) AS enrolled_in_window,
            COUNT(*) AS enrolled_to_date,
            COUNT(*) FILTER (WHERE COALESCE(u.study_status, 'active') = 'active') AS active,
            COUNT(*) FILTER (WHERE u.study_status = 'paused') AS paused,
            COUNT(*) FILTER (WHERE u.study_status = 'withdrawn') AS withdrawn,
            COUNT(*) FILTER (WHERE c.n_sessions >= $5::int) AS completed,
            COUNT(*) FILTER (WHERE u.study_status = 'withdrawn'
                               AND u.study_status_changed_at >= $1::timestamptz
                               AND u.study_status_changed_at <= $2::timestamptz) AS withdrawn_in_window,
            COUNT(*) FILTER (WHERE u.study_status = 'paused'
                               AND u.study_status_changed_at >= $1::timestamptz
                               AND u.study_status_changed_at <= $2::timestamptz) AS paused_in_window,
            (SELECT COUNT(*) FROM therapy_sessions ts
              WHERE ${SESSION_SCOPE} AND ts.user_id IS NULL AND ${SESSION_IN_WINDOW}) AS anonymous_sessions_in_window
       FROM cohort c JOIN users u ON u.userid = c.user_id`,
    [...params(w), expectedSessions],
  );
  const row = r.rows[0] ?? {};
  return {
    enrolled_in_window: n(row.enrolled_in_window),
    enrolled_to_date: n(row.enrolled_to_date),
    active: n(row.active),
    paused: n(row.paused),
    withdrawn: n(row.withdrawn),
    completed: n(row.completed),
    withdrawn_in_window: n(row.withdrawn_in_window),
    paused_in_window: n(row.paused_in_window),
    anonymous_sessions_in_window: n(row.anonymous_sessions_in_window),
  };
}

export interface IrbArmCount {
  dimension: 'proactive_offering' | 'ai_model';
  value: string;
  sessions: number;
  participants: number;
}

/** In-window sessions (and distinct participants) per arm value. */
export async function getIrbArmCounts(w: IrbWindow): Promise<IrbArmCount[]> {
  const r = await pool.query<{ dimension: IrbArmCount['dimension']; value: string; sessions: string; participants: string }>(
    `SELECT dimension, value, COUNT(*) AS sessions,
            COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) AS participants
       FROM (
         SELECT 'proactive_offering' AS dimension,
                CASE WHEN sc.proactive_offering IS TRUE THEN 'true'
                     WHEN sc.proactive_offering IS FALSE THEN 'false' ELSE 'unassigned' END AS value,
                ts.user_id
           FROM therapy_sessions ts JOIN session_configurations sc ON sc.session_id = ts.session_id
          WHERE ${SESSION_SCOPE} AND ${SESSION_IN_WINDOW}
         UNION ALL
         SELECT 'ai_model', sc.ai_model, ts.user_id
           FROM therapy_sessions ts JOIN session_configurations sc ON sc.session_id = ts.session_id
          WHERE ${SESSION_SCOPE} AND ${SESSION_IN_WINDOW} AND sc.ai_model IS NOT NULL
       ) d
      GROUP BY dimension, value ORDER BY dimension, value`,
    params(w),
  );
  return r.rows.map(x => ({ dimension: x.dimension, value: x.value, sessions: n(x.sessions), participants: n(x.participants) }));
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface IrbSessionCounts {
  total: number;
  ended: number;
  /** Mean (ended_at - created_at) in minutes over ended sessions; null if none. */
  mean_duration_minutes: number | null;
  by_session_type: { value: string; n: number }[];
  by_modality: { value: string; n: number }[];
}

export async function getIrbSessionCounts(w: IrbWindow): Promise<IrbSessionCounts> {
  const [totals, types, modalities] = await Promise.all([
    pool.query<{ total: string; ended: string; mean_minutes: string | null }>(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE ts.ended_at IS NOT NULL) AS ended,
              AVG(EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at)) / 60.0)
                FILTER (WHERE ts.ended_at IS NOT NULL AND ts.ended_at > ts.created_at) AS mean_minutes
         FROM therapy_sessions ts
        WHERE ${SESSION_SCOPE} AND ${SESSION_IN_WINDOW}`,
      params(w),
    ),
    pool.query<{ value: string | null; n: string }>(
      `SELECT ts.session_type AS value, COUNT(*) AS n FROM therapy_sessions ts
        WHERE ${SESSION_SCOPE} AND ${SESSION_IN_WINDOW}
        GROUP BY 1 ORDER BY 1`,
      params(w),
    ),
    pool.query<{ value: string | null; n: string }>(
      `SELECT sc.modality AS value, COUNT(*) AS n
         FROM therapy_sessions ts JOIN session_configurations sc ON sc.session_id = ts.session_id
        WHERE ${SESSION_SCOPE} AND ${SESSION_IN_WINDOW}
        GROUP BY 1 ORDER BY 1`,
      params(w),
    ),
  ]);
  const t = totals.rows[0];
  const mean = t?.mean_minutes == null ? null : Number(t.mean_minutes);
  return {
    total: n(t?.total),
    ended: n(t?.ended),
    mean_duration_minutes: mean != null && Number.isFinite(mean) ? Math.round(mean * 10) / 10 : null,
    by_session_type: types.rows.map(x => ({ value: x.value ?? 'unknown', n: n(x.n) })),
    by_modality: modalities.rows.map(x => ({ value: x.value ?? 'unknown', n: n(x.n) })),
  };
}

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

export interface IrbSafetyCounts {
  /** crisis_events rows in window by event_type x severity. */
  crisis_events: { event_type: string; severity: string; n: number }[];
  /** Sessions flagged in window and how they ended up. */
  flagged_sessions: {
    total: number;
    unflagged_before_end: number;
    still_flagged_at_end: number;
    with_adverse_event_report: number;
  };
  interventions: { action_type: string; n: number }[];
  /** On-call pages: intervention_actions.action_type = 'crisis_sms_alert'. */
  pages_sent: number;
  escalations: { status: string; urgency: string; n: number }[];
}

export async function getIrbSafetyCounts(w: IrbWindow): Promise<IrbSafetyCounts> {
  const [events, flagged, actions, escalations] = await Promise.all([
    pool.query<{ event_type: string; severity: string | null; n: string }>(
      `SELECT ce.event_type, ce.severity, COUNT(*) AS n
         FROM crisis_events ce JOIN therapy_sessions ts ON ts.session_id = ce.session_id
        WHERE ${SESSION_SCOPE}
          AND ce.created_at >= $1::timestamptz AND ce.created_at <= $2::timestamptz
        GROUP BY 1, 2 ORDER BY 1, 2`,
      params(w),
    ),
    pool.query<Record<string, string>>(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE ts.crisis_unflagged_at IS NOT NULL) AS unflagged_before_end,
              COUNT(*) FILTER (WHERE ts.crisis_unflagged_at IS NULL AND ts.crisis_flagged IS TRUE) AS still_flagged_at_end,
              COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM adverse_event_reports ae WHERE ae.session_id = ts.session_id)) AS with_adverse_event_report
         FROM therapy_sessions ts
        WHERE ${SESSION_SCOPE}
          AND ts.crisis_flagged_at >= $1::timestamptz AND ts.crisis_flagged_at <= $2::timestamptz`,
      params(w),
    ),
    pool.query<{ action_type: string; n: string }>(
      `SELECT ia.action_type, COUNT(*) AS n
         FROM intervention_actions ia JOIN therapy_sessions ts ON ts.session_id = ia.session_id
        WHERE ${SESSION_SCOPE}
          AND ia.performed_at >= $1::timestamptz AND ia.performed_at <= $2::timestamptz
        GROUP BY 1 ORDER BY 1`,
      params(w),
    ),
    pool.query<{ status: string; urgency: string; n: string }>(
      `SELECT e.status, e.urgency, COUNT(*) AS n
         FROM escalations e
        WHERE e.org_id = $3::int
          AND e.created_at >= $1::timestamptz AND e.created_at <= $2::timestamptz
        GROUP BY 1, 2 ORDER BY 1, 2`,
      [w.from, w.to, w.orgId],
    ),
  ]);
  const f = flagged.rows[0] ?? {};
  const interventions = actions.rows.map(x => ({ action_type: x.action_type, n: n(x.n) }));
  return {
    crisis_events: events.rows.map(x => ({ event_type: x.event_type, severity: x.severity ?? 'unknown', n: n(x.n) })),
    flagged_sessions: {
      total: n(f.total),
      unflagged_before_end: n(f.unflagged_before_end),
      still_flagged_at_end: n(f.still_flagged_at_end),
      with_adverse_event_report: n(f.with_adverse_event_report),
    },
    interventions,
    pages_sent: interventions.find(i => i.action_type === 'crisis_sms_alert')?.n ?? 0,
    escalations: escalations.rows.map(x => ({ status: x.status, urgency: x.urgency, n: n(x.n) })),
  };
}

// ---------------------------------------------------------------------------
// Adverse events (record-level, identifier-free projection)
// ---------------------------------------------------------------------------

export interface IrbAdverseEventRecord {
  report_id: number;
  occurred_at: Date;
  severity: string;
  category: string;
  trigger_source: string;
  status: string;
  summary: string;
  submitted_at: Date | null;
  closed_at: Date | null;
  /** Last entry of actions_taken, action name only (no actor). */
  last_action: string | null;
}

export async function getIrbAdverseEvents(w: IrbWindow): Promise<IrbAdverseEventRecord[]> {
  const scoped = adverseEventScopeClause({ orgId: w.orgId, careTeam: null }, 2);
  const r = await pool.query<IrbAdverseEventRecord>(
    `SELECT report_id, occurred_at, severity, category, trigger_source, status, summary,
            submitted_at, closed_at,
            (SELECT a->>'action' FROM jsonb_array_elements(COALESCE(actions_taken, '[]'::jsonb)) WITH ORDINALITY AS t(a, i)
              ORDER BY i DESC LIMIT 1) AS last_action
       FROM adverse_event_reports
      WHERE occurred_at >= $1::timestamptz AND occurred_at <= $2::timestamptz
        AND ${scoped.sql}
      ORDER BY occurred_at ASC, report_id ASC`,
    [w.from, w.to, ...scoped.params],
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// Protocol deviations (record-level; the table is study-global, not per org)
// ---------------------------------------------------------------------------

export interface IrbDeviationRecord {
  deviation_id: number;
  occurred_at: Date;
  source: string;
  category: string;
  severity: string;
  status: string;
  description: string;
  resolved_at: Date | null;
}

export async function getIrbDeviations(w: IrbWindow): Promise<IrbDeviationRecord[]> {
  const r = await pool.query<IrbDeviationRecord>(
    `SELECT deviation_id, occurred_at, source, category, severity, status, description, resolved_at
       FROM protocol_deviations
      WHERE occurred_at >= $1::timestamptz AND occurred_at <= $2::timestamptz
      ORDER BY occurred_at ASC, deviation_id ASC`,
    [w.from, w.to],
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

export interface IrbConsentVersion {
  version: string;
  audience: string;
  effective_at: Date;
  /** When the next version for the same audience took effect; null = still current. */
  superseded_at: Date | null;
  /** Acceptances of this version inside the window, by in-scope participants. */
  acceptances_in_window: number;
  /** Acceptances of this version at any time, by in-scope participants. */
  acceptances_total: number;
}

/** Consent versions in force at any point inside the window (per audience),
 *  i.e. effective on or before `to` and not superseded before `from`. */
export async function getIrbConsentVersions(w: IrbWindow): Promise<IrbConsentVersion[]> {
  const r = await pool.query<IrbConsentVersion & { acceptances_in_window: string; acceptances_total: string }>(
    `WITH docs AS (
       SELECT cd.version, COALESCE(cd.audience, 'research') AS audience, cd.effective_at,
              LEAD(cd.effective_at) OVER (PARTITION BY COALESCE(cd.audience, 'research') ORDER BY cd.effective_at, cd.document_id) AS superseded_at
         FROM consent_documents cd
     ),
     scoped_consents AS (
       SELECT pc.consent_version, pc.accepted_at
         FROM participant_consents pc
        WHERE (pc.user_id IS NULL AND $4::boolean)
           OR EXISTS (SELECT 1 FROM users u WHERE u.userid = pc.user_id
                        AND u.organization_id = $3::int AND u.is_sandbox IS NOT TRUE)
     )
     SELECT d.version, d.audience, d.effective_at, d.superseded_at,
            (SELECT COUNT(*) FROM scoped_consents sc WHERE sc.consent_version = d.version
               AND sc.accepted_at >= $1::timestamptz AND sc.accepted_at <= $2::timestamptz) AS acceptances_in_window,
            (SELECT COUNT(*) FROM scoped_consents sc WHERE sc.consent_version = d.version) AS acceptances_total
       FROM docs d
      WHERE d.effective_at <= $2::timestamptz
        AND (d.superseded_at IS NULL OR d.superseded_at >= $1::timestamptz)
      ORDER BY d.audience, d.effective_at`,
    params(w),
  );
  return r.rows.map(x => ({
    version: x.version,
    audience: x.audience,
    effective_at: x.effective_at,
    superseded_at: x.superseded_at,
    acceptances_in_window: n(x.acceptances_in_window),
    acceptances_total: n(x.acceptances_total),
  }));
}

// ---------------------------------------------------------------------------
// Monitoring (study-global: eval drift + red-team harness)
// ---------------------------------------------------------------------------

export interface IrbMonitoringCounts {
  drift_alerts: {
    opened_in_window: number;
    acknowledged_in_window: number;
    /** Alerts created on or before `to` with no acknowledgement by `to`. */
    open_at_end: number;
    paged_in_window: number;
  };
  harness_runs: {
    suite: string;
    runs: number;
    scenarios: number;
    passed: number;
    /** passed / scenarios, 0..1; null when no scenarios. */
    pass_rate: number | null;
    last_run_at: Date | null;
  }[];
}

export async function getIrbMonitoringCounts(w: IrbWindow): Promise<IrbMonitoringCounts> {
  const [drift, harness] = await Promise.all([
    pool.query<Record<string, string>>(
      `SELECT COUNT(*) FILTER (WHERE created_at >= $1::timestamptz AND created_at <= $2::timestamptz) AS opened_in_window,
              COUNT(*) FILTER (WHERE acknowledged_at >= $1::timestamptz AND acknowledged_at <= $2::timestamptz) AS acknowledged_in_window,
              COUNT(*) FILTER (WHERE created_at <= $2::timestamptz
                                 AND (acknowledged_at IS NULL OR acknowledged_at > $2::timestamptz)) AS open_at_end,
              COUNT(*) FILTER (WHERE paged IS TRUE AND created_at >= $1::timestamptz AND created_at <= $2::timestamptz) AS paged_in_window
         FROM eval_drift_alerts`,
      [w.from, w.to],
    ),
    pool.query<{ suite: string; runs: string; scenarios: string; passed: string; last_run_at: Date | null }>(
      `SELECT suite, COUNT(*) AS runs, COALESCE(SUM(scenario_count), 0) AS scenarios,
              COALESCE(SUM(pass_count), 0) AS passed, MAX(started_at) AS last_run_at
         FROM harness_runs
        WHERE dry_run IS NOT TRUE
          AND started_at >= $1::timestamptz AND started_at <= $2::timestamptz
        GROUP BY suite ORDER BY suite`,
      [w.from, w.to],
    ),
  ]);
  const d = drift.rows[0] ?? {};
  return {
    drift_alerts: {
      opened_in_window: n(d.opened_in_window),
      acknowledged_in_window: n(d.acknowledged_in_window),
      open_at_end: n(d.open_at_end),
      paged_in_window: n(d.paged_in_window),
    },
    harness_runs: harness.rows.map(x => {
      const scenarios = n(x.scenarios);
      const passed = n(x.passed);
      return {
        suite: x.suite,
        runs: n(x.runs),
        scenarios,
        passed,
        pass_rate: scenarios > 0 ? Math.round((passed / scenarios) * 1000) / 1000 : null,
        last_run_at: x.last_run_at,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Data access (who looked at participant data, by role)
// ---------------------------------------------------------------------------

export interface IrbDataAccessCount {
  action: string;
  role: string;
  n: number;
}

/** data_access_log rows in window whose actor OR participant is in the org
 *  (the same scope as the Data Access admin view). */
export async function getIrbDataAccessCounts(w: IrbWindow): Promise<IrbDataAccessCount[]> {
  const r = await pool.query<{ action: string; role: string | null; n: string }>(
    `SELECT dal.action, dal.role, COUNT(*) AS n
       FROM data_access_log dal
       LEFT JOIN therapy_sessions ts ON dal.session_id IS NOT NULL AND ts.session_id::text = dal.session_id
       LEFT JOIN users actor ON actor.userid = dal.accessed_by
       LEFT JOIN users participant ON participant.userid = COALESCE(dal.user_id, ts.user_id)
      WHERE dal.created_at >= $1::timestamptz AND dal.created_at <= $2::timestamptz
        AND (actor.organization_id = $3::int OR participant.organization_id = $3::int)
      GROUP BY 1, 2 ORDER BY 1, 2`,
    [w.from, w.to, w.orgId],
  );
  return r.rows.map(x => ({ action: x.action, role: x.role ?? 'unknown', n: n(x.n) }));
}
