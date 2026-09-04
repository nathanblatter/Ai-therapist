// Participant-facing survey schedule (ai-therapist-149): which Qualtrics
// surveys are due for the logged-in participant, with personalized links.
// Backed by surveySchedule.service.ts; empty/disabled for staff accounts and
// anyone not enrolled through the baseline survey.
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { getParticipantSurveySchedule } from '../../services/surveySchedule.service.js';

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

  return router;
}
