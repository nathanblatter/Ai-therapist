// Admin curation API for the RAG knowledge base (the Knowledge Base tab).
// Reads are therapist/researcher; mutations (approve/unapprove/delete) are
// researcher-only, matching the rest of the config-write surface. Retrieval
// only ever returns active chunks, so this is where content gets promoted.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  listKnowledgeChunks,
  setKnowledgeChunkActive,
  deleteKnowledgeChunk,
  approveKnowledgeChunks,
  getKnowledgeStatusCounts,
} from '../../db/index.js';

export default function knowledgeRoutes(): Router {
  const router = Router();
  const canRead = requireRole('therapist', 'researcher');
  const canWrite = requireRole('researcher');

  // List chunks + status counts, optionally filtered by kind and status.
  router.get('/admin/api/knowledge', canRead, async (req, res) => {
    const kind = typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : null;
    const status = req.query.status;
    const active = status === 'active' ? true : status === 'pending' ? false : null;
    try {
      const [counts, chunks] = await Promise.all([
        getKnowledgeStatusCounts(),
        listKnowledgeChunks({ kind, active }),
      ]);
      res.json({ counts, chunks });
    } catch (error) {
      console.error('[Knowledge] list failed:', error);
      res.status(500).json({ error: 'Failed to load knowledge base' });
    }
  });

  // Approve / unapprove a single chunk.
  router.post('/admin/api/knowledge/:id/active', canWrite, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const active = req.body?.active === true;
    try {
      const ok = await setKnowledgeChunkActive(id, active);
      if (!ok) return res.status(404).json({ error: 'chunk not found' });
      res.json({ success: true, id, active });
    } catch (error) {
      console.error('[Knowledge] set active failed:', error);
      res.status(500).json({ error: 'Failed to update chunk' });
    }
  });

  // Bulk approve all pending, optionally scoped to a kind and/or topic.
  router.post('/admin/api/knowledge/approve', canWrite, async (req, res) => {
    const kind = typeof req.body?.kind === 'string' && req.body.kind ? req.body.kind : null;
    const topic = typeof req.body?.topic === 'string' && req.body.topic ? req.body.topic : null;
    try {
      const approved = await approveKnowledgeChunks({ kind, topic });
      res.json({ success: true, approved });
    } catch (error) {
      console.error('[Knowledge] bulk approve failed:', error);
      res.status(500).json({ error: 'Failed to approve chunks' });
    }
  });

  // Permanently delete a chunk.
  router.delete('/admin/api/knowledge/:id', canWrite, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    try {
      const ok = await deleteKnowledgeChunk(id);
      if (!ok) return res.status(404).json({ error: 'chunk not found' });
      res.json({ success: true });
    } catch (error) {
      console.error('[Knowledge] delete failed:', error);
      res.status(500).json({ error: 'Failed to delete chunk' });
    }
  });

  return router;
}
