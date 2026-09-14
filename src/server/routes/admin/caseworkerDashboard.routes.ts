// Caseworker triage dashboard API (caseworker portal, spec section 3).
// Summaries tier only: everything served here comes from
// caseworkerDashboard.queries.ts, the audited transcript-free module (the
// messages table is never joined there). "Needs attention" ranking is
// computed here in TS with explainable {code, label, points} reasons;
// point values/thresholds are overridable via system_config key
// 'attention_ranking'.
import { Router } from 'express';
import OpenAI from 'openai';
import { requireRole } from '../../middleware/auth.js';
import { requireClientAccess } from '../../middleware/caseload.js';
import { orgIdFor } from '../../middleware/org.js';
import { getOpenAIKey } from '../../config/secrets.js';
import {
  listCaseworkerRoster,
  getRosterClientDetail,
  getClientEngagementSignals,
  countUnreadByClientForMember,
  getSystemConfigByKey,
  getAllUsers,
  getUserById,
  recordLlmUsage,
  type RosterRow,
  type RosterClientDetail,
  type ClientEngagementSignals,
} from '../../db/index.js';
import { isCareTeamRole } from '../../../shared/roles.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('caseworkerDashboard');

export interface AttentionReason {
  code: string;
  label: string;
  points: number;
}

export interface AttentionRankingConfig {
  crisis_open: number;
  risk_high: number;
  escalation_open: number;
  inactive: number;
  unread_messages: number;
  mood_low: number;
  practice_overdue: number;
  inactivity_days: number;
  low_mood_threshold: number;
}

// Spec section 3 defaults. risk_rising / screener_worsening / mood_drop need
// history the one-round-trip roster row doesn't carry; the daily sweep covers
// screener trends via screener_worsening work items instead.
export const DEFAULT_ATTENTION_RANKING: AttentionRankingConfig = {
  crisis_open: 100,
  risk_high: 60,
  escalation_open: 50,
  inactive: 25,
  unread_messages: 20,
  mood_low: 15,
  practice_overdue: 10,
  inactivity_days: 14,
  low_mood_threshold: 3,
};

async function loadRankingConfig(): Promise<AttentionRankingConfig> {
  try {
    const row = await getSystemConfigByKey('attention_ranking');
    const value = row?.config_value;
    if (value && typeof value === 'object') {
      return { ...DEFAULT_ATTENTION_RANKING, ...(value as Partial<AttentionRankingConfig>) };
    }
  } catch (err) {
    log.error({ err }, 'Failed to load attention_ranking config; using defaults');
  }
  return DEFAULT_ATTENTION_RANKING;
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  return (Date.now() - then) / (24 * 60 * 60 * 1000);
}

/** Explainable needs-attention score for one roster row. */
export function computeAttention(
  row: RosterRow,
  unreadCount: number,
  config: AttentionRankingConfig = DEFAULT_ATTENTION_RANKING
): { score: number; reasons: AttentionReason[] } {
  const reasons: AttentionReason[] = [];
  if (row.open_crisis_count > 0) {
    reasons.push({ code: 'crisis_open', label: 'Open crisis flag', points: config.crisis_open });
  }
  if (row.latest_risk_severity === 'high') {
    reasons.push({ code: 'risk_high', label: 'High risk score', points: config.risk_high });
  }
  if (row.open_escalation_count > 0) {
    reasons.push({ code: 'escalation_open', label: 'Open escalation', points: config.escalation_open });
  }
  const idleDays = daysSince(row.last_session_at);
  if (row.ended_session_count > 0 && idleDays !== null && idleDays >= config.inactivity_days) {
    reasons.push({
      code: 'inactive',
      label: `No session in ${config.inactivity_days}+ days`,
      points: config.inactive,
    });
  }
  if (unreadCount > 0) {
    reasons.push({ code: 'unread_messages', label: 'Unread messages', points: config.unread_messages });
  }
  if (row.last_checkin_mood !== null && row.last_checkin_mood <= config.low_mood_threshold) {
    reasons.push({ code: 'mood_low', label: 'Low check-in mood', points: config.mood_low });
  }
  if (row.overdue_practice_count > 0) {
    reasons.push({ code: 'practice_overdue', label: 'Overdue practice', points: config.practice_overdue });
  }
  return { score: reasons.reduce((sum, r) => sum + r.points, 0), reasons };
}

// ---------------------------------------------------------------------------
// Catch-up summary (ai-therapist-229): a short LLM paragraph catching a
// caseworker up on a client, composed STRICTLY from summaries-tier data (the
// caseworkerDashboard.queries audit boundary — AI session summaries, screener
// scores, risk severities, check-in moods, counts). Never transcripts, never
// SOAP notes. Same in-memory cache + fail-soft pattern as the therapist-only
// brief in participantProfile.routes.ts.
// ---------------------------------------------------------------------------

const CATCHUP_MODEL = 'gpt-4o-mini';
const CATCHUP_SYSTEM_PROMPT =
  'You are a documentation assistant for an AI-assisted therapy research study. ' +
  'Write a single short paragraph (3-5 sentences, plain prose, no lists, no headings) catching a ' +
  'care coordinator up on this participant: how they seem to be doing overall, what changed ' +
  'recently, and anything worth keeping an eye on. Descriptive and non-diagnostic; never invent ' +
  'facts beyond the data given; never include names or identifying details.';

let openaiClient: OpenAI | null = null;
async function getClient(): Promise<OpenAI> {
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: await getOpenAIKey() });
  return openaiClient;
}

// Repeat views are free; a new ended session (new latest summary) regenerates.
const catchupCache = new Map<number, { key: string; summary: string }>();
/** Test hook: reset the module-level catch-up cache. */
export function _clearCatchupCache(): void {
  catchupCache.clear();
}

/** Compact, deterministic prompt context from summaries-tier data only. */
export function composeCatchupContext(
  detail: RosterClientDetail,
  engagement: ClientEngagementSignals
): string {
  const lines: string[] = [];
  lines.push(`Completed sessions: ${engagement.ended_session_count}`);
  if (engagement.last_session_at) lines.push(`Last session: ${engagement.last_session_at}`);

  for (const row of detail.recent_summaries.slice(0, 3)) {
    const s = (row.summary ?? {}) as Record<string, unknown>;
    lines.push(
      `Session (${row.ended_at ?? 'date unknown'}): ${String(s.headline ?? '')}. ` +
      `Topics: ${Array.isArray(s.topics) ? s.topics.join(', ') : 'n/a'}. ` +
      `Mood trajectory: ${String(s.mood_trajectory ?? 'n/a')}.` +
      (s.follow_up ? ` Open follow-up: ${String(s.follow_up)}` : '')
    );
  }

  // Screener deltas: latest vs previous score per scale (history is newest-first).
  const byScale = new Map<string, { score: number; created_at: string }[]>();
  for (const p of detail.scale_history) {
    const arr = byScale.get(p.scale) ?? [];
    arr.push(p);
    byScale.set(p.scale, arr);
  }
  for (const [scale, points] of byScale) {
    const [latest, prev] = points;
    lines.push(
      `${scale.toUpperCase()} latest: ${latest.score}` +
      (prev ? ` (previous ${prev.score}, delta ${latest.score - prev.score})` : '')
    );
  }

  const [latestRisk, prevRisk] = detail.risk_history;
  if (latestRisk) {
    lines.push(
      `Risk severity latest: ${latestRisk.severity ?? 'unknown'} (${latestRisk.calculated_at})` +
      (prevRisk ? `, previous: ${prevRisk.severity ?? 'unknown'}` : '')
    );
  }

  const moods = detail.mood_history
    .filter((m) => m.mood !== null)
    .slice(0, 3)
    .reverse()
    .map((m) => m.mood);
  if (moods.length >= 2) lines.push(`Check-in mood (1-10), oldest to newest: ${moods.join(' -> ')}`);

  if (engagement.open_crisis_count > 0) lines.push(`Open crisis flags: ${engagement.open_crisis_count}`);
  if (engagement.open_escalation_count > 0) lines.push(`Open escalations: ${engagement.open_escalation_count}`);
  if (engagement.has_safety_plan) lines.push('A safety plan is on file.');

  return lines.join('\n');
}

async function buildRoster(memberId: number, config: AttentionRankingConfig) {
  const [rows, unread] = await Promise.all([
    listCaseworkerRoster(memberId),
    countUnreadByClientForMember(memberId),
  ]);
  const unreadByClient = new Map(unread.map((u) => [u.client_id, u.unread_count]));
  return rows
    .map((row) => {
      const unreadCount = unreadByClient.get(row.client_id) ?? 0;
      const attention = computeAttention(row, unreadCount, config);
      return { ...row, unread_count: unreadCount, attention };
    })
    .sort(
      (a, b) =>
        b.attention.score - a.attention.score || a.username.localeCompare(b.username)
    );
}

export default function caseworkerDashboardRoutes(): Router {
  const router = Router();

  // GET /admin/api/caseworker/roster
  // Care-team member: own roster, attention-ranked. Researcher: org overview,
  // one roster block per care-team member in the org.
  router.get(
    '/admin/api/caseworker/roster',
    requireRole('caseworker', 'therapist', 'researcher'),
    async (req, res) => {
      try {
        const config = await loadRankingConfig();
        if (isCareTeamRole(req.session.userRole)) {
          const clients = await buildRoster(req.session.userId!, config);
          return res.json({ clients, generated_at: new Date().toISOString() });
        }
        const orgId = await orgIdFor(req);
        const users = await getAllUsers(null, orgId ?? undefined);
        const members = users.filter((u) => isCareTeamRole(u.role));
        const rosters = await Promise.all(
          members.map(async (member) => ({
            member_id: member.userid,
            username: member.username,
            member_role: member.role,
            clients: await buildRoster(member.userid, config),
          }))
        );
        res.json({
          members: rosters.filter((r) => r.clients.length > 0),
          generated_at: new Date().toISOString(),
        });
      } catch (err) {
        log.error({ err }, 'Failed to build roster');
        res.status(500).json({ error: 'Failed to build roster' });
      }
    }
  );

  // GET /admin/api/caseworker/roster/:userId/detail — summary-tier drill-down
  // (requireClientAccess keeps 404-over-403 for care-team members).
  router.get(
    '/admin/api/caseworker/roster/:userId/detail',
    requireRole('caseworker', 'therapist', 'researcher'),
    requireClientAccess(),
    async (req, res) => {
      const clientId = Number(req.params.userId);
      if (!Number.isInteger(clientId)) return res.status(400).json({ error: 'Invalid user id' });
      try {
        // Researchers are org-scoped (C13): 404 for clients outside their
        // organization (same check requireEscalationAccess applies).
        if (!isCareTeamRole(req.session.userRole)) {
          const orgId = await orgIdFor(req);
          // Fail closed: a null org must never widen a researcher read to
          // unscoped (unreachable today under the orgIdFor contract, but this
          // was the one permissive null-handling branch left in the portal).
          if (orgId === null) return res.status(404).json({ error: 'Not found' });
          const target = await getUserById(clientId);
          if (!target || target.organization_id !== orgId) {
            return res.status(404).json({ error: 'Not found' });
          }
        }
        const detail = await getRosterClientDetail(clientId);
        res.json({ client_id: clientId, ...detail });
      } catch (err) {
        log.error({ err, clientId }, 'Failed to load roster client detail');
        res.status(500).json({ error: 'Failed to load client detail' });
      }
    }
  );

  // GET /admin/api/caseworker/roster/:userId/catchup — the "catch up on this
  // person" bundle (ai-therapist-229): engagement/flag signals plus a short
  // AI-written rollup paragraph. Summaries tier throughout, so caseworkers
  // (the requesting audience) are first-class. Fail-soft on the LLM: any
  // generation failure still returns the signals with summary null.
  router.get(
    '/admin/api/caseworker/roster/:userId/catchup',
    requireRole('caseworker', 'therapist', 'researcher'),
    requireClientAccess(),
    async (req, res) => {
      const clientId = Number(req.params.userId);
      if (!Number.isInteger(clientId)) return res.status(400).json({ error: 'Invalid user id' });
      try {
        // Same researcher org-scoping (C13) as the detail route above.
        if (!isCareTeamRole(req.session.userRole)) {
          const orgId = await orgIdFor(req);
          if (orgId === null) return res.status(404).json({ error: 'Not found' });
          const target = await getUserById(clientId);
          if (!target || target.organization_id !== orgId) {
            return res.status(404).json({ error: 'Not found' });
          }
        }

        const [detail, engagement] = await Promise.all([
          getRosterClientDetail(clientId),
          getClientEngagementSignals(clientId),
        ]);

        const base = { client_id: clientId, engagement, generated_at: new Date().toISOString() };
        if (engagement.ended_session_count === 0 && detail.recent_summaries.length === 0) {
          return res.json({ ...base, summary: null });
        }

        const latestSummarySessionId = detail.recent_summaries[0]?.session_id ?? null;
        const cacheKey = `${latestSummarySessionId ?? 'none'}:${engagement.ended_session_count}`;
        const cached = catchupCache.get(clientId);
        if (cached && cached.key === cacheKey) {
          return res.json({ ...base, summary: cached.summary, cached: true });
        }

        let summary: string | null = null;
        try {
          const client = await getClient();
          const response = await client.chat.completions.create({
            model: CATCHUP_MODEL,
            temperature: 0.3,
            max_tokens: 200,
            messages: [
              { role: 'system', content: CATCHUP_SYSTEM_PROMPT },
              { role: 'user', content: composeCatchupContext(detail, engagement) },
            ],
          });
          // Cost tracking: same best-effort pattern as the profile brief;
          // attributed to the latest summarized session (purpose 'insights').
          recordLlmUsage(
            latestSummarySessionId, 'insights', CATCHUP_MODEL,
            response.usage?.prompt_tokens ?? null, response.usage?.completion_tokens ?? null,
          ).catch(() => { /* recordLlmUsage already swallows; belt and braces */ });
          summary = response.choices[0]?.message?.content?.trim() || null;
          if (summary) catchupCache.set(clientId, { key: cacheKey, summary });
        } catch (err) {
          log.error({ err, clientId }, 'Catch-up summary generation failed (fail-soft)');
        }

        res.json({ ...base, summary });
      } catch (err) {
        log.error({ err, clientId }, 'Failed to build catch-up');
        res.status(500).json({ error: 'Failed to build catch-up' });
      }
    }
  );

  return router;
}
