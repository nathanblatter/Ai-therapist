// Admin analytics dashboard API (therapist/researcher). Parses the dashboard's
// filter query params and shapes the aggregated metrics for the frontend; the
// heavy aggregation SQL lives in db/analytics.queries.ts.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { getDashboardAnalytics } from '../../db/index.js';

// Split a comma-separated query param into a non-empty string[] (or null).
function parseList(value: unknown): string[] | null {
  if (!value) return null;
  return String(value).split(',').filter(Boolean);
}

export default function analyticsRoutes(): Router {
  const router = Router();

  // GET /admin/api/analytics - dashboard metrics
  router.get('/admin/api/analytics', requireRole('therapist', 'researcher'), async (req, res) => {
    const { startDate, endDate, voices, languages, sessionTypes, statuses, endedBy, crisisFlagged } = req.query;

    try {
      const data = await getDashboardAnalytics({
        startDate: startDate ? String(startDate) : null,
        endDate: endDate ? String(endDate) : null,
        voices: parseList(voices),
        languages: parseList(languages),
        sessionTypes: parseList(sessionTypes),
        statuses: parseList(statuses),
        endedBy: parseList(endedBy),
        crisisFlagged: crisisFlagged === 'true' ? true : crisisFlagged === 'false' ? false : null,
      });

      res.json({
        metrics: data.metrics || {},
        breakdown: data.breakdown || {},
        daily_trend: data.daily_trend || [],
        user_sessions: data.user_sessions || [],
        time_distribution: data.time_distribution || [],
        duration_distribution: data.duration_distribution || [],
        duration_trend: data.duration_trend || [],
        language_distribution: data.language_distribution || [],
        voice_distribution: data.voice_distribution || [],
        completion_patterns: data.completion_patterns || [],
        abandonment_stats: data.abandonment_stats || {},
        session_depth: data.session_depth || [],
        engagement_pace: data.engagement_pace || {},
        response_times: data.response_times || {},
        chat_response_times: data.chat_response_times || {},
        turn_taking: data.turn_taking || {},
        sideband_reliability: data.sideband_reliability || {},
      });
    } catch (err) {
      console.error('Failed to fetch analytics:', err);
      res.status(500).json({ error: 'Failed to fetch analytics' });
    }
  });

  // GET /admin/api/analytics/tools - tool-usage analytics (ai-therapist-75):
  // per-tool frequency + failure rate, tools-per-session distribution, and
  // dead tools (registered in the toolRegistry but never invoked).
  router.get('/admin/api/analytics/tools', requireRole('therapist', 'researcher'), async (_req, res) => {
    try {
      const { toolRegistry } = await import('../../services/toolRegistry.service.js');
      const {
        getToolInvocationStats,
        getToolsPerSessionDistribution,
        getToolUsageSessionCounts,
      } = await import('../../db/index.js');

      const [stats, distribution, sessionCounts] = await Promise.all([
        getToolInvocationStats(),
        getToolsPerSessionDistribution(),
        getToolUsageSessionCounts(),
      ]);

      const invokedNames = new Set(stats.map(s => s.tool_name));
      const deadTools = toolRegistry.getAllToolDefinitions()
        .map(def => def.name)
        .filter(name => !invokedNames.has(name));

      const zeroToolSessions = Math.max(
        0,
        sessionCounts.total_sessions - sessionCounts.sessions_with_tool_use
      );

      res.json({
        tool_stats: stats,
        distinct_tools_per_session: [
          { distinct_tool_count: 0, session_count: zeroToolSessions },
          ...distribution,
        ],
        dead_tools: deadTools,
        registered_tool_count: toolRegistry.getAllToolDefinitions().length,
        sessions_with_tool_use: sessionCounts.sessions_with_tool_use,
        total_sessions: sessionCounts.total_sessions,
      });
    } catch (err) {
      console.error('Failed to fetch tool analytics:', err);
      res.status(500).json({ error: 'Failed to fetch tool analytics' });
    }
  });

  // GET /admin/api/analytics/cost - per-session cost/token tracking rollup
  // (ai-therapist-25c): all-time totals + a daily-spend series for the admin
  // analytics view.
  router.get('/admin/api/analytics/cost', requireRole('therapist', 'researcher'), async (req, res) => {
    const days = req.query.days ? parseInt(String(req.query.days), 10) : 30;
    try {
      const { getCostTotals, getDailySpend, getFeedbackAggregate } = await import('../../db/index.js');
      const [totals, dailySpend, feedback] = await Promise.all([
        getCostTotals(),
        getDailySpend(Number.isFinite(days) && days > 0 ? days : 30),
        getFeedbackAggregate(),
      ]);
      res.json({ totals, daily_spend: dailySpend, feedback });
    } catch (err) {
      console.error('Failed to fetch cost analytics:', err);
      res.status(500).json({ error: 'Failed to fetch cost analytics' });
    }
  });

  // GET /admin/api/analytics/pairwise?promptVersion=pw-v1 - pairwise A/B eval
  // win-rates with Wilson 95% CIs (ai-therapist-81).
  router.get('/admin/api/analytics/pairwise', requireRole('therapist', 'researcher'), async (req, res) => {
    try {
      const { getPairwiseAggregates } = await import('../../db/index.js');
      const { PAIRWISE_PROMPT_VERSION } = await import('../../services/pairwiseEval.service.js');
      const { wilsonInterval } = await import('../../utils/stats.js');
      const promptVersion = req.query.promptVersion ? String(req.query.promptVersion) : PAIRWISE_PROMPT_VERSION;

      const aggregates = await getPairwiseAggregates(promptVersion);
      const comparisons = aggregates.map(a => {
        const nDecisive = a.wins_x + a.wins_y;
        const ci = wilsonInterval(a.wins_x, nDecisive);
        const winRateX = ci ? ci.p : null;
        const significant = ci ? ci.lo > 0.5 || ci.hi < 0.5 : false;
        return {
          comparison_axis: a.comparison_axis,
          arm_x: a.arm_x,
          arm_y: a.arm_y,
          wins_x: a.wins_x,
          wins_y: a.wins_y,
          ties: a.ties,
          inconsistent: a.inconsistent,
          total: a.total,
          win_rate_x: winRateX,
          ci_lo: ci ? ci.lo : null,
          ci_hi: ci ? ci.hi : null,
          significant,
        };
      });

      res.json({ prompt_version: promptVersion, comparisons });
    } catch (err) {
      console.error('Failed to fetch pairwise analytics:', err);
      res.status(500).json({ error: 'Failed to fetch pairwise analytics' });
    }
  });

  // GET /admin/api/analytics/evals?weeks=12 - weekly rubric-score trend + open
  // drift alerts (ai-therapist-84).
  router.get('/admin/api/analytics/evals', requireRole('therapist', 'researcher'), async (req, res) => {
    const rawWeeks = req.query.weeks ? parseInt(String(req.query.weeks), 10) : 12;
    const weeks = Number.isFinite(rawWeeks) ? Math.min(104, Math.max(1, rawWeeks)) : 12;
    try {
      const { getEvalScoreTrend, getOpenDriftAlerts } = await import('../../db/index.js');
      const [trend, openAlerts] = await Promise.all([getEvalScoreTrend(weeks), getOpenDriftAlerts()]);
      res.json({ trend, open_alerts: openAlerts });
    } catch (err) {
      console.error('Failed to fetch eval trend analytics:', err);
      res.status(500).json({ error: 'Failed to fetch eval trend analytics' });
    }
  });

  return router;
}
