// Participant profile admin API (ai-therapist-110): the per-user drill-down
// behind the admin "View profile" page.
//   - GET /admin/api/users/:userId/profile  — the same memory/clinical bundle
//     that is injected into the AI prompt (therapist-only: unredacted clinical
//     content, same rule as the session-insights routes).
//   - GET /admin/api/users/:userId/sessions — that user's session history with
//     eval score + feedback rating (therapist or researcher, like the main
//     session browser).
//   - GET /admin/api/users/:userId/brief — a short AI "since last review"
//     paragraph composed from the bundle (ai-therapist-122). Therapist-only,
//     cached in-memory per (userId, latest session id), fail-soft.
import { Router } from 'express';
import OpenAI from 'openai';
import { requireRole } from '../../middleware/auth.js';
import { requireClientAccess, careTeamScopeId } from '../../middleware/caseload.js';
import { orgIdFor } from '../../middleware/org.js';
import { getOpenAIKey } from '../../config/secrets.js';
import { parsePagination } from '../../utils/pagination.js';
import {
  getUserById,
  getUserProfileBundle,
  getSessionScoreExtras,
  listSessions,
  countSessions,
  recordLlmUsage,
} from '../../db/index.js';

const BRIEF_MODEL = 'gpt-4o-mini';
const BRIEF_SYSTEM_PROMPT =
  'You are a clinical documentation assistant for an AI-assisted therapy research study. ' +
  'Write a single short paragraph (3-5 sentences, plain prose, no lists, no headings) briefing a ' +
  'clinician on this participant before their next session: how they are doing, what changed ' +
  'recently, and anything to know going in. Descriptive and non-diagnostic; never invent facts ' +
  'beyond the data given; never include names or identifying details.';

let openaiClient: OpenAI | null = null;
async function getClient(): Promise<OpenAI> {
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: await getOpenAIKey() });
  return openaiClient;
}

// In-memory brief cache: repeat views are free; a new ended session (new
// latest summary) invalidates. Nothing is persisted.
const briefCache = new Map<number, { key: string; brief: string }>();
/** Test hook: reset the module-level brief cache. */
export function _clearBriefCache(): void {
  briefCache.clear();
}

type Bundle = Awaited<ReturnType<typeof getUserProfileBundle>>;

/** Compact, deterministic prompt context from the profile bundle. */
function composeBriefContext(bundle: Bundle): string {
  const lines: string[] = [];
  lines.push(`Completed sessions: ${bundle.ended_session_count}`);

  for (const row of bundle.summaries.slice(0, 2)) {
    const s = row.summary as Record<string, unknown>;
    lines.push(
      `Session (${row.ended_at ?? row.created_at}): ${String(s.headline ?? '')}. ` +
      `Topics: ${Array.isArray(s.topics) ? s.topics.join(', ') : 'n/a'}. ` +
      `Mood trajectory: ${String(s.mood_trajectory ?? 'n/a')}.` +
      (s.follow_up ? ` Open follow-up: ${String(s.follow_up)}` : '')
    );
  }

  // Screener deltas: latest vs previous score per scale.
  const byScale = new Map<string, { score: number; created_at: Date }[]>();
  for (const p of bundle.scale_history) {
    const arr = byScale.get(p.scale) ?? [];
    arr.push({ score: p.score, created_at: p.created_at });
    byScale.set(p.scale, arr);
  }
  for (const [scale, points] of byScale) {
    points.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const [latest, prev] = points;
    lines.push(
      `${scale.toUpperCase()} latest: ${latest.score}` +
      (prev ? ` (previous ${prev.score}, delta ${latest.score - prev.score})` : '')
    );
  }

  const moods = [...bundle.mood_trajectory]
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .map(m => m.mood);
  if (moods.length >= 2) {
    const recent = moods.slice(-3);
    const dir = recent[recent.length - 1] - recent[0];
    lines.push(`Mood (1-10) recent readings: ${recent.join(' -> ')} (${dir > 0 ? 'up' : dir < 0 ? 'down' : 'flat'})`);
  }

  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  for (const f of bundle.prior_crisis_flags) {
    if (new Date(f.flagged_at).getTime() >= cutoff) {
      lines.push(
        `Crisis flag ${f.flagged_at} severity ${f.severity ?? 'unknown'}: ` +
        (f.unflagged_at ? `resolved ${f.unflagged_at}` : 'UNRESOLVED')
      );
    }
  }

  return lines.join('\n');
}

export default function participantProfileRoutes(): Router {
  const router = Router();

  // GET /admin/api/users/:userId/profile - full memory/clinical bundle
  router.get('/admin/api/users/:userId/profile', requireRole('therapist'), requireClientAccess(), async (req, res) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      if (!Number.isFinite(userId)) return res.status(400).json({ error: 'Invalid user id' });

      const user = await getUserById(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const bundle = await getUserProfileBundle(userId);
      res.json({
        user: {
          userid: user.userid,
          username: user.username,
          role: user.role,
          preferred_voice: user.preferred_voice ?? null,
          preferred_language: user.preferred_language ?? null,
          mfa_enabled: user.mfa_enabled ?? false,
          study_status: user.study_status ?? 'active',
          created_at: user.created_at ?? null,
        },
        ...bundle,
      });
    } catch (err) {
      console.error('Failed to fetch participant profile:', err);
      res.status(500).json({ error: 'Failed to fetch participant profile' });
    }
  });

  // GET /admin/api/users/:userId/brief - short AI "since last review"
  // paragraph (ai-therapist-122). Therapist-only like the profile bundle.
  // Fail-soft by design: any LLM/composition failure returns { brief: null }
  // so the profile page never blocks on this.
  router.get('/admin/api/users/:userId/brief', requireRole('therapist'), requireClientAccess(), async (req, res) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      if (!Number.isFinite(userId)) return res.status(400).json({ error: 'Invalid user id' });

      const user = await getUserById(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const bundle = await getUserProfileBundle(userId);
      if (bundle.ended_session_count === 0 && bundle.summaries.length === 0) {
        return res.json({ brief: null });
      }

      // Cache key: the latest session we know about. A newly ended session
      // (new summary / higher count) changes the key and regenerates.
      const cacheKey = `${bundle.summaries[0]?.session_id ?? 'none'}:${bundle.ended_session_count}`;
      const cached = briefCache.get(userId);
      if (cached && cached.key === cacheKey) {
        return res.json({ brief: cached.brief, cached: true });
      }

      const client = await getClient();
      const response = await client.chat.completions.create({
        model: BRIEF_MODEL,
        temperature: 0.3,
        max_tokens: 200,
        messages: [
          { role: 'system', content: BRIEF_SYSTEM_PROMPT },
          { role: 'user', content: composeBriefContext(bundle) },
        ],
      });

      // Cost tracking: same best-effort pattern as sessionInsights. Attribute
      // to the latest session (purpose 'insights' — no new purpose enum).
      recordLlmUsage(
        bundle.summaries[0]?.session_id ?? null, 'insights', BRIEF_MODEL,
        response.usage?.prompt_tokens ?? null, response.usage?.completion_tokens ?? null,
      ).catch(() => { /* recordLlmUsage already swallows; belt and braces */ });

      const brief = response.choices[0]?.message?.content?.trim() || null;
      if (brief) briefCache.set(userId, { key: cacheKey, brief });
      res.json({ brief });
    } catch (err) {
      console.error('Failed to generate participant brief (fail-soft):', err);
      res.json({ brief: null });
    }
  });

  // GET /admin/api/users/:userId/sessions - per-user session history.
  // Caseworker-allowed (summaries tier): rows are session metadata/aggregates
  // only, and requireClientAccess row-scopes to the member's caseload.
  router.get('/admin/api/users/:userId/sessions', requireRole('therapist', 'researcher', 'caseworker'), requireClientAccess(), async (req, res) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      if (!Number.isFinite(userId)) return res.status(400).json({ error: 'Invalid user id' });

      const { page: pageNum, limit: limitNum } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });
      const filters = {
        search: null,
        startDate: null,
        endDate: null,
        minMessages: null,
        maxMessages: null,
        limit: limitNum,
        offset: (pageNum - 1) * limitNum,
        voices: null,
        languages: null,
        durations: null,
        sessionTypes: null,
        statuses: null,
        endedBy: null,
        crisisFlagged: null,
        crisisSeverity: null,
        userId,
      };

      // Same scoping as the main session browser (sessions.routes.ts):
      // care-team members are caseload-scoped; researchers are org-scoped
      // (C13) so another org's participant history reads as empty.
      const scope = await careTeamScopeId(req);
      const orgId = scope === null ? await orgIdFor(req) : null;
      const [sessions, totalCount] = await Promise.all([
        listSessions(filters, scope, orgId),
        countSessions(filters, scope, orgId),
      ]);

      const extras = await getSessionScoreExtras(sessions.map(s => String(s.session_id)));
      const extrasById = new Map(extras.map(e => [e.session_id, e]));
      const enriched = sessions.map(s => ({
        ...s,
        eval_score: extrasById.get(String(s.session_id))?.eval_score ?? null,
        feedback_rating: extrasById.get(String(s.session_id))?.feedback_rating ?? null,
      }));

      res.json({
        sessions: enriched,
        pagination: { page: pageNum, limit: limitNum, totalCount },
      });
    } catch (err) {
      console.error('Failed to fetch participant sessions:', err);
      res.status(500).json({ error: 'Failed to fetch participant sessions' });
    }
  });

  return router;
}
