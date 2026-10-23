// Export panel. Researchers get the full research export (bulk, aggregated,
// de-identified dataset). Therapists get the clinician variant
// (ai-therapist-199): one assigned client's session at a time, matching
// what export.routes.ts enforces (403 on bulk/aggregate, 404 on unassigned
// sessions). The session list itself is caseload-scoped by the server, and
// every export writes a data_access_log row.
import { useState, useEffect } from "react";
import { Download, Info } from "react-feather";
import useAuth from "../hooks/useAuth";
import { getJson, HttpError } from "../../shared/http";

interface ExportSession {
  session_id: string;
  session_name?: string | null;
}

export default function ExportPanel() {
  const [format, setFormat] = useState('json');
  const [exportType, setExportType] = useState('full'); // 'full', 'metadata', 'anonymized', 'aggregated'
  const [sessionId, setSessionId] = useState('');
  const [sessions, setSessions] = useState<ExportSession[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [aggregationPeriod, setAggregationPeriod] = useState('day'); // 'day', 'week', 'month'
  const [crisisFlaggedOnly, setCrisisFlaggedOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportWarning, setExportWarning] = useState<string | null>(null);
  const { role: userRole } = useAuth();
  // Clinician variant: single-session, no bulk/aggregate options.
  const clinician = userRole === 'therapist';

  useEffect(() => {
    const fetchSessions = async () => {
      try {
        setLoadingSessions(true);
        const data = await getJson<{ sessions?: ExportSession[] }>('/admin/api/sessions?limit=1000', { fallback: 'Failed to fetch sessions' });
        setSessions(data.sessions || []);
      } catch (err: unknown) {
        console.error('Error fetching sessions:', err);
      } finally {
        setLoadingSessions(false);
      }
    };

    fetchSessions();
  }, []);

  const checkRedactionStatus = async (sid: string): Promise<number> => {
    // A non-2xx status check never blocks the export (it has no pending
    // count); only a network failure propagates to the export handler.
    const data = await getJson<{ pendingCount?: number }>(`/admin/api/sessions/${sid}/redaction-status`)
      .catch((err: unknown) => {
        if (err instanceof HttpError) return {} as { pendingCount?: number };
        throw err;
      });
    return data.pendingCount ?? 0;
  };

  const handleExport = async () => {
    setLoading(true);
    setError(null);
    setExportWarning(null);

    try {
      if (clinician && !sessionId) {
        setError('Select a client session to export.');
        setLoading(false);
        return;
      }
      // For researchers, check redaction status if specific session selected
      if (userRole === 'researcher' && sessionId) {
        const pendingRedactions = await checkRedactionStatus(sessionId);
        if (pendingRedactions > 0) {
          setExportWarning(`${pendingRedactions} message(s) still being redacted. Please wait for redaction to complete before exporting.`);
          setLoading(false);
          return;
        }
      }

      const params = new URLSearchParams({ format, exportType });
      if (sessionId) params.append('sessionId', sessionId);
      if (startDate) params.append('startDate', startDate);
      if (endDate) params.append('endDate', endDate);
      if (exportType === 'aggregated') params.append('aggregationPeriod', aggregationPeriod);
      if (crisisFlaggedOnly) params.append('crisisFlaggedOnly', 'true');

      const response = await fetch(`/admin/api/export?${params}`);
      if (!response.ok) throw new Error('Export failed');

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;

      const filename = sessionId
        ? `session-${sessionId}-export.${format}`
        : `all-sessions-export-${new Date().toISOString().split('T')[0]}.${format}`;

      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const [dsAsOf, setDsAsOf] = useState('');
  const [dsIncludeTranscripts, setDsIncludeTranscripts] = useState(false);
  const [dsLoading, setDsLoading] = useState(false);
  const [dsError, setDsError] = useState<string | null>(null);

  const handleDatasetExport = async () => {
    setDsLoading(true);
    setDsError(null);
    try {
      const params = new URLSearchParams();
      if (dsAsOf) params.append('asOf', new Date(dsAsOf + 'T23:59:59Z').toISOString());
      if (dsIncludeTranscripts) params.append('includeTranscripts', 'true');
      const response = await fetch(`/admin/api/export/dataset?${params}`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || 'Dataset export failed');
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ai-therapist-dataset-${(dsAsOf || new Date().toISOString().split('T')[0])}.zip`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: unknown) {
      setDsError(err instanceof Error ? err.message : String(err));
    } finally {
      setDsLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold mb-6">{clinician ? 'Export client material' : 'Export Data'}</h2>

      {clinician && (
        <div className="mb-6 bg-lightBlue bg-opacity-30 border border-royal border-opacity-30 rounded-lg p-4 flex gap-3">
          <Info size={18} className="text-royal flex-shrink-0 mt-0.5" aria-hidden="true" />
          <div className="text-sm text-gray-700 space-y-1">
            <p>
              Exports are limited to sessions of clients on your caseload, one session at a time.
              Message content is included unredacted, as in the session view.
            </p>
            <p>Every export is recorded in the data access log.</p>
          </div>
        </div>
      )}

      {userRole === 'researcher' && (
        <div className="mb-6 bg-white p-6 rounded-lg shadow border border-royal border-opacity-30">
          <h3 className="text-lg font-semibold mb-1">Research dataset (de-identified)</h3>
          <p className="text-sm text-gray-600 mb-4">
            Pseudonymized CSVs + generated codebook. Demo data excluded; the same as-of date
            always produces the same bytes. No message content, usernames, or the pseudonym mapping
            are ever included.
          </p>
          <div className="space-y-4">
            <div>
              <label className="block font-medium mb-2 text-gray-700">As-of date (inclusion cutoff)</label>
              <input type="date" value={dsAsOf} onChange={(e) => setDsAsOf(e.target.value)}
                className="border rounded px-3 py-2" />
              <p className="text-sm text-gray-500 mt-1">Leave blank to use now.</p>
            </div>
            <div className="flex items-start gap-2 p-3 bg-yellow-50 border border-yellow-200 rounded">
              <input type="checkbox" id="dsIncludeTranscripts" checked={dsIncludeTranscripts}
                onChange={(e) => setDsIncludeTranscripts(e.target.checked)}
                className="w-4 h-4 mt-0.5 text-royal border-gray-300 rounded focus:ring-royal" />
              <label htmlFor="dsIncludeTranscripts" className="text-sm text-gray-700">
                Include redacted transcripts (opt-in). Adds a separate artifact with redacted turn
                text and <strong>verbatim</strong> feedback comments — handle as identifiable data.
              </label>
            </div>
            {dsError && (
              <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">Error: {dsError}</div>
            )}
            <button onClick={handleDatasetExport} disabled={dsLoading}
              className="w-full bg-royal text-white py-3 rounded-lg font-semibold hover:bg-navy transition flex items-center justify-center gap-2 disabled:opacity-50 min-h-[44px]">
              <Download size={20} aria-hidden="true" />
              {dsLoading ? 'Building dataset…' : 'Download de-identified dataset'}
            </button>
          </div>
        </div>
      )}

      <div className="bg-white p-6 rounded-lg shadow">
        <div className="space-y-4">
          <div>
            <label className="block font-medium mb-2 text-gray-700">Export Type</label>
            <select
              value={exportType}
              onChange={(e) => setExportType(e.target.value)}
              className="border rounded px-3 py-2 w-full"
            >
              <option value="full">Full Data (All messages & metadata)</option>
              <option value="metadata">Metadata Only (No messages)</option>
              <option value="anonymized">Anonymized (Research IDs only)</option>
              {!clinician && <option value="aggregated">Aggregated Statistics</option>}
            </select>
            <p className="text-sm text-gray-500 mt-1">
              {exportType === 'full' && 'Complete session data with HIPAA redaction'}
              {exportType === 'metadata' && 'Session metadata, timestamps, and statistics without message content'}
              {exportType === 'anonymized' && 'Replaces usernames with research IDs for IRB compliance'}
              {exportType === 'aggregated' && 'Temporal statistics aggregated by time period'}
            </p>
          </div>

          <div>
            <label className="block font-medium mb-2 text-gray-700">File Format</label>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              className="border rounded px-3 py-2 w-full"
            >
              <option value="json">JSON</option>
              <option value="csv">CSV</option>
              {exportType === 'aggregated' && <option value="xlsx">Excel (XLSX)</option>}
            </select>
          </div>

          {exportType === 'aggregated' && (
            <div>
              <label className="block font-medium mb-2 text-gray-700">Aggregation Period</label>
              <select
                value={aggregationPeriod}
                onChange={(e) => setAggregationPeriod(e.target.value)}
                className="border rounded px-3 py-2 w-full"
              >
                <option value="day">Daily</option>
                <option value="week">Weekly</option>
                <option value="month">Monthly</option>
              </select>
            </div>
          )}

          {!clinician && (
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="crisisFlaggedOnly"
              checked={crisisFlaggedOnly}
              onChange={(e) => setCrisisFlaggedOnly(e.target.checked)}
              className="w-4 h-4 text-royal border-gray-300 rounded focus:ring-royal"
            />
            <label htmlFor="crisisFlaggedOnly" className="text-sm text-gray-700">
              Export only crisis-flagged sessions
            </label>
          </div>
          )}

          <div>
            <label htmlFor="exportSessionId" className="block font-medium mb-2 text-gray-700">
              {clinician ? 'Client session' : 'Specific Session (Optional)'}
            </label>
            <select
              id="exportSessionId"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              className="border rounded px-3 py-2 w-full"
              disabled={loadingSessions}
              required={clinician}
            >
              <option value="">{clinician ? 'Select a session' : 'All Sessions'}</option>
              {sessions.map((session) => {
                const sessionIdShort = session.session_id.length > 12
                  ? session.session_id.substring(0, 12) + '...'
                  : session.session_id;
                const sessionNameShort = session.session_name && session.session_name.length > 30
                  ? session.session_name.substring(0, 30) + '...'
                  : session.session_name || 'Unnamed';

                return (
                  <option key={session.session_id} value={session.session_id}>
                    {sessionIdShort} - {sessionNameShort}
                  </option>
                );
              })}
            </select>
            <p className="text-sm text-gray-500 mt-1">
              {loadingSessions
                ? 'Loading sessions...'
                : clinician
                  ? 'Only sessions of clients assigned to you are listed'
                  : 'Select a session or leave as "All Sessions" to export all'}
            </p>
          </div>

          {!clinician && (
          <div>
            <label className="block font-medium mb-2 text-gray-700">
              Date Range (Optional)
            </label>
            <div className="flex gap-2">
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="border rounded px-3 py-2 flex-1"
                placeholder="Start date"
              />
              <span className="flex items-center text-gray-500">to</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="border rounded px-3 py-2 flex-1"
                placeholder="End date"
              />
            </div>
            <p className="text-sm text-gray-500 mt-1">
              Only applies when no specific session is selected
            </p>
          </div>
          )}

          {error && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
              Error: {error}
            </div>
          )}

          {exportWarning && (
            <div className="bg-yellow-100 border border-yellow-400 text-yellow-800 px-4 py-3 rounded">
              {exportWarning}
            </div>
          )}

          <button
            onClick={handleExport}
            disabled={loading || (clinician && !sessionId)}
            className="w-full bg-royal text-white py-3 rounded-lg font-semibold hover:bg-navy transition flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px]"
            aria-label={loading ? 'Exporting data' : 'Download export file'}
          >
            <Download size={20} aria-hidden="true" />
            {loading ? 'Exporting...' : 'Download Export'}
          </button>
        </div>
      </div>

      {clinician ? (
        <div className="mt-6 bg-lightBlue bg-opacity-30 border border-royal border-opacity-30 rounded-lg p-4">
          <h3 className="font-semibold mb-2">Export Information</h3>
          <ul className="text-sm space-y-1 text-gray-700">
            <li>• <strong>Full Data:</strong> every message in the session with timestamps</li>
            <li>• <strong>Metadata Only:</strong> session details without message content</li>
            <li>• <strong>Anonymized:</strong> the client's username replaced with a research ID</li>
            <li>• JSON preserves full structure; CSV opens in a spreadsheet</li>
            <li>• Signed care notes are copied or printed from the client's profile, not exported here</li>
          </ul>
        </div>
      ) : (
      <div className="mt-6 bg-lightBlue bg-opacity-30 border border-royal border-opacity-30 rounded-lg p-4">
        <h3 className="font-semibold mb-2">Export Information</h3>
        <ul className="text-sm space-y-1 text-gray-700">
          <li>• <strong>Full Data:</strong> All messages with HIPAA redaction applied</li>
          <li>• <strong>Metadata Only:</strong> Session details without message content (ideal for privacy-sensitive research)</li>
          <li>• <strong>Anonymized:</strong> Usernames replaced with research IDs (RID_001, RID_002, etc.)</li>
          <li>• <strong>Aggregated:</strong> Statistical summaries by time period (session counts, duration, crisis events)</li>
          <li>• JSON preserves full structure; CSV is suitable for statistical software (R, SPSS, etc.)</li>
          <li>• Crisis-flagged filter exports only sessions with high/medium/low risk flags</li>
          <li>• Large exports may take a few moments to process</li>
        </ul>
      </div>
      )}
    </div>
  );
}
