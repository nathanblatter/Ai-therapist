// Caseworker triage dashboard API (caseworker portal, spec section 3).
// Summaries tier only: everything served here comes from
// caseworkerDashboard.queries.ts, the audited transcript-free module (the
// messages table is never joined there). "Needs attention" ranking is
// computed here in TS with explainable {code, label, points} reasons;
// point values/thresholds are overridable via system_config key
// 'attention_ranking'.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { requireClientAccess } from '../../middleware/caseload.js';
import { orgIdFor } from '../../middleware/org.js';
import {
  listCaseworkerRoster,
  getRosterClientDetail,
  countUnreadByClientForMember,
  getSystemConfigByKey,
  getAllUsers,
  getUserById,
  type RosterRow,
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
          if (orgId !== null) {
            const target = await getUserById(clientId);
            if (!target || target.organization_id !== orgId) {
              return res.status(404).json({ error: 'Not found' });
            }
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

  return router;
}
