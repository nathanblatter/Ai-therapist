// Data-access for the weekly PI digest (eval spec WP7). The digest is the
// lighter weekly sibling of the IRB packet: everything here is an aggregate
// over an explicit window, scoped with the IRB packet's own scope rule
// (SESSION_SCOPE from irbPacket.queries.ts: demo + sandbox excluded,
// participant data in scope when the user belongs to the caller's org,
// unattributed rows only for the irb-study org). Crisis counts, drift and
// harness tallies are NOT re-implemented: the service calls
// getIrbSafetyCounts / getIrbMonitoringCounts directly. This file adds only
// what the packet does not have (per-week eval score buckets, the nightly
// run-to-run comparison, the adjudication probe) plus the weekly_digests
// archive (migration 115).
import { pool } from '../config/db.js';
import { SESSION_SCOPE, irbWindowParams, type IrbWindow } from './irbPacket.queries.js';

const n = (v: string | number | null | undefined): number => {
  const x = typeof v === 'number' ? v : parseInt(v ?? '0', 10);
  return Number.isFinite(x) ? x : 0;
};

// ---------------------------------------------------------------------------
// Session eval score buckets (consensus rows in session_evals)
// ---------------------------------------------------------------------------

export interface WeeklyEvalScoreRow {
  /** Week bucket, YYYY-MM-DD of the bucket's last day (Sunday-ending weeks
   *  aligned to the digest's week_ending). */
  week_ending: string;
  dimension: string;
  mean_score: number;
  n: number;
}

/**
 * Per-dimension mean consensus score and eval count per week bucket, for the
 * `weeks` weeks ending at `weekEnding` (inclusive). Buckets are aligned so the
 * last one ends exactly on weekEnding; the window param on `w` is ignored in
 * favour of the computed span so callers cannot misalign them. Only evals for
 * `promptVersion` count (scores are not comparable across prompt versions).
 * session_evals rows are joined to therapy_sessions so the IRB scope applies.
 */
export async function getWeeklyEvalScores(
  w: Omit<IrbWindow, 'from' | 'to'>,
  weekEnding: string,
  weeks: number,
  promptVersion: string,
): Promise<WeeklyEvalScoreRow[]> {
  const to = `${weekEnding}T23:59:59.999Z`;
  const fromDate = new Date(`${weekEnding}T00:00:00.000Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - (weeks * 7 - 1));
  const from = fromDate.toISOString();
  const r = await pool.query<{ week_ending: string; dimension: string; mean_score: string; n: string }>(
    `WITH scoped AS (
       SELECT se.rubric, se.created_at
         FROM session_evals se JOIN therapy_sessions ts ON ts.session_id = se.session_id
        WHERE ${SESSION_SCOPE}
          AND se.prompt_version = $5
          AND se.created_at >= $1::timestamptz AND se.created_at <= $2::timestamptz
     ),
     scores AS (
       SELECT -- bucket index counted back from week_ending: 0 = the digest week
              FLOOR(EXTRACT(EPOCH FROM ($2::timestamptz - s.created_at::timestamptz)) / 604800.0)::int AS weeks_back,
              d.key AS dimension,
              (d.value->>'score')::numeric AS score
         FROM scoped s, jsonb_each(s.rubric) d
        WHERE (d.value->>'score') ~ '^[1-5]$'
     )
     SELECT TO_CHAR(($2::timestamptz AT TIME ZONE 'UTC')::date - (weeks_back * 7), 'YYYY-MM-DD') AS week_ending,
            dimension, AVG(score) AS mean_score, COUNT(*) AS n
       FROM scores
      GROUP BY weeks_back, dimension
      ORDER BY weeks_back DESC, dimension`,
    [...irbWindowParams({ ...w, from, to }), promptVersion],
  );
  return r.rows.map((x) => ({
    week_ending: x.week_ending,
    dimension: x.dimension,
    mean_score: Number(x.mean_score),
    n: n(x.n),
  }));
}

/** Distinct sessions with a consensus eval row created inside the window. */
export async function getSessionsEvaluatedCount(w: IrbWindow, promptVersion: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(DISTINCT se.session_id) AS n
       FROM session_evals se JOIN therapy_sessions ts ON ts.session_id = se.session_id
      WHERE ${SESSION_SCOPE} AND se.prompt_version = $5
        AND se.created_at >= $1::timestamptz AND se.created_at <= $2::timestamptz`,
    [...irbWindowParams(w), promptVersion],
  );
  return n(r.rows[0]?.n);
}

// ---------------------------------------------------------------------------
// Harness: nightly run-to-run comparison
// ---------------------------------------------------------------------------

export interface NightlyRunPair {
  suite: string;
  latest: { started_at: Date; scenario_count: number; pass_count: number; git_sha: string | null };
  previous: { started_at: Date; scenario_count: number; pass_count: number; git_sha: string | null } | null;
}

/**
 * The newest nightly run per suite that started inside the window and the one
 * before it (any time). The redteam CLI writes its diff.json/diff.md to the
 * run's output directory, not to the database, so the digest derives the
 * week's "nightly diff" from the persisted harness_runs rows instead.
 */
export async function getNightlyRunPairs(w: Pick<IrbWindow, 'from' | 'to'>): Promise<NightlyRunPair[]> {
  const r = await pool.query<{
    suite: string;
    started_at: Date;
    scenario_count: number;
    pass_count: number;
    git_sha: string | null;
    prev_started_at: Date | null;
    prev_scenario_count: number | null;
    prev_pass_count: number | null;
    prev_git_sha: string | null;
  }>(
    `WITH latest AS (
       SELECT DISTINCT ON (suite) id, suite, started_at, scenario_count, pass_count, git_sha
         FROM harness_runs
        WHERE trigger = 'nightly' AND dry_run IS NOT TRUE
          AND started_at >= $1::timestamptz AND started_at <= $2::timestamptz
        ORDER BY suite, started_at DESC
     )
     SELECT l.suite, l.started_at, l.scenario_count, l.pass_count, l.git_sha,
            p.started_at AS prev_started_at, p.scenario_count AS prev_scenario_count,
            p.pass_count AS prev_pass_count, p.git_sha AS prev_git_sha
       FROM latest l
       LEFT JOIN LATERAL (
         SELECT started_at, scenario_count, pass_count, git_sha
           FROM harness_runs h
          WHERE h.suite = l.suite AND h.trigger = 'nightly' AND h.dry_run IS NOT TRUE
            AND h.started_at < l.started_at
          ORDER BY h.started_at DESC LIMIT 1
       ) p ON TRUE
      ORDER BY l.suite`,
    [w.from, w.to],
  );
  return r.rows.map((x) => ({
    suite: x.suite,
    latest: {
      started_at: x.started_at,
      scenario_count: n(x.scenario_count),
      pass_count: n(x.pass_count),
      git_sha: x.git_sha,
    },
    previous: x.prev_started_at
      ? {
          started_at: x.prev_started_at,
          scenario_count: n(x.prev_scenario_count),
          pass_count: n(x.prev_pass_count),
          git_sha: x.prev_git_sha,
        }
      : null,
  }));
}

// ---------------------------------------------------------------------------
// Crisis adjudication (eval spec WP2) - table may not exist yet
// ---------------------------------------------------------------------------

export interface CrisisAdjudicationCount {
  outcome: string;
  n: number;
}

/**
 * Adjudication outcomes for crisis events created inside the window, or null
 * when the crisis_event_adjudications table has not been migrated in yet
 * (WP2 lands it). The probe is schema-driven so the digest keeps working on
 * either side of that migration; once the table exists its outcome column
 * (`outcome`, expected values confirmed / false_positive / unclear) is
 * tallied. Events with no adjudication row show up as `pending`.
 */
export async function getCrisisAdjudicationCounts(w: IrbWindow): Promise<CrisisAdjudicationCount[] | null> {
  const probe = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'crisis_event_adjudications'`,
  );
  if (probe.rows.length === 0) return null;
  const cols = new Set(probe.rows.map((c) => c.column_name));
  // Migration 114 (WP2) names them `verdict` and `crisis_event_id`; the
  // fallbacks cover the pre-merge guesses so a schema drift degrades to
  // "not enabled" rather than a failed digest.
  const outcomeCol = ['verdict', 'outcome', 'status'].find((c) => cols.has(c));
  const eventCol = ['crisis_event_id', 'event_id'].find((c) => cols.has(c));
  if (!outcomeCol || !eventCol) return null;
  const r = await pool.query<{ outcome: string | null; n: string }>(
    `SELECT a.${outcomeCol} AS outcome, COUNT(*) AS n
       FROM crisis_events ce
       JOIN therapy_sessions ts ON ts.session_id = ce.session_id
       LEFT JOIN crisis_event_adjudications a ON a.${eventCol} = ce.event_id
      WHERE ${SESSION_SCOPE}
        AND ce.created_at >= $1::timestamptz AND ce.created_at <= $2::timestamptz
      GROUP BY 1 ORDER BY 1`,
    irbWindowParams(w),
  );
  return r.rows.map((x) => ({ outcome: x.outcome ?? 'pending', n: n(x.n) }));
}

// ---------------------------------------------------------------------------
// weekly_digests archive (migration 115)
// ---------------------------------------------------------------------------

export interface WeeklyDigestRow {
  id: number;
  org_id: number;
  /** YYYY-MM-DD */
  week_ending: string;
  markdown: string;
  data: Record<string, unknown>;
  generated_at: Date;
  generated_by: string;
}

export type WeeklyDigestSummaryRow = Omit<WeeklyDigestRow, 'markdown' | 'data'>;

const toDateString = (v: Date | string): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

export async function insertWeeklyDigest(input: {
  orgId: number;
  weekEnding: string;
  markdown: string;
  data: Record<string, unknown>;
  generatedBy: string;
  generatedAt?: string;
}): Promise<WeeklyDigestRow> {
  const r = await pool.query<WeeklyDigestRow & { week_ending: Date | string }>(
    `INSERT INTO weekly_digests (org_id, week_ending, markdown, data, generated_by, generated_at)
     VALUES ($1, $2::date, $3, $4, $5, COALESCE($6::timestamptz, CURRENT_TIMESTAMP))
     RETURNING id, org_id, week_ending, markdown, data, generated_at, generated_by`,
    [
      input.orgId,
      input.weekEnding,
      input.markdown,
      JSON.stringify(input.data),
      input.generatedBy,
      input.generatedAt ?? null,
    ],
  );
  const row = r.rows[0];
  return { ...row, week_ending: toDateString(row.week_ending) };
}

/** Newest first, scoped to one org. */
export async function listWeeklyDigests(orgId: number, limit = 26): Promise<WeeklyDigestSummaryRow[]> {
  const r = await pool.query<WeeklyDigestSummaryRow & { week_ending: Date | string }>(
    `SELECT id, org_id, week_ending, generated_at, generated_by
       FROM weekly_digests WHERE org_id = $1
      ORDER BY week_ending DESC, generated_at DESC
      LIMIT $2`,
    [orgId, Math.min(Math.max(1, limit), 200)],
  );
  return r.rows.map((x) => ({ ...x, week_ending: toDateString(x.week_ending) }));
}

/** One digest, only when it belongs to the org (cross-org ids read as absent). */
export async function getWeeklyDigest(id: number, orgId: number): Promise<WeeklyDigestRow | null> {
  const r = await pool.query<WeeklyDigestRow & { week_ending: Date | string }>(
    `SELECT id, org_id, week_ending, markdown, data, generated_at, generated_by
       FROM weekly_digests WHERE id = $1 AND org_id = $2`,
    [id, orgId],
  );
  const row = r.rows[0];
  return row ? { ...row, week_ending: toDateString(row.week_ending) } : null;
}

/** When the scheduler last generated a digest for the org (any week). */
export async function getLastScheduledDigestAt(orgId: number): Promise<Date | null> {
  const r = await pool.query<{ generated_at: Date }>(
    `SELECT generated_at FROM weekly_digests
      WHERE org_id = $1 AND generated_by = 'scheduler'
      ORDER BY generated_at DESC LIMIT 1`,
    [orgId],
  );
  return r.rows[0]?.generated_at ?? null;
}
