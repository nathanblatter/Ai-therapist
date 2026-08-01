// Research-data export API (therapist/researcher). Selects the export query by
// type, then serialises the rows as JSON or CSV with a download filename. The
// SQL lives in db/export.queries.ts.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  getMetadataExport,
  getAnonymizedExport,
  getAggregatedExport,
  getFullExport,
  type ExportRow,
  type ExportContentColumn,
  type ExportFilters,
} from '../../db/index.js';
import { buildDataset, streamDatasetZip } from '../../services/datasetExport.service.js';

// Serialise rows to CSV using the given header order; quote/escape every cell.
function toCsv(headers: string[], rows: ExportRow[]): string {
  const csvRows = [headers.join(',')];
  rows.forEach(row => {
    const values = headers.map(header => {
      const value = row[header];
      if (value === null || value === undefined) return '';
      if (typeof value === 'object') return JSON.stringify(value).replace(/"/g, '""');
      return `"${String(value).replace(/"/g, '""')}"`;
    });
    csvRows.push(values.join(','));
  });
  return csvRows.join('\n');
}

export default function exportRoutes(): Router {
  const router = Router();

  // GET /admin/api/export - export data as JSON or CSV with research options
  router.get('/admin/api/export', requireRole('therapist', 'researcher'), async (req, res) => {
    const {
      format = 'json',
      exportType = 'full',
      sessionId,
      startDate,
      endDate,
      aggregationPeriod = 'day',
      crisisFlaggedOnly = 'false',
    } = req.query;

    try {
      // Therapists may export raw content; everyone else gets redacted content.
      const contentColumn: ExportContentColumn = req.session.userRole === 'therapist' ? 'content' : 'content_redacted';
      const filters: ExportFilters = {
        sessionId: sessionId ? String(sessionId) : null,
        startDate: startDate ? String(startDate) : null,
        endDate: endDate ? String(endDate) : null,
        crisisOnly: crisisFlaggedOnly === 'true',
      };

      let rows: ExportRow[];
      if (exportType === 'metadata') {
        rows = await getMetadataExport(filters);
      } else if (exportType === 'anonymized') {
        rows = await getAnonymizedExport(filters, contentColumn);
      } else if (exportType === 'aggregated') {
        rows = await getAggregatedExport(filters, String(aggregationPeriod));
      } else {
        rows = await getFullExport(filters, contentColumn);
      }

      const dateStamp = new Date().toISOString().split('T')[0];

      if (format === 'csv') {
        // Single-session full exports omit session_name/username columns.
        const headers = sessionId
          ? ['id', 'session_id', 'role', 'message_type', 'message', 'extras', 'created_at']
          : ['id', 'session_id', 'session_name', 'username', 'role', 'message_type', 'message', 'extras', 'created_at'];
        const filename = sessionId
          ? `session-${sessionId}-export.csv`
          : `all-sessions-export-${dateStamp}.csv`;

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(toCsv(headers, rows));
      } else {
        const filename = sessionId
          ? `session-${sessionId}-export.json`
          : `all-sessions-export-${dateStamp}.json`;

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.json(rows);
      }
    } catch (err) {
      console.error('Failed to export data:', err);
      res.status(500).json({ error: 'Failed to export data' });
    }
  });

  // GET /admin/api/export/dataset?asOf=<iso>&includeTranscripts=true|false
  // De-identified research dataset (ai-therapist-96). Researcher ONLY: the raw
  // content export above already serves therapists; this pseudonymized artifact
  // is a researcher deliverable. Streams a zip built by datasetExport.service.
  router.get('/admin/api/export/dataset', requireRole('researcher'), async (req, res) => {
    const asOf = req.query.asOf ? String(req.query.asOf) : new Date().toISOString();
    if (isNaN(new Date(asOf).getTime())) {
      return res.status(400).json({ error: 'asOf must be an ISO-8601 timestamp' });
    }
    const includeTranscripts = req.query.includeTranscripts === 'true';

    try {
      const result = await buildDataset(asOf, { includeTranscripts });
      const dateStamp = asOf.slice(0, 10);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="ai-therapist-dataset-${dateStamp}.zip"`);
      await streamDatasetZip(result, res);
    } catch (err) {
      console.error('Failed to export dataset:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to export dataset' });
      else res.end();
    }
  });

  return router;
}
