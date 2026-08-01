// Data-access for the study-operations dashboard (ai-therapist-98): enrollment
// / arm-balance / sessions-per-participant metrics, protocol-deviation CRUD,
// and the idempotent anomaly auto-flag scan. Part of the db/ layer.
//
// Everything excludes demo traffic (is_demo IS NOT TRUE) and, when the
// study_protocol config sets study_start/end, restricts to that window.
import { pool } from '../config/db.js';
import { getSystemConfigByKey } from './config.queries.js';

export interface StudyProtocol {
  enrollment_target: number;
  expected_sessions_per_participant: number;
  study_start: string | null;
  study_end: string | null;
  arm_imbalance_threshold: number;
}

const DEFAULT_PROTOCOL: StudyProtocol = {
  enrollment_target: 40,
  expected_sessions_per_participant: 4,
  study_start: null,
  study_end: null,
  arm_imbalance_threshold: 0.15,
};

export async function getStudyProtocol(): Promise<StudyProtocol> {
  const row = await getSystemConfigByKey('study_protocol');
  if (!row) return { ...DEFAULT_PROTOCOL };
  return { ...DEFAULT_PROTOCOL, ...(row.config_value as Partial<StudyProtocol>) };
}

// study window params, shared by every windowed query. $1 = start, $2 = end.
const WINDOW = `($1::timestamptz IS NULL OR ts.created_at >= $1)
             AND ($2::timestamptz IS NULL OR ts.created_at <= $2)`;

export interface StudyOpsSummary {
  protocol: StudyProtocol;
  enrollment: {
    enrolled_participants: number;
    anonymous_sessions: number;
    target: number;
    weekly: { week: string; new_participants: number }[];
  };
  arm_balance: {
    arm_true: number;
    arm_false: number;
    arm_null: number;
    imbalance: number | null;
    threshold: number;
    over_threshold: boolean;
  };
  sessions_per_participant: {
    histogram: { n_sessions: number; n_participants: number }[];
    expected: number;
    below_expected: number;
    at_expected: number;
    above_expected: number;
  };
  conditions: { dimension: string; value: string; n: number }[];
  deviations: { open: number; major_open: number };
}

export async function getStudyOpsSummary(): Promise<StudyOpsSummary> {
  const protocol = await getStudyProtocol();
  const p = [protocol.study_start, protocol.study_end];

  const enrollment = await pool.query<{ enrolled_participants: string; anonymous_sessions: string }>(
    `SELECT COUNT(DISTINCT ts.user_id) FILTER (WHERE ts.user_id IS NOT NULL) AS enrolled_participants,
            COUNT(DISTINCT ts.session_id) FILTER (WHERE ts.user_id IS NULL) AS anonymous_sessions
       FROM therapy_sessions ts
      WHERE ts.is_demo IS NOT TRUE AND ${WINDOW}`, p);

  const weekly = await pool.query<{ week: string; new_participants: string }>(
    `SELECT to_char(date_trunc('week', first_session), 'YYYY-MM-DD') AS week,
            COUNT(*) AS new_participants
       FROM (
         SELECT ts.user_id, MIN(ts.created_at) AS first_session
           FROM therapy_sessions ts
          WHERE ts.is_demo IS NOT TRUE AND ts.user_id IS NOT NULL AND ${WINDOW}
          GROUP BY ts.user_id
       ) g
      GROUP BY 1 ORDER BY 1`, p);

  const arms = await pool.query<{ arm_true: string; arm_false: string; arm_null: string }>(
    `SELECT COUNT(*) FILTER (WHERE sc.proactive_offering IS TRUE) AS arm_true,
            COUNT(*) FILTER (WHERE sc.proactive_offering IS FALSE) AS arm_false,
            COUNT(*) FILTER (WHERE sc.proactive_offering IS NULL) AS arm_null
       FROM therapy_sessions ts
       JOIN session_configurations sc ON sc.session_id = ts.session_id
      WHERE ts.is_demo IS NOT TRUE AND ${WINDOW}`, p);

  const hist = await pool.query<{ n_sessions: string; n_participants: string }>(
    `SELECT n_sessions, COUNT(*) AS n_participants FROM (
        SELECT ts.user_id, COUNT(*) AS n_sessions
          FROM therapy_sessions ts
         WHERE ts.is_demo IS NOT TRUE AND ts.user_id IS NOT NULL AND ${WINDOW}
         GROUP BY ts.user_id
     ) g GROUP BY n_sessions ORDER BY n_sessions`, p);

  const conditions = await pool.query<{ dimension: string; value: string; n: string }>(
    `SELECT dimension, value, COUNT(*) AS n FROM (
        SELECT 'ai_model' AS dimension, sc.ai_model AS value
          FROM session_configurations sc JOIN therapy_sessions ts ON ts.session_id = sc.session_id
         WHERE ts.is_demo IS NOT TRUE AND sc.ai_model IS NOT NULL AND ${WINDOW}
        UNION ALL
        SELECT 'modality', sc.modality
          FROM session_configurations sc JOIN therapy_sessions ts ON ts.session_id = sc.session_id
         WHERE ts.is_demo IS NOT TRUE AND sc.modality IS NOT NULL AND ${WINDOW}
        UNION ALL
        SELECT 'theme', sc.theme
          FROM session_configurations sc JOIN therapy_sessions ts ON ts.session_id = sc.session_id
         WHERE ts.is_demo IS NOT TRUE AND sc.theme IS NOT NULL AND ${WINDOW}
     ) d GROUP BY dimension, value ORDER BY dimension, value`, p);

  const dev = await pool.query<{ open: string; major_open: string }>(
    `SELECT COUNT(*) FILTER (WHERE status IN ('open','acknowledged')) AS open,
            COUNT(*) FILTER (WHERE status IN ('open','acknowledged') AND severity = 'major') AS major_open
       FROM protocol_deviations`);

  const armTrue = parseInt(arms.rows[0]?.arm_true ?? '0', 10);
  const armFalse = parseInt(arms.rows[0]?.arm_false ?? '0', 10);
  const armNull = parseInt(arms.rows[0]?.arm_null ?? '0', 10);
  const denom = armTrue + armFalse;
  const imbalance = denom > 0 ? Math.abs(armTrue - armFalse) / denom : null;

  const expected = protocol.expected_sessions_per_participant;
  const histogram = hist.rows.map(r => ({
    n_sessions: parseInt(r.n_sessions, 10),
    n_participants: parseInt(r.n_participants, 10),
  }));
  const below = histogram.filter(h => h.n_sessions < expected).reduce((a, h) => a + h.n_participants, 0);
  const at = histogram.filter(h => h.n_sessions === expected).reduce((a, h) => a + h.n_participants, 0);
  const above = histogram.filter(h => h.n_sessions > expected).reduce((a, h) => a + h.n_participants, 0);

  return {
    protocol,
    enrollment: {
      enrolled_participants: parseInt(enrollment.rows[0]?.enrolled_participants ?? '0', 10),
      anonymous_sessions: parseInt(enrollment.rows[0]?.anonymous_sessions ?? '0', 10),
      target: protocol.enrollment_target,
      weekly: weekly.rows.map(r => ({ week: r.week, new_participants: parseInt(r.new_participants, 10) })),
    },
    arm_balance: {
      arm_true: armTrue, arm_false: armFalse, arm_null: armNull,
      imbalance, threshold: protocol.arm_imbalance_threshold,
      over_threshold: imbalance !== null && imbalance > protocol.arm_imbalance_threshold,
    },
    sessions_per_participant: {
      histogram, expected, below_expected: below, at_expected: at, above_expected: above,
    },
    conditions: conditions.rows.map(r => ({ dimension: r.dimension, value: r.value, n: parseInt(r.n, 10) })),
    deviations: {
      open: parseInt(dev.rows[0]?.open ?? '0', 10),
      major_open: parseInt(dev.rows[0]?.major_open ?? '0', 10),
    },
  };
}

// --------------------------- Deviation CRUD ---------------------------------

export interface DeviationRow {
  deviation_id: number;
  occurred_at: Date;
  source: string;
  category: string;
  severity: string;
  session_id: string | null;
  description: string;
  details: unknown;
  auto_key: string | null;
  status: string;
  created_by: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function listDeviations(status: 'open' | 'all', limit = 100): Promise<DeviationRow[]> {
  const whereOpen = status === 'open' ? `WHERE status IN ('open','acknowledged')` : '';
  const result = await pool.query<DeviationRow>(
    `SELECT * FROM protocol_deviations ${whereOpen}
      ORDER BY occurred_at DESC, deviation_id DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export interface CreateDeviationInput {
  occurred_at?: string | null;
  category: string;
  severity?: string;
  session_id?: string | null;
  description: string;
  created_by: string;
}

export async function createDeviation(input: CreateDeviationInput): Promise<DeviationRow> {
  const result = await pool.query<DeviationRow>(
    `INSERT INTO protocol_deviations
       (occurred_at, source, category, severity, session_id, description, created_by)
     VALUES (COALESCE($1::timestamptz, CURRENT_TIMESTAMP), 'manual', $2, $3, $4, $5, $6)
     RETURNING *`,
    [input.occurred_at ?? null, input.category, input.severity ?? 'minor',
     input.session_id ?? null, input.description, input.created_by]
  );
  return result.rows[0];
}

export interface UpdateDeviationInput {
  status?: string;
  description?: string;
  severity?: string;
}

export async function updateDeviation(
  id: number, patch: UpdateDeviationInput, actor: string
): Promise<DeviationRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (patch.status !== undefined) { sets.push(`status = $${i++}`); params.push(patch.status); }
  if (patch.description !== undefined) { sets.push(`description = $${i++}`); params.push(patch.description); }
  if (patch.severity !== undefined) { sets.push(`severity = $${i++}`); params.push(patch.severity); }
  // Stamp resolver when moving to a terminal status.
  if (patch.status === 'resolved' || patch.status === 'dismissed') {
    sets.push(`resolved_by = $${i++}`); params.push(actor);
    sets.push(`resolved_at = CURRENT_TIMESTAMP`);
  }
  sets.push(`updated_at = CURRENT_TIMESTAMP`);
  if (sets.length === 1) {
    // Only updated_at would change — nothing meaningful to patch.
    const cur = await pool.query<DeviationRow>('SELECT * FROM protocol_deviations WHERE deviation_id = $1', [id]);
    return cur.rows[0] ?? null;
  }
  params.push(id);
  const result = await pool.query<DeviationRow>(
    `UPDATE protocol_deviations SET ${sets.join(', ')} WHERE deviation_id = $${i} RETURNING *`,
    params
  );
  return result.rows[0] ?? null;
}

/** Delete a MANUAL deviation. Auto-flagged rows (source='auto') are refused. */
export async function deleteDeviation(id: number): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM protocol_deviations WHERE deviation_id = $1 AND source = 'manual'`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

// --------------------------- Anomaly auto-flag scan -------------------------

/**
 * Idempotent anomaly scan (ai-therapist-98 §5.4). Every insert is
 * ON CONFLICT (auto_key) DO NOTHING, so re-scanning adds nothing. Returns the
 * number of NEW deviation rows created this pass.
 */
export async function scanForDeviations(): Promise<{ inserted: number }> {
  const protocol = await getStudyProtocol();
  const start = protocol.study_start;
  const end = protocol.study_end;
  let inserted = 0;

  // 1a. config drift — >1 distinct in-window value for ai_model/modality/theme.
  const r1a = await pool.query(
    `WITH cfg AS (
       SELECT sc.ai_model, sc.modality, sc.theme
         FROM session_configurations sc JOIN therapy_sessions ts ON ts.session_id = sc.session_id
        WHERE ts.is_demo IS NOT TRUE AND ${WINDOW}
     ),
     vals AS (
       SELECT 'ai_model' AS dim, ai_model AS val FROM cfg WHERE ai_model IS NOT NULL
       UNION ALL SELECT 'modality', modality FROM cfg WHERE modality IS NOT NULL
       UNION ALL SELECT 'theme', theme FROM cfg WHERE theme IS NOT NULL
     ),
     dim_distinct AS (SELECT dim, COUNT(DISTINCT val) AS dn FROM vals GROUP BY dim),
     distinct_vals AS (SELECT DISTINCT dim, val FROM vals)
     INSERT INTO protocol_deviations (source, category, severity, description, details, auto_key, created_by)
     SELECT 'auto', 'config_change_mid_study', 'minor',
            'Multiple distinct ' || dv.dim || ' values used in-study; flagged value: ' || dv.val,
            jsonb_build_object('dimension', dv.dim, 'value', dv.val),
            'cfg:' || dv.dim || ':' || dv.val, 'system'
       FROM distinct_vals dv JOIN dim_distinct dd ON dd.dim = dv.dim
      WHERE dd.dn > 1
     ON CONFLICT (auto_key) DO NOTHING`, [start, end]);
  inserted += r1a.rowCount ?? 0;

  // 1b. system_config row touched within the study window (only meaningful when
  // a window is set, else "mid-study" is undefined).
  if (start) {
    const r1b = await pool.query(
      `INSERT INTO protocol_deviations (source, category, severity, description, details, auto_key, created_by)
       SELECT 'auto', 'config_change_mid_study', 'major',
              'system_config "' || config_key || '" changed during the study window',
              jsonb_build_object('config_key', config_key, 'updated_at', updated_at, 'updated_by', updated_by),
              'cfgrow:' || config_key || ':' || to_char(updated_at, 'YYYYMMDDHH24MISS'), 'system'
         FROM system_config
        WHERE config_key IN ('ai_model', 'system_prompts', 'session_limits', 'features')
          AND updated_at IS NOT NULL
          AND updated_at >= $1::timestamptz
          AND ($2::timestamptz IS NULL OR updated_at <= $2)
       ON CONFLICT (auto_key) DO NOTHING`, [start, end]);
    inserted += r1b.rowCount ?? 0;
  }

  // 2. arm imbalance — imbalance > threshold and (t+f) >= 10; one flag/week.
  const r2 = await pool.query(
    `WITH arms AS (
       SELECT COUNT(*) FILTER (WHERE sc.proactive_offering IS TRUE) AS t,
              COUNT(*) FILTER (WHERE sc.proactive_offering IS FALSE) AS f
         FROM session_configurations sc JOIN therapy_sessions ts ON ts.session_id = sc.session_id
        WHERE ts.is_demo IS NOT TRUE AND ${WINDOW}
     )
     INSERT INTO protocol_deviations (source, category, severity, description, details, auto_key, created_by)
     SELECT 'auto', 'arm_imbalance', 'major',
            'proactive_offering arm imbalance ' || round(abs(t - f)::numeric / NULLIF(t + f, 0), 3)
              || ' exceeds threshold ' || $3::text || ' (true=' || t || ', false=' || f || ')',
            jsonb_build_object('arm_true', t, 'arm_false', f,
                               'imbalance', round(abs(t - f)::numeric / NULLIF(t + f, 0), 4)),
            'arm:' || to_char(now(), 'IYYY-IW'), 'system'
       FROM arms
      WHERE (t + f) >= 10 AND abs(t - f)::numeric / NULLIF(t + f, 0) > $3
     ON CONFLICT (auto_key) DO NOTHING`, [start, end, protocol.arm_imbalance_threshold]);
  inserted += r2.rowCount ?? 0;

  // 3. session-count overrun — participant with > expected+2 in-window sessions.
  const r3 = await pool.query(
    `INSERT INTO protocol_deviations (source, category, severity, description, details, auto_key, created_by)
     SELECT 'auto', 'session_limit_exceeded', 'minor',
            'Participant ' || g.user_id || ' has ' || g.n || ' in-study sessions (expected ' || $3 || ', +2 tolerance)',
            jsonb_build_object('user_id', g.user_id, 'n_sessions', g.n),
            'overuse:' || g.user_id || ':' || g.n, 'system'
       FROM (
         SELECT ts.user_id, COUNT(*) AS n
           FROM therapy_sessions ts
          WHERE ts.is_demo IS NOT TRUE AND ts.user_id IS NOT NULL AND ${WINDOW}
          GROUP BY ts.user_id
       ) g
      WHERE g.n > $3 + 2
     ON CONFLICT (auto_key) DO NOTHING`, [start, end, protocol.expected_sessions_per_participant]);
  inserted += r3.rowCount ?? 0;

  // 4. consent-version change — >1 distinct consent_version among in-window consents.
  const r4 = await pool.query(
    `WITH cv AS (
       SELECT DISTINCT pc.consent_version
         FROM participant_consents pc
        WHERE ($1::timestamptz IS NULL OR pc.accepted_at >= $1)
          AND ($2::timestamptz IS NULL OR pc.accepted_at <= $2)
     ),
     cnt AS (SELECT COUNT(*) AS c FROM cv)
     INSERT INTO protocol_deviations (source, category, severity, description, details, auto_key, created_by)
     SELECT 'auto', 'consent_version_change', 'major',
            'More than one consent version accepted in-study; version: ' || cv.consent_version,
            jsonb_build_object('consent_version', cv.consent_version), 'consent:' || cv.consent_version, 'system'
       FROM cv CROSS JOIN cnt
      WHERE cnt.c > 1
     ON CONFLICT (auto_key) DO NOTHING`, [start, end]);
  inserted += r4.rowCount ?? 0;

  return { inserted };
}
