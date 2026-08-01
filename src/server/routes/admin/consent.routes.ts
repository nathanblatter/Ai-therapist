// Admin API for managing versioned IRB consent documents (ai-therapist-94).
// Reads are therapist/researcher; publishing a new version is researcher-only
// (it's a study-governance action). Publishing a version with an immediate
// effective_at re-consents every participant (their stored consentVersion goes
// stale, so requireConsent 412s until they re-accept).
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  listConsentDocuments,
  getConsentDocumentByVersion,
  insertConsentDocument,
  getActiveConsentDocument,
} from '../../db/index.js';
import { getActiveConsent, invalidateConsentCache, sha256Hex } from '../../utils/consent.js';

export default function adminConsentRoutes(): Router {
  const router = Router();
  const canRead = requireRole('therapist', 'researcher');
  const canWrite = requireRole('researcher');

  // List all versions (with acceptance counts) + which one is currently active.
  router.get('/admin/api/consent/versions', canRead, async (_req, res) => {
    try {
      const [versions, active] = await Promise.all([listConsentDocuments(), getActiveConsent()]);
      res.json({ versions, activeVersion: active.version });
    } catch (err) {
      console.error('[Consent] list versions failed:', err);
      res.status(500).json({ error: 'Failed to load consent versions' });
    }
  });

  // Full body for a single version (preview).
  router.get('/admin/api/consent/versions/:version', canRead, async (req, res) => {
    try {
      const doc = await getConsentDocumentByVersion(req.params.version);
      if (!doc) return res.status(404).json({ error: 'version not found' });
      res.json(doc);
    } catch (err) {
      console.error('[Consent] get version failed:', err);
      res.status(500).json({ error: 'Failed to load consent version' });
    }
  });

  // Publish a new consent version.
  router.post('/admin/api/consent/versions', canWrite, async (req, res) => {
    const version = typeof req.body?.version === 'string' ? req.body.version.trim() : '';
    const body = typeof req.body?.body === 'string' ? req.body.body : '';
    const effectiveAtRaw = typeof req.body?.effectiveAt === 'string' ? req.body.effectiveAt : null;

    if (!version) return res.status(400).json({ error: 'version is required' });
    if (version.length > 32) return res.status(400).json({ error: 'version must be <= 32 chars' });
    if (!body.trim()) return res.status(400).json({ error: 'body is required' });

    let effectiveAt: Date | null = null;
    if (effectiveAtRaw) {
      const d = new Date(effectiveAtRaw);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'effectiveAt is not a valid date' });
      effectiveAt = d;
    }

    const publishedBy = req.session.username;
    if (!publishedBy) return res.status(400).json({ error: 'publishing requires an identified admin' });

    try {
      const doc = await insertConsentDocument({
        version,
        body,
        bodyHash: sha256Hex(body),
        effectiveAt,
        publishedBy,
      });
      // Bust the active-consent cache so requireConsent / status pick this up
      // immediately (relevant when effectiveAt is now or in the past).
      invalidateConsentCache();
      const active = await getActiveConsentDocument();
      res.status(201).json({ success: true, document: doc, activeVersion: active?.version ?? doc.version });
    } catch (err) {
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        return res.status(409).json({ error: 'version already exists' });
      }
      console.error('[Consent] publish version failed:', err);
      res.status(500).json({ error: 'Failed to publish consent version' });
    }
  });

  return router;
}
