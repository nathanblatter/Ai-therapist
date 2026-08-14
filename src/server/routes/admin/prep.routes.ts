// Clinician pre-session prep digest (ai-therapist-123). Therapist-only —
// it surfaces clinician notes and crisis history. This is deliberately a
// STRUCTURED, non-LLM assembly (the participant-profile page has a separate
// LLM-written brief): the checklist a clinician scans right before a session.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  listUserAssignments,
  getUserScaleHistory,
  getRecentUserSummaries,
  getLatestClinicianNote,
  getUserPriorCrisisFlags,
} from '../../db/index.js';

export default function prepRoutes(): Router {
  const router = Router();

  // GET /admin/api/users/:userId/prep - structured pre-session checklist
  router.get('/admin/api/users/:userId/prep', requireRole('therapist'), async (req, res) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: 'Invalid user id' });
      }

      const [openAssignments, completedAssignments, scaleHistory, summaries, clinicianNote, crisisFlags] =
        await Promise.all([
          listUserAssignments(userId, { status: 'assigned', limit: 10 }),
          listUserAssignments(userId, { status: 'completed', limit: 5 }),
          // 2 per scale = latest + previous, enough for a delta line.
          getUserScaleHistory(userId, 2),
          getRecentUserSummaries(userId, 1),
          getLatestClinicianNote(userId),
          getUserPriorCrisisFlags(userId, null, 5),
        ]);

      // Screener deltas: latest vs previous response per scale.
      const byScale = new Map<string, { score: number; created_at: Date }[]>();
      for (const point of scaleHistory) {
        const arr = byScale.get(point.scale) ?? [];
        arr.push(point);
        byScale.set(point.scale, arr);
      }
      const screener_deltas = Array.from(byScale.entries()).map(([scale, points]) => {
        const [latest, previous] = points; // newest-first, at most 2
        const delta = previous ? latest.score - previous.score : null;
        return {
          scale,
          latest_score: latest.score,
          latest_at: latest.created_at,
          previous_score: previous?.score ?? null,
          delta,
          direction: delta === null ? null : delta > 0 ? 'up' : delta < 0 ? 'down' : 'unchanged',
        };
      });

      const lastSummary = summaries[0] ?? null;

      res.json({
        open_assignments: openAssignments,
        completed_assignments: completedAssignments,
        screener_deltas,
        clinician_note: clinicianNote,
        last_session: lastSummary
          ? {
              session_id: lastSummary.session_id,
              ended_at: lastSummary.ended_at ?? lastSummary.created_at,
              headline: lastSummary.summary.headline ?? null,
              follow_up: lastSummary.summary.follow_up ?? null,
            }
          : null,
        recent_crisis_flags: crisisFlags,
      });
    } catch (err) {
      console.error('Failed to build prep digest:', err);
      res.status(500).json({ error: 'Failed to build prep digest' });
    }
  });

  return router;
}
