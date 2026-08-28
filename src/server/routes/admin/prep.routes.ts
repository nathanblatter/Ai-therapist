// Clinician pre-session prep digest (ai-therapist-123). Two server-selected
// tiers (docs/caseworker-portal.md section 10 item 2):
//   - therapist: full checklist incl. clinician notes + crisis history.
//   - caseworker: SUMMARIES-ONLY variant — screener deltas, engagement,
//     open escalations, latest case note (their visibility set), practice
//     status, safety-plan existence, recent AI summaries. Zero transcript
//     quotes, no therapist clinical-note content, no soap_note.
// Tier is chosen from the session role only — never from the request.
// This is deliberately a STRUCTURED, non-LLM assembly (the participant-profile
// page has a separate LLM-written brief): the checklist a clinician scans
// right before a session.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { requireClientAccess } from '../../middleware/caseload.js';
import {
  listUserAssignments,
  getUserScaleHistory,
  getRecentUserSummaries,
  getLatestClinicianNote,
  getUserPriorCrisisFlags,
  getRecentSignedNotes,
  listEscalations,
  listCaseworkerRoster,
} from '../../db/index.js';
import type { PracticeAssignment, ScaleScorePoint } from '../../db/index.js';

/** Screener deltas: latest vs previous response per scale (newest-first input). */
function computeScreenerDeltas(scaleHistory: ScaleScorePoint[]) {
  const byScale = new Map<string, { score: number; created_at: Date }[]>();
  for (const point of scaleHistory) {
    const arr = byScale.get(point.scale) ?? [];
    arr.push(point);
    byScale.set(point.scale, arr);
  }
  return Array.from(byScale.entries()).map(([scale, points]) => {
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
}

// Practice-assignment STATUS only for the caseworker tier: no description
// (therapist-authored instructions) and no completion_note (participant-
// authored free text) — the tier is summaries and signals.
function assignmentStatus(a: PracticeAssignment) {
  return {
    id: a.id,
    title: a.title,
    kind: a.kind,
    suggested_frequency: a.suggested_frequency,
    status: a.status,
    assigned_at: a.assigned_at,
    completed_at: a.completed_at,
  };
}

export default function prepRoutes(): Router {
  const router = Router();

  // GET /admin/api/users/:userId/prep - structured pre-session checklist
  router.get('/admin/api/users/:userId/prep', requireRole('therapist', 'caseworker'), requireClientAccess(), async (req, res) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: 'Invalid user id' });
      }
      const viewerId = req.session.userId!;

      if (req.session.userRole === 'caseworker') {
        // Summaries-only variant. Never calls getLatestClinicianNote /
        // getUserPriorCrisisFlags; getRecentUserSummaries never selects
        // soap_note; roster/escalation modules are the summary-tier audit
        // boundary.
        const [openAssignments, completedAssignments, scaleHistory, summaries, latestCaseNotes, openEscalations, roster] =
          await Promise.all([
            listUserAssignments(userId, { status: 'assigned', limit: 10 }),
            listUserAssignments(userId, { status: 'completed', limit: 5 }),
            getUserScaleHistory(userId, 2),
            getRecentUserSummaries(userId, 3),
            // Caseworker visibility set: case notes, shared progress notes.
            getRecentSignedNotes(userId, { userId: viewerId, role: 'caseworker' }, 1),
            // requireClientAccess already proved caseload membership; memberId
            // re-scopes anyway (defense in depth).
            listEscalations({ clientId: userId, openOnly: true, memberId: viewerId, limit: 10 }),
            listCaseworkerRoster(viewerId),
          ]);

        const rosterRow = roster.find((r) => r.client_id === userId) ?? null;
        const latestNote = latestCaseNotes[0] ?? null;

        res.json({
          tier: 'caseworker',
          open_assignments: openAssignments.map(assignmentStatus),
          completed_assignments: completedAssignments.map(assignmentStatus),
          screener_deltas: computeScreenerDeltas(scaleHistory),
          engagement: rosterRow
            ? {
                last_session_at: rosterRow.last_session_at,
                ended_session_count: rosterRow.ended_session_count,
                last_checkin_mood: rosterRow.last_checkin_mood,
              }
            : null,
          has_safety_plan: rosterRow?.has_safety_plan ?? false,
          open_escalations: openEscalations.map((e) => ({
            escalation_id: e.escalation_id,
            status: e.status,
            urgency: e.urgency,
            reason: e.reason,
            raised_by_role: e.raised_by_role,
            assigned_username: e.assigned_username,
            created_at: e.created_at,
          })),
          latest_case_note: latestNote
            ? {
                note_id: latestNote.note_id,
                note_type: latestNote.note_type,
                case_note_kind: latestNote.case_note_kind,
                author_name: latestNote.author_name,
                author_role: latestNote.author_role,
                signed_at: latestNote.signed_at,
                content: latestNote.content,
              }
            : null,
          recent_summaries: summaries.map((s) => ({
            session_id: s.session_id,
            ended_at: s.ended_at ?? s.created_at,
            summary: s.summary,
          })),
        });
        return;
      }

      const [openAssignments, completedAssignments, scaleHistory, summaries, clinicianNote, crisisFlags, recentNotes] =
        await Promise.all([
          listUserAssignments(userId, { status: 'assigned', limit: 10 }),
          listUserAssignments(userId, { status: 'completed', limit: 5 }),
          // 2 per scale = latest + previous, enough for a delta line.
          getUserScaleHistory(userId, 2),
          getRecentUserSummaries(userId, 1),
          getLatestClinicianNote(userId),
          getUserPriorCrisisFlags(userId, null, 5),
          // Signed care notes (progress + case) for the recent-notes card.
          // This branch is therapist-only, so the therapist visibility set applies.
          getRecentSignedNotes(userId, { userId: viewerId, role: 'therapist' }, 3),
        ]);

      const lastSummary = summaries[0] ?? null;

      res.json({
        tier: 'therapist',
        open_assignments: openAssignments,
        completed_assignments: completedAssignments,
        screener_deltas: computeScreenerDeltas(scaleHistory),
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
        recent_notes: recentNotes.map(n => ({
          note_id: n.note_id,
          note_type: n.note_type,
          case_note_kind: n.case_note_kind,
          author_name: n.author_name,
          author_role: n.author_role,
          signed_at: n.signed_at,
          content: n.content,
        })),
      });
    } catch (err) {
      console.error('Failed to build prep digest:', err);
      res.status(500).json({ error: 'Failed to build prep digest' });
    }
  });

  return router;
}
