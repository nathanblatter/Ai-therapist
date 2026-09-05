// Admin study-status control (IRB-claims audit fix). The withdrawal survey
// stamps study_status via the Qualtrics ingest (qualtricsSync.service), but
// StudyStatusScreen promises paused participants that the research team
// "will reopen your access" — this route is what fulfils that promise.
// Researcher-only; writes study_status_source 'admin:<username>' (the source
// shape migration 087 anticipated), so provenance of every change is durable
// on the user row (study_status_source + study_status_changed_at).
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  getUserById,
  getStudyStatusDetail,
  setStudyStatus,
  type StudyStatus,
} from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('studyStatusRoutes');

const STATUSES: StudyStatus[] = ['active', 'paused', 'withdrawn'];

export default function studyStatusRoutes(): Router {
  const router = Router();

  // GET current status + provenance. Researcher-only: the participant lists
  // that link here (/api/users, the Users tab) are researcher surfaces, and
  // the clinical profile bundle (which also carries study_status) is
  // therapist-only, so researchers need this read to see what they manage.
  router.get('/admin/api/users/:userId/study-status', requireRole('researcher'), async (req, res) => {
    const userId = parseInt(req.params.userId, 10);
    if (!Number.isFinite(userId)) return res.status(400).json({ error: 'Invalid user id' });
    try {
      const detail = await getStudyStatusDetail(userId);
      if (!detail) return res.status(404).json({ error: 'User not found' });
      res.json(detail);
    } catch (err) {
      console.error('Failed to fetch study status:', err);
      res.status(500).json({ error: 'Failed to fetch study status' });
    }
  });

  // POST status change ('active' | 'paused' | 'withdrawn'). Setting the same
  // status twice is a no-op (setStudyStatus only stamps on change), so the
  // source/changed_at provenance of the original transition is preserved.
  router.post('/admin/api/users/:userId/study-status', requireRole('researcher'), async (req, res) => {
    const userId = parseInt(req.params.userId, 10);
    if (!Number.isFinite(userId)) return res.status(400).json({ error: 'Invalid user id' });
    const status = req.body?.status as StudyStatus;
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
    }
    try {
      const user = await getUserById(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });
      const username = req.session.username ?? 'unknown';
      const changed = await setStudyStatus(userId, status, `admin:${username}`);
      if (changed) {
        // Provenance lives on the user row (study_status_source/changed_at);
        // this log line is the operational trail, like other admin mutations.
        log.info({ userId, status, actor: username }, '[study-status] admin change applied');
      }
      res.json({ success: true, study_status: status, changed });
    } catch (err) {
      console.error('Failed to update study status:', err);
      res.status(500).json({ error: 'Failed to update study status' });
    }
  });

  return router;
}
