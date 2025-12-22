import { useState } from "react";
import { Download } from "react-feather";

export default function ExportPanel() {
  const [format, setFormat] = useState('json');
  const [sessionId, setSessionId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleExport = async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ format });
      if (sessionId) params.append('sessionId', sessionId);
      if (startDate) params.append('startDate', startDate);
      if (endDate) params.append('endDate', endDate);

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
            <label className="block font-medium mb-2 text-gray-700">Export Format</label>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              className="border rounded px-3 py-2 w-full"
            >
              <option value="json">JSON</option>
              <option value="csv">CSV</option>
            </select>
          </div>

          <div>
            <label className="block font-medium mb-2 text-gray-700">
              Specific Session (Optional)
            </label>
            <input
              type="text"
              placeholder="sess_abc123..."
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              className="border rounded px-3 py-2 w-full"
            />
            <p className="text-sm text-gray-500 mt-1">
              Leave empty to export all sessions
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

          <button
            onClick={handleExport}
            disabled={loading}
            className="w-full bg-byuRoyal text-white py-3 rounded-lg font-semibold hover:bg-byuNavy transition flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download size={20} />
            {loading ? 'Exporting...' : 'Download Export'}
          </button>
        </div>
      </div>

      <div className="mt-6 bg-byuLightBlue bg-opacity-30 border border-byuRoyal border-opacity-30 rounded-lg p-4">
        <h3 className="font-semibold mb-2">Export Information</h3>
        <ul className="text-sm space-y-1 text-gray-700">
          <li>• All exported data is HIPAA-redacted</li>
          <li>• JSON format preserves full data structure including metadata</li>
          <li>• CSV format is suitable for spreadsheet analysis</li>
          <li>• Large exports may take a few moments to process</li>
        </ul>
      </div>
    </div>
  );
}
