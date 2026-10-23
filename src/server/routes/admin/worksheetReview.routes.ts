// Worksheet review queue (ai-therapist-89): the review half of the
// generate -> review -> canon loop for personalized worksheets. Researcher-only.
//
//   GET  /admin/api/worksheets/review             queue (completed, unreviewed; no answers)
//   GET  /admin/api/worksheets/review/:id         filled instance + auto-stripped template
//   POST /admin/api/worksheets/review/:id/promote reviewer-confirmed template -> knowledge_chunks
//   POST /admin/api/worksheets/review/:id/reject  note required
//
// Privacy: the detail read exposes a participant's answers, so it is logged
// to data_access_log as 'worksheet_review'. The promoted chunk only ever holds
// the template; findParticipantContent refuses a confirmed text that still
// carries an answer. Promoted chunks land pending (active=false) like every
// other new corpus content and clear approval in the Knowledge Base tab.
import crypto from 'crypto';
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  listWorksheetInstancesForReview,
  getWorksheetInstanceForReview,
  markWorksheetRejected,
  promoteWorksheetToKnowledgeChunk,
  logDataAccess,
} from '../../db/index.js';
import { embedText } from '../../services/embeddings.service.js';
import { buildWorksheetTemplate, findParticipantContent } from '../../utils/worksheetTemplate.js';
import { parsePagination } from '../../utils/pagination.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('worksheetReviewRoutes');

const MAX_TITLE_CHARS = 200;
const MAX_CONTENT_CHARS = 20_000;
const MAX_NOTE_CHARS = 500;

function optionalText(raw: unknown, maxLen: number): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, maxLen);
  return trimmed.length ? trimmed : null;
}

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export default function worksheetReviewRoutes(): Router {
  const router = Router();
  const researcher = requireRole('researcher');

  router.get('/admin/api/worksheets/review', researcher, async (req, res) => {
    const { limit, offset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
    try {
      const { rows, total } = await listWorksheetInstancesForReview({ limit, offset });
      res.json({ instances: rows, total });
    } catch (error) {
      log.error({ err: error }, 'queue failed');
      res.status(500).json({ error: 'Failed to load the worksheet review queue' });
    }
  });

  router.get('/admin/api/worksheets/review/:id', researcher, async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'invalid id' });
    try {
      const instance = await getWorksheetInstanceForReview(id);
      if (!instance) return res.status(404).json({ error: 'worksheet instance not found' });
      // Participant answers are about to be shown: audit the read (091).
      void logDataAccess({
        accessedBy: req.session.userId ?? null,
        role: req.session.userRole ?? null,
        action: 'worksheet_review',
        sessionId: instance.session_id,
        userId: instance.user_id,
        detail: { instance_id: id },
      });
      const template = buildWorksheetTemplate({
        title: instance.title,
        sections: instance.sections,
        template_title: instance.template_title,
        template_rationale: instance.template_content,
      });
      res.json({ instance, template });
    } catch (error) {
      log.error({ err: error }, 'detail failed');
      res.status(500).json({ error: 'Failed to load the worksheet instance' });
    }
  });

  router.post('/admin/api/worksheets/review/:id/promote', researcher, async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'invalid id' });
    const reviewer = req.session.username;
    if (!reviewer) return res.status(400).json({ error: 'promotion requires an identified admin' });
    const content = optionalText(req.body?.content, MAX_CONTENT_CHARS + 1);
    if (!content) return res.status(400).json({ error: 'content (the confirmed template text) is required' });
    if (content.length > MAX_CONTENT_CHARS) {
      return res.status(400).json({ error: `content exceeds ${MAX_CONTENT_CHARS} characters` });
    }
    const note = optionalText(req.body?.note, MAX_NOTE_CHARS);
    try {
      const instance = await getWorksheetInstanceForReview(id);
      if (!instance) return res.status(404).json({ error: 'worksheet instance not found' });
      if (instance.status !== 'completed' || instance.review_status !== 'pending') {
        return res
          .status(409)
          .json({
            error: `worksheet instance is ${instance.review_status === 'pending' ? 'not completed' : instance.review_status}`,
          });
      }
      const title = optionalText(req.body?.title, MAX_TITLE_CHARS) ?? instance.title;
      const leak = findParticipantContent(`${title}\n${content}`, instance.responses);
      if (leak) {
        return res.status(422).json({
          error: `The template still contains the participant's answer to "${leak.key}". Remove it before promoting.`,
          section: leak.key,
        });
      }
      const templateMeta = (instance.template_metadata ?? {}) as { render_tool?: unknown };
      const embedding = await embedText(content);
      const result = await promoteWorksheetToKnowledgeChunk({
        instanceId: id,
        reviewer,
        note,
        title,
        content,
        content_hash: crypto.createHash('md5').update(content).digest('hex'),
        embedding,
        topic: instance.template_topic,
        metadata: {
          sections: instance.sections.map((s) => ({ type: s.type })),
          ...(typeof templateMeta.render_tool === 'string' ? { render_tool: templateMeta.render_tool } : {}),
          ...(instance.template_chunk_id !== null ? { template_chunk_id: instance.template_chunk_id } : {}),
        },
        template_kind: instance.template_chunk_id !== null ? 'vetted_template' : 'custom_worksheet',
      });
      switch (result.outcome) {
        case 'promoted':
          return res.status(201).json({ success: true, chunk_id: result.chunk_id, active: false });
        case 'already_promoted':
          return res.json({ success: true, chunk_id: result.chunk_id, already_promoted: true });
        case 'duplicate_content':
          return res.status(409).json({ error: 'Identical template text already exists in the knowledge base' });
        case 'not_pending':
          return res.status(409).json({ error: 'worksheet instance is no longer pending review' });
      }
    } catch (error) {
      log.error({ err: error }, 'promote failed');
      res.status(500).json({ error: 'Failed to promote the worksheet template' });
    }
  });

  router.post('/admin/api/worksheets/review/:id/reject', researcher, async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'invalid id' });
    const reviewer = req.session.username;
    if (!reviewer) return res.status(400).json({ error: 'rejection requires an identified admin' });
    const note = optionalText(req.body?.note, MAX_NOTE_CHARS);
    if (!note) return res.status(400).json({ error: 'note is required when rejecting' });
    try {
      const ok = await markWorksheetRejected(id, reviewer, note);
      if (!ok) return res.status(409).json({ error: 'worksheet instance not found or no longer pending review' });
      res.json({ success: true, id, review_status: 'rejected' });
    } catch (error) {
      log.error({ err: error }, 'reject failed');
      res.status(500).json({ error: 'Failed to reject the worksheet instance' });
    }
  });

  return router;
}
