// Weekly digest service (eval spec WP7): trend math, week-window helpers,
// composition over mocked queries, empty-week rendering, identifier scrubbing,
// the open-gaps checklist, and the scheduler's due-logic + debounce.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const q = vi.hoisted(() => ({
  getWeeklyEvalScores: vi.fn(),
  getSessionsEvaluatedCount: vi.fn(),
  getNightlyRunPairs: vi.fn(),
  getCrisisAdjudicationCounts: vi.fn(),
  insertWeeklyDigest: vi.fn(),
  getLastScheduledDigestAt: vi.fn(),
}));
const irb = vi.hoisted(() => ({
  getIrbSafetyCounts: vi.fn(),
  getIrbMonitoringCounts: vi.fn(),
}));
const cal = vi.hoisted(() => ({
  computeCalibrationReport: vi.fn(),
  computeJudgeAgreementReport: vi.fn(),
}));
const cfg = vi.hoisted(() => ({
  getSystemConfig: vi.fn(),
  getIrbStudyOrgId: vi.fn(),
  getOrganizationById: vi.fn(),
}));

vi.mock('../config/db.js', () => ({ pool: { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn(), on: vi.fn() } }));
vi.mock('../db/weeklyDigest.queries.js', () => q);
vi.mock('../db/irbPacket.queries.js', () => irb);
vi.mock('../db/organizations.queries.js', () => ({ getIrbStudyOrgId: cfg.getIrbStudyOrgId, getOrganizationById: cfg.getOrganizationById }));
vi.mock('../utils/sessionHelpers.js', () => ({ getSystemConfig: cfg.getSystemConfig, invalidateConfigCache: vi.fn() }));
vi.mock('../utils/gitSha.js', () => ({ gitSha: () => 'abc1234' }));
vi.mock('./evalCalibration.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./evalCalibration.service.js')>();
  return { ...real, computeCalibrationReport: cal.computeCalibrationReport, computeJudgeAgreementReport: cal.computeJudgeAgreementReport };
});

import {
  buildWeeklyDigest,
  generateAndStoreWeeklyDigest,
  computeTrend,
  weekWindow,
  defaultWeekEnding,
  isValidWeekEnding,
  computeGaps,
  normalizeDigestSchedule,
  digestDue,
  digestSchedulerTick,
  DEFAULT_DIGEST_SCHEDULE,
  MIN_PAIRED_RATINGS,
  type WeeklyDigestData,
} from './weeklyDigest.service.js';
import { EVAL_DIMENSIONS } from './sessionEval.service.js';

const WEEK = '2026-10-18';

const emptyCalibration = () => ({
  prompt_version: 'v1', rubric_version: 'v1', pair_count: 0, session_count: 0, overall_kappa: null,
  dimensions: EVAL_DIMENSIONS.map(d => ({ dimension: d, n: 0, kappa: null, human_mean: null, llm_mean: null, mean_bias: null, exact_agreement_pct: null })),
});
const emptyAgreement = () => ({ prompt_version: 'v1', judges: [], session_count: 0, pairs: [], self_consistency: [], high_disagreement: [] });

function primeEmpty() {
  cfg.getSystemConfig.mockResolvedValue({ evals: {} });
  cfg.getIrbStudyOrgId.mockResolvedValue(1);
  cfg.getOrganizationById.mockResolvedValue({ org_id: 1, name: 'IRB Research Study', slug: 'irb-study' });
  q.getWeeklyEvalScores.mockResolvedValue([]);
  q.getSessionsEvaluatedCount.mockResolvedValue(0);
  q.getNightlyRunPairs.mockResolvedValue([]);
  q.getCrisisAdjudicationCounts.mockResolvedValue(null);
  irb.getIrbSafetyCounts.mockResolvedValue({
    crisis_events: [], flagged_sessions: { total: 0, unflagged_before_end: 0, still_flagged_at_end: 0, with_adverse_event_report: 0 },
    interventions: [], pages_sent: 0, escalations: [],
  });
  irb.getIrbMonitoringCounts.mockResolvedValue({
    drift_alerts: { opened_in_window: 0, acknowledged_in_window: 0, open_at_end: 0, paged_in_window: 0 }, harness_runs: [],
  });
  cal.computeCalibrationReport.mockResolvedValue(emptyCalibration());
  cal.computeJudgeAgreementReport.mockResolvedValue(emptyAgreement());
}

beforeEach(() => {
  vi.clearAllMocks();
  primeEmpty();
});

describe('week helpers', () => {
  it('weekWindow spans the 7 UTC days ending on week_ending', () => {
    expect(weekWindow(WEEK)).toEqual({ from: '2026-10-12T00:00:00.000Z', to: '2026-10-18T23:59:59.999Z' });
  });
  it('defaultWeekEnding is the last Sunday strictly before now', () => {
    expect(defaultWeekEnding(new Date('2026-10-19T06:10:00Z'))).toBe('2026-10-18'); // Monday -> yesterday
    expect(defaultWeekEnding(new Date('2026-10-18T12:00:00Z'))).toBe('2026-10-11'); // Sunday -> previous Sunday
    expect(defaultWeekEnding(new Date('2026-10-24T23:59:00Z'))).toBe('2026-10-18'); // Saturday
  });
  it('isValidWeekEnding rejects malformed and impossible dates', () => {
    expect(isValidWeekEnding(WEEK)).toBe(true);
    expect(isValidWeekEnding('2026-02-30')).toBe(false);
    expect(isValidWeekEnding('2026-10-18T00:00:00Z')).toBe(false);
    expect(isValidWeekEnding(42)).toBe(false);
  });
});

describe('computeTrend', () => {
  it('pools prior weeks weighted by n and reports delta against this week', () => {
    const rows = [
      { week_ending: WEEK, dimension: 'empathy', mean_score: 4.5, n: 2 },
      { week_ending: '2026-10-11', dimension: 'empathy', mean_score: 3, n: 1 },
      { week_ending: '2026-09-27', dimension: 'empathy', mean_score: 5, n: 3 }, // pooled prior = (3 + 15) / 4 = 4.5
      { week_ending: WEEK, dimension: 'safety_protocol', mean_score: 5, n: 2 },
    ];
    const trend = computeTrend(rows, WEEK);
    const empathy = trend.find(t => t.dimension === 'empathy')!;
    expect(empathy).toMatchObject({ this_week: 4.5, this_week_n: 2, prior: 4.5, prior_n: 4, delta: 0 });
    const safety = trend.find(t => t.dimension === 'safety_protocol')!;
    expect(safety).toMatchObject({ this_week: 5, this_week_n: 2, prior: null, prior_n: 0, delta: null });
    const clinical = trend.find(t => t.dimension === 'clinical_claims')!;
    expect(clinical).toMatchObject({ this_week: null, prior: null, delta: null });
    expect(trend.map(t => t.dimension)).toEqual([...EVAL_DIMENSIONS]);
  });

  it('ignores zero-n rows and unknown dimensions', () => {
    const trend = computeTrend([
      { week_ending: WEEK, dimension: 'empathy', mean_score: 1, n: 0 },
      { week_ending: WEEK, dimension: 'not_a_dimension', mean_score: 1, n: 9 },
    ], WEEK);
    expect(trend.every(t => t.this_week === null)).toBe(true);
  });
});

describe('buildWeeklyDigest', () => {
  it('renders an empty week without throwing and marks every section as empty', async () => {
    const { markdown, data } = await buildWeeklyDigest({ weekEnding: WEEK, orgId: 1, generatedAt: '2026-10-19T06:00:00.000Z' });
    expect(data.meta).toMatchObject({ week_ending: WEEK, git_sha: 'abc1234', organization: { id: 1, is_irb_study_org: true } });
    expect(data.sessions_evaluated).toBe(0);
    expect(markdown).toContain('# Weekly quality digest - week ending 2026-10-18');
    expect(markdown).toContain('No scored sessions in this week or the prior four');
    expect(markdown).toContain('No harness runs this week.');
    expect(markdown).toContain('No crisis events this week.');
    expect(markdown).toContain('adjudication not yet enabled');
    expect(markdown).toContain('No per-judge runs stored');
    expect(markdown).toContain(`below the ${MIN_PAIRED_RATINGS}-rating rule`);
    expect(markdown).toContain('Generated 2026-10-19T06:00:00.000Z from build abc1234');
    // Window is the digest week and the queries are scoped to the org, unattributed rows included for irb-study.
    expect(irb.getIrbSafetyCounts).toHaveBeenCalledWith({ from: '2026-10-12T00:00:00.000Z', to: '2026-10-18T23:59:59.999Z', orgId: 1, includeUnattributed: true });
    expect(q.getWeeklyEvalScores).toHaveBeenCalledWith(expect.objectContaining({ orgId: 1 }), WEEK, 5, 'v1');
  });

  it('scopes a non-study org without unattributed rows', async () => {
    cfg.getOrganizationById.mockResolvedValue({ org_id: 7, name: 'Clinic', slug: 'clinic' });
    const { data } = await buildWeeklyDigest({ weekEnding: WEEK, orgId: 7 });
    expect(data.meta.organization.is_irb_study_org).toBe(false);
    expect(irb.getIrbMonitoringCounts).toHaveBeenCalledWith(expect.objectContaining({ orgId: 7, includeUnattributed: false }));
  });

  it('rejects a malformed week ending', async () => {
    await expect(buildWeeklyDigest({ weekEnding: 'last week', orgId: 1 })).rejects.toThrow(/weekEnding/);
  });

  it('composes a full week: trend, harness diff, crisis by severity, adjudication, calibration and gaps', async () => {
    q.getSessionsEvaluatedCount.mockResolvedValue(3);
    q.getWeeklyEvalScores.mockResolvedValue([
      { week_ending: WEEK, dimension: 'empathy', mean_score: 3, n: 3 },
      { week_ending: '2026-10-11', dimension: 'empathy', mean_score: 4, n: 2 },
    ]);
    irb.getIrbMonitoringCounts.mockResolvedValue({
      drift_alerts: { opened_in_window: 2, acknowledged_in_window: 1, open_at_end: 1, paged_in_window: 0 },
      harness_runs: [{ suite: 'voice', runs: 7, scenarios: 14, passed: 10, pass_rate: 0.714, last_run_at: new Date('2026-10-18T09:00:00Z') }],
    });
    q.getNightlyRunPairs.mockResolvedValue([{
      suite: 'voice',
      latest: { started_at: new Date('2026-10-18T09:00:00Z'), scenario_count: 2, pass_count: 2, git_sha: 'aaa' },
      previous: { started_at: new Date('2026-10-17T09:00:00Z'), scenario_count: 2, pass_count: 1, git_sha: 'bbb' },
    }]);
    irb.getIrbSafetyCounts.mockResolvedValue({
      crisis_events: [
        { event_type: 'flagged', severity: 'high', n: 2 },
        { event_type: 'flagged', severity: 'low', n: 1 },
        { event_type: 'escalated', severity: 'high', n: 1 },
      ],
      flagged_sessions: { total: 3, unflagged_before_end: 1, still_flagged_at_end: 2, with_adverse_event_report: 0 },
      interventions: [{ action_type: 'crisis_sms_alert', n: 2 }], pages_sent: 2, escalations: [],
    });
    q.getCrisisAdjudicationCounts.mockResolvedValue([{ outcome: 'confirmed', n: 3 }, { outcome: 'pending', n: 1 }]);
    cal.computeCalibrationReport.mockResolvedValue({
      ...emptyCalibration(), pair_count: 24, session_count: 12, overall_kappa: 0.71,
      dimensions: EVAL_DIMENSIONS.map(d => ({ dimension: d, n: 24, kappa: 0.65, human_mean: 4, llm_mean: 4.1, mean_bias: 0.1, exact_agreement_pct: 60 })),
    });
    cal.computeJudgeAgreementReport.mockResolvedValue({
      ...emptyAgreement(), judges: ['gpt-4o-mini', 'gpt-5-mini'], session_count: 12,
      pairs: [{ judge_a: 'gpt-4o-mini', judge_b: 'gpt-5-mini', n: 12, overall_kappa: 0.55,
        dimensions: EVAL_DIMENSIONS.map(d => ({ dimension: d, n: 12, kappa: 0.5, exact_agreement_pct: 50, mean_bias: 0, major_disagreement_pct: 10 })) }],
      high_disagreement: [{ session_id: 's1', max_spread: 2, judge_spread: { empathy: 2 } }],
    });
    cfg.getSystemConfig.mockResolvedValue({ evals: { auto_run_enabled: true, drift_page_enabled: false, harness_schedule: { enabled: true }, digest_schedule: { enabled: true } } });

    const { markdown, data } = await buildWeeklyDigest({ weekEnding: WEEK, orgId: 1 });
    expect(data.sessions_evaluated).toBe(3);
    expect(data.trend.find(t => t.dimension === 'empathy')).toMatchObject({ this_week: 3, prior: 4, delta: -1 });
    expect(markdown).toContain('| Empathy / reflective listening | 3.00 | 3 | 4.00 | 2 | -1.00 |');
    expect(data.harness.nightly_diff[0].pass_rate_delta).toBeCloseTo(0.5);
    expect(markdown).toContain('| voice | 2/2 on 2026-10-18 | 1/2 on 2026-10-17 | +50 pts |');
    expect(data.crisis).toMatchObject({ total: 4, pages_sent: 2 });
    expect(data.crisis.events_by_severity).toEqual([{ severity: 'high', n: 3 }, { severity: 'low', n: 1 }]);
    expect(markdown).toContain('| confirmed | 3 |');
    expect(markdown).not.toContain('adjudication not yet enabled');
    expect(data.calibration).toMatchObject({ meets_pair_rule: true, meets_kappa_rule: true });
    expect(markdown).toContain('1 session flagged for human review');
    const gap = (k: string) => data.gaps.find(g => g.key === k)!;
    expect(gap('auto_eval').open).toBe(false);
    expect(gap('drift_paging').open).toBe(true);
    expect(gap('adjudication').open).toBe(false);
    expect(gap('kappa').open).toBe(false);
    expect(gap('paired_ratings').open).toBe(false);
    // The session id behind a high-disagreement row never reaches the digest.
    expect(markdown).not.toContain('s1');
    expect(JSON.stringify(data)).not.toContain('"s1"');
  });

  it('scrubs usernames and emails out of every free-text field that reaches the markdown', async () => {
    cfg.getOrganizationById.mockResolvedValue({ org_id: 1, name: 'Study run by res1 <res1@byu.edu> for participant 42', slug: 'irb-study' });
    irb.getIrbMonitoringCounts.mockResolvedValue({
      drift_alerts: { opened_in_window: 0, acknowledged_in_window: 0, open_at_end: 0, paged_in_window: 0 },
      harness_runs: [{ suite: 'voice|user 7 ops@example.org', runs: 1, scenarios: 1, passed: 1, pass_rate: 1, last_run_at: null }],
    });
    irb.getIrbSafetyCounts.mockResolvedValue({
      crisis_events: [{ event_type: 'flagged by nathan@example.com', severity: 'high', n: 1 }],
      flagged_sessions: { total: 1, unflagged_before_end: 0, still_flagged_at_end: 1, with_adverse_event_report: 0 },
      interventions: [], pages_sent: 0, escalations: [],
    });
    q.getCrisisAdjudicationCounts.mockResolvedValue([{ outcome: 'confirmed by user_id 9', n: 1 }]);
    const { markdown } = await buildWeeklyDigest({ weekEnding: WEEK, orgId: 1 });
    expect(markdown).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(markdown).not.toContain('participant 42');
    expect(markdown).not.toContain('user 7');
    expect(markdown).not.toContain('user_id 9');
    expect(markdown).toContain('[email]');
    // A pipe inside a cell cannot break the table.
    expect(markdown).toContain('voice\\|user [id]');
  });

  it('generateAndStoreWeeklyDigest archives the markdown + data with the generator label', async () => {
    q.insertWeeklyDigest.mockImplementation(async (i: Record<string, unknown>) => ({ id: 5, ...i, week_ending: i.weekEnding }));
    const row = await generateAndStoreWeeklyDigest({ weekEnding: WEEK, orgId: 1, generatedBy: 'scheduler', generatedAt: '2026-10-19T06:00:00.000Z' });
    expect(row.id).toBe(5);
    expect(q.insertWeeklyDigest).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 1, weekEnding: WEEK, generatedBy: 'scheduler', generatedAt: '2026-10-19T06:00:00.000Z',
      markdown: expect.stringContaining('# Weekly quality digest'),
    }));
    const data = q.insertWeeklyDigest.mock.calls[0][0].data as WeeklyDigestData;
    expect(data.meta.week_ending).toBe(WEEK);
  });
});

describe('computeGaps', () => {
  const calibration = { pair_count: 3, session_count: 3, min_pairs: 20, target_kappa: 0.6, overall_kappa: null, dimensions: [], meets_pair_rule: false, meets_kappa_rule: false };
  it('treats an empty evals config as everything open except the default two-judge ensemble', () => {
    const gaps = computeGaps({}, calibration, false);
    expect(gaps.filter(g => g.open).map(g => g.key)).toEqual(['auto_eval', 'drift_paging', 'nightly_harness', 'weekly_digest', 'paired_ratings', 'kappa', 'adjudication']);
  });
  it('flags a single-judge config', () => {
    expect(computeGaps({ judge_models: ['gpt-4o-mini'] }, calibration, true).find(g => g.key === 'judge_ensemble')!.open).toBe(true);
  });
});

describe('digest schedule', () => {
  it('normalizes garbage to the disabled Monday 06:00 UTC default', () => {
    expect(normalizeDigestSchedule(undefined)).toEqual(DEFAULT_DIGEST_SCHEDULE);
    expect(normalizeDigestSchedule({ enabled: 'yes', weekday: 9, hour_utc: 24 })).toEqual({ enabled: false, weekday: 1, hour_utc: 6 });
    expect(normalizeDigestSchedule({ enabled: true, weekday: 0, hour_utc: 23 })).toEqual({ enabled: true, weekday: 0, hour_utc: 23 });
  });

  it('digestDue fires only in the scheduled UTC weekday + hour, and debounces for 6 days', () => {
    const sched = { enabled: true, weekday: 1, hour_utc: 6 };
    const monday0610 = new Date('2026-10-19T06:10:00Z');
    expect(digestDue(sched, monday0610, null)).toBe(true);
    expect(digestDue(sched, new Date('2026-10-19T07:00:00Z'), null)).toBe(false); // wrong hour
    expect(digestDue(sched, new Date('2026-10-20T06:10:00Z'), null)).toBe(false); // Tuesday
    expect(digestDue({ ...sched, enabled: false }, monday0610, null)).toBe(false);
    expect(digestDue(sched, monday0610, new Date('2026-10-19T06:05:00Z'))).toBe(false); // already ran this tick-hour
    expect(digestDue(sched, monday0610, new Date('2026-10-15T06:05:00Z'))).toBe(false); // 4 days ago: same week
    expect(digestDue(sched, monday0610, new Date('2026-10-12T06:05:00Z'))).toBe(true); // last Monday: due again
  });

  it('digestSchedulerTick generates the previous week for the study org when due, and is a no-op otherwise', async () => {
    cfg.getSystemConfig.mockResolvedValue({ evals: { digest_schedule: { enabled: true, weekday: 1, hour_utc: 6 } } });
    q.getLastScheduledDigestAt.mockResolvedValue(null);
    q.insertWeeklyDigest.mockImplementation(async (i: Record<string, unknown>) => ({ id: 1, ...i, week_ending: i.weekEnding }));
    expect(await digestSchedulerTick(new Date('2026-10-19T06:03:00Z'))).toBe(true);
    expect(q.insertWeeklyDigest).toHaveBeenCalledWith(expect.objectContaining({ orgId: 1, weekEnding: '2026-10-18', generatedBy: 'scheduler' }));

    q.insertWeeklyDigest.mockClear();
    q.getLastScheduledDigestAt.mockResolvedValue(new Date('2026-10-19T06:03:00Z'));
    expect(await digestSchedulerTick(new Date('2026-10-19T06:08:00Z'))).toBe(false);
    expect(q.insertWeeklyDigest).not.toHaveBeenCalled();

    cfg.getSystemConfig.mockResolvedValue({ evals: {} });
    expect(await digestSchedulerTick(new Date('2026-10-19T06:03:00Z'))).toBe(false);
  });

  it('digestSchedulerTick never throws when generation fails', async () => {
    cfg.getSystemConfig.mockResolvedValue({ evals: { digest_schedule: { enabled: true, weekday: 1, hour_utc: 6 } } });
    q.getLastScheduledDigestAt.mockResolvedValue(null);
    irb.getIrbSafetyCounts.mockRejectedValue(new Error('db down'));
    expect(await digestSchedulerTick(new Date('2026-10-19T06:03:00Z'))).toBe(false);
  });
});
