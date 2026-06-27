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

  return router;
}
