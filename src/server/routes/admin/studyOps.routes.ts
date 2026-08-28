// Study-operations dashboard API (ai-therapist-98). Enrollment / arm-balance /
// sessions-per-participant metrics, protocol-deviation CRUD, the anomaly scan,
// and editable protocol targets. Researcher-only, except the read-only summary
// which therapists may also view.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  getStudyOpsSummary,
  listDeviations,
  createDeviation,
  updateDeviation,
  deleteDeviation,
  scanForDeviations,
} from '../../db/index.js';
import { updateSystemConfig } from '../../db/config.queries.js';
import { parsePagination } from '../../utils/pagination.js';

const MANUAL_CATEGORIES = ['technical_failure', 'enrollment', 'procedure', 'other'];
const ALL_CATEGORIES = [
  'config_change_mid_study', 'arm_imbalance', 'session_limit_exceeded', 'consent_version_change',
  ...MANUAL_CATEGORIES,
];
const SEVERITIES = ['minor', 'major'];
const STATUSES = ['open', 'acknowledged', 'resolved', 'dismissed'];

export default function studyOpsRoutes(): Router {
  const router = Router();

  // GET summary — researcher + therapist (read-only).
  router.get('/admin/api/study-ops/summary', requireRole('researcher', 'therapist'), async (_req, res) => {
    try {
      res.json(await getStudyOpsSummary());
    } catch (err) {
      console.error('Failed to fetch study-ops summary:', err);
      res.status(500).json({ error: 'Failed to fetch study-ops summary' });
    }
  });

  // GET deviations.
  router.get('/admin/api/study-ops/deviations', requireRole('researcher'), async (req, res) => {
    const status = req.query.status === 'all' ? 'all' : 'open';
    const { limit } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 500 });
    try {
      res.json({ deviations: await listDeviations(status, limit) });
    } catch (err) {
      console.error('Failed to fetch deviations:', err);
      res.status(500).json({ error: 'Failed to fetch deviations' });
    }
  });

  // POST deviation (manual).
  router.post('/admin/api/study-ops/deviations', requireRole('researcher'), async (req, res) => {
    const { occurred_at, category, severity, session_id, description } = req.body ?? {};
    if (!MANUAL_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${MANUAL_CATEGORIES.join(', ')}` });
    }
    if (severity !== undefined && !SEVERITIES.includes(severity)) {
      return res.status(400).json({ error: 'severity must be minor or major' });
    }
    if (typeof description !== 'string' || description.trim().length === 0) {
      return res.status(400).json({ error: 'description is required' });
    }
    try {
      const row = await createDeviation({
        occurred_at: occurred_at ?? null, category, severity,
        session_id: session_id ?? null, description, created_by: req.session.username!,
      });
      res.status(201).json({ deviation: row });
    } catch (err) {
      console.error('Failed to create deviation:', err);
      res.status(500).json({ error: 'Failed to create deviation' });
    }
  });

  // PATCH deviation.
  router.patch('/admin/api/study-ops/deviations/:id', requireRole('researcher'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const { status, description, severity } = req.body ?? {};
    if (status !== undefined && !STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
    }
    if (severity !== undefined && !SEVERITIES.includes(severity)) {
      return res.status(400).json({ error: 'severity must be minor or major' });
    }
    try {
      const row = await updateDeviation(id, { status, description, severity }, req.session.username!);
      if (!row) return res.status(404).json({ error: 'deviation not found' });
      res.json({ deviation: row });
    } catch (err) {
      console.error('Failed to update deviation:', err);
      res.status(500).json({ error: 'Failed to update deviation' });
    }
  });

  // DELETE deviation (manual rows only).
  router.delete('/admin/api/study-ops/deviations/:id', requireRole('researcher'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    try {
      const ok = await deleteDeviation(id);
      if (!ok) return res.status(404).json({ error: 'deviation not found or not deletable (auto-flagged rows cannot be deleted)' });
      res.json({ success: true });
    } catch (err) {
      console.error('Failed to delete deviation:', err);
      res.status(500).json({ error: 'Failed to delete deviation' });
    }
  });

  // POST scan — run the anomaly auto-flag pass now.
  router.post('/admin/api/study-ops/scan', requireRole('researcher'), async (_req, res) => {
    try {
      const { inserted } = await scanForDeviations();
      res.json({ success: true, inserted });
    } catch (err) {
      console.error('Failed to run deviation scan:', err);
      res.status(500).json({ error: 'Failed to run deviation scan' });
    }
  });

  // PUT protocol — update study_protocol targets.
  router.put('/admin/api/study-ops/protocol', requireRole('researcher'), async (req, res) => {
    const b = req.body ?? {};
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
    if (!num(b.enrollment_target) || b.enrollment_target < 1) {
      return res.status(400).json({ error: 'enrollment_target must be a positive number' });
    }
    if (!num(b.expected_sessions_per_participant) || b.expected_sessions_per_participant < 1) {
      return res.status(400).json({ error: 'expected_sessions_per_participant must be a positive number' });
    }
    if (!num(b.arm_imbalance_threshold) || b.arm_imbalance_threshold < 0 || b.arm_imbalance_threshold > 1) {
      return res.status(400).json({ error: 'arm_imbalance_threshold must be between 0 and 1' });
    }
    const isoOrNull = (v: unknown) => v == null || (typeof v === 'string' && !isNaN(new Date(v).getTime()));
    if (!isoOrNull(b.study_start) || !isoOrNull(b.study_end)) {
      return res.status(400).json({ error: 'study_start/study_end must be ISO dates or null' });
    }
    const value = {
      enrollment_target: b.enrollment_target,
      expected_sessions_per_participant: b.expected_sessions_per_participant,
      study_start: b.study_start ?? null,
      study_end: b.study_end ?? null,
      arm_imbalance_threshold: b.arm_imbalance_threshold,
    };
    try {
      const row = await updateSystemConfig('study_protocol', value, req.session.username);
      if (!row) return res.status(404).json({ error: 'study_protocol config missing (run migration 053)' });
      res.json({ success: true, protocol: row.config_value });
    } catch (err) {
      console.error('Failed to update study protocol:', err);
      res.status(500).json({ error: 'Failed to update study protocol' });
    }
  });

  return router;
}
