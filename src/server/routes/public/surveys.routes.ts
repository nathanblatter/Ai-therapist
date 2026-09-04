// Participant-facing survey schedule (ai-therapist-149): which Qualtrics
// surveys are due for the logged-in participant, with personalized links.
// Backed by surveySchedule.service.ts; empty/disabled for staff accounts and
// anyone not enrolled through the baseline survey.
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { getParticipantSurveySchedule, buildSurveyUrl } from '../../services/surveySchedule.service.js';
import { getQualtricsSyncConfig } from '../../services/qualtricsSync.service.js';
import { getStudyStatus } from '../../db/studyStatus.queries.js';

export default function surveysRoutes(): Router {
  const router = Router();

  router.get('/api/surveys/due', requireAuth, async (req, res) => {
    try {
      if (req.session.userRole !== 'participant') {
        res.json({ enrolled: false, studyWeek: null, due: [] });
        return;
      }
      res.json(await getParticipantSurveySchedule(req.session.userId!));
    } catch (err) {
      console.error('[Surveys] failed to compute due surveys:', err);
      res.status(500).json({ error: 'Failed to load survey schedule' });
    }
  });

  // Personalized link to the withdrawal/pause survey (Profile page). The
  // survey id stays server-side; the link carries ?sid= so the response
  // auto-links on sync and study status updates without a typed ID.
  router.get('/api/me/withdrawal-link', requireAuth, async (req, res) => {
    try {
      if (req.session.userRole !== 'participant') {
        res.json({ available: false });
        return;
      }
      const config = getQualtricsSyncConfig();
      if (!config?.surveys.withdrawal) {
        res.json({ available: false });
        return;
      }
      const studyStatus = await getStudyStatus(req.session.userId!);
      res.json({
        available: true,
        url: buildSurveyUrl(config.datacenter, config.surveys.withdrawal, req.session.userId!),
        studyStatus,
      });
    } catch (err) {
      console.error('[Surveys] failed to build withdrawal link:', err);
      res.status(500).json({ error: 'Failed to load withdrawal link' });
    }
  });

  return router;
}
