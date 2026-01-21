import { useState, useEffect } from "react";
import { Download } from "react-feather";

export default function ExportPanel() {
  const [format, setFormat] = useState('json');
  const [exportType, setExportType] = useState('full'); // 'full', 'metadata', 'anonymized', 'aggregated'
  const [sessionId, setSessionId] = useState('');
  const [sessions, setSessions] = useState([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [aggregationPeriod, setAggregationPeriod] = useState('day'); // 'day', 'week', 'month'
  const [crisisFlaggedOnly, setCrisisFlaggedOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [exportWarning, setExportWarning] = useState(null);
  const [userRole, setUserRole] = useState(null);

  useEffect(() => {
    const fetchSessions = async () => {
      try {
        setLoadingSessions(true);
        const response = await fetch('/admin/api/sessions?limit=1000');
        if (!response.ok) throw new Error('Failed to fetch sessions');
        const data = await response.json();
        setSessions(data.sessions || []);
      } catch (err) {
        console.error('Error fetching sessions:', err);
      } finally {
        setLoadingSessions(false);
      }
    };

    const fetchUserRole = async () => {
      try {
        const response = await fetch('/api/auth/status', { credentials: 'include' });
        if (response.ok) {
          const data = await response.json();
          setUserRole(data.role);
        }
      } catch (err) {
        console.error('Failed to fetch user role:', err);
      }
    };

    fetchSessions();
    fetchUserRole();
  }, []);

  const checkRedactionStatus = async (sessionId) => {
    const response = await fetch(`/admin/api/sessions/${sessionId}/redaction-status`, {
      credentials: 'include'
    });
    const data = await response.json();
    return data.pendingCount;
  };

  const handleExport = async () => {
    setLoading(true);
    setError(null);
    setExportWarning(null);

    try {
      // For researchers, check redaction status if specific session selected
      if (userRole === 'researcher' && sessionId) {
        const pendingRedactions = await checkRedactionStatus(sessionId);
        if (pendingRedactions > 0) {
          setExportWarning(`⏳ ${pendingRedactions} message(s) still being redacted. Please wait for redaction to complete before exporting.`);
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
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold mb-6">Export Data</h2>

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
              <option value="aggregated">Aggregated Statistics</option>
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

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="crisisFlaggedOnly"
              checked={crisisFlaggedOnly}
              onChange={(e) => setCrisisFlaggedOnly(e.target.checked)}
              className="w-4 h-4 text-byuRoyal border-gray-300 rounded focus:ring-byuRoyal"
            />
            <label htmlFor="crisisFlaggedOnly" className="text-sm text-gray-700">
              Export only crisis-flagged sessions
            </label>
          </div>

          <div>
            <label className="block font-medium mb-2 text-gray-700">
              Specific Session (Optional)
            </label>
            <select
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              className="border rounded px-3 py-2 w-full"
              disabled={loadingSessions}
            >
              <option value="">All Sessions</option>
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
              {loadingSessions ? 'Loading sessions...' : 'Select a session or leave as "All Sessions" to export all'}
            </p>
          </div>

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
            disabled={loading}
            className="w-full bg-byuRoyal text-white py-3 rounded-lg font-semibold hover:bg-byuNavy transition flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px]"
            aria-label={loading ? 'Exporting data' : 'Download export file'}
          >
            <Download size={20} aria-hidden="true" />
            {loading ? 'Exporting...' : 'Download Export'}
          </button>
        </div>
      </div>

      <div className="mt-6 bg-byuLightBlue bg-opacity-30 border border-byuRoyal border-opacity-30 rounded-lg p-4">
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
    </div>
  );
}
