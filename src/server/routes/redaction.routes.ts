import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('redaction');

export default function redactionRoutes() {
  const router = Router();

  // GET /redact/api/messages
  router.get("/redact/api/messages", requireRole('researcher'), asyncHandler(async (req, res) => {
    const result = await pool.query(`
      SELECT message_id, content_redacted, role, message_type, created_at
      FROM messages
      WHERE content_redacted IS NOT NULL AND role IN ('user', 'assistant')
      ORDER BY RANDOM()
      LIMIT 20
    `);
    res.json({ messages: result.rows });
  }));

  // PUT /redact/api/messages/:id
  router.put("/redact/api/messages/:id", requireRole('researcher'), asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { content_redacted } = req.body;

    if (content_redacted === undefined) {
      return res.status(400).json({ error: "content_redacted field is required" });
    }

    const result = await pool.query(
      'UPDATE messages SET content_redacted = $1 WHERE message_id = $2 RETURNING message_id',
      [content_redacted, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Message not found" });
    }

    res.json({ success: true });
  }));

  return router;
}
