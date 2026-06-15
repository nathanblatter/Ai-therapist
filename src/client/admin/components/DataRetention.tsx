import { useState, useEffect } from 'react';
import { Save, RotateCcw, AlertCircle, CheckCircle, Trash2, Clock, Shield, RefreshCw, AlertTriangle } from 'react-feather';

export default function DataRetention() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saveSuccess, setSaveSuccess] = useState(null);
  const [saving, setSaving] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // Data from server
  const [stats, setStats] = useState(null);
  const [recentWipes, setRecentWipes] = useState([]);
  const [scheduler, setScheduler] = useState(null);

  // Editable settings
  const [settings, setSettings] = useState({
    enabled: true,
    retention_hours: 24,
    wipe_time: '03:00',
    require_redaction_complete: true,
    last_wipe_at: null,
    last_wipe_count: 0
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/admin/api/content-retention');
      if (!response.ok) throw new Error('Failed to fetch retention data');

      const data = await response.json();
      setSettings(data.settings);
      setStats(data.stats);
      setRecentWipes(data.recent_wipes || []);
      setScheduler(data.scheduler);
      setHasChanges(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaveSuccess(null);

    try {
      const response = await fetch('/admin/api/content-retention', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save settings');
      }

      setSaveSuccess('Settings saved successfully!');
      setHasChanges(false);
      await fetchData();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleWipeNow = async () => {
    if (!window.confirm(
      'Are you sure you want to wipe original content now?\n\n' +
      'This will permanently delete original message content for all messages ' +
      `older than ${settings.retention_hours} hours that have been redacted.\n\n` +
      'This action cannot be undone.'
    )) {
      return;
    }

    setWiping(true);
    setError(null);

    try {
      const response = await fetch('/admin/api/content-retention/wipe', {
        method: 'POST'
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Wipe failed');
      }

      const data = await response.json();
      setSaveSuccess(`Wipe completed: ${data.messagesWiped} messages wiped, ${data.messagesSkipped} skipped`);
      await fetchData();
    } catch (err) {
      setError(err.message);
    } finally {
      setWiping(false);
    }
  };

  const updateSetting = (key, value) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-gray-500">Loading retention settings...</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Data Retention & Content Wipe</h2>
          <p className="text-sm text-gray-600 mt-1">
            Automated deletion of original message content for IRB compliance
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={fetchData}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => fetchData()}
            disabled={!hasChanges || saving}
            className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RotateCcw size={16} />
            Reset
          </button>
          <button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            className="flex items-center gap-2 px-4 py-2 bg-byuRoyal text-white rounded-lg hover:bg-byuNavy transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Save size={16} />
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
          <AlertCircle className="text-red-600 flex-shrink-0 mt-0.5" size={20} />
          <div>
            <p className="text-red-800 font-semibold">Error</p>
            <p className="text-red-700 text-sm">{error}</p>
          </div>
        </div>
      )}

      {saveSuccess && (
        <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg flex items-start gap-3">
          <CheckCircle className="text-green-600 flex-shrink-0 mt-0.5" size={20} />
          <div>
            <p className="text-green-800 font-semibold">Success</p>
            <p className="text-green-700 text-sm">{saveSuccess}</p>
          </div>
        </div>
      )}

      {/* Status Overview */}
      <div className="mb-6 grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center gap-2 text-gray-600 mb-1">
            <Shield size={16} />
            <span className="text-xs font-medium uppercase">Scheduler</span>
          </div>
          <p className={`text-lg font-bold ${settings.enabled ? 'text-green-600' : 'text-gray-400'}`}>
            {settings.enabled ? 'Active' : 'Disabled'}
          </p>
          {scheduler?.nextScheduledWipe && settings.enabled && (
            <p className="text-xs text-gray-500 mt-1">
              Next: {formatDate(scheduler.nextScheduledWipe)}
            </p>
          )}
        </div>

        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center gap-2 text-gray-600 mb-1">
            <Trash2 size={16} />
            <span className="text-xs font-medium uppercase">Ready to Wipe</span>
          </div>
          <p className="text-lg font-bold text-orange-600">
            {stats?.pending_wipe || 0}
          </p>
          <p className="text-xs text-gray-500 mt-1">messages eligible</p>
        </div>

        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center gap-2 text-gray-600 mb-1">
            <Clock size={16} />
            <span className="text-xs font-medium uppercase">Awaiting Redaction</span>
          </div>
          <p className="text-lg font-bold text-blue-600">
            {stats?.awaiting_redaction || 0}
          </p>
          <p className="text-xs text-gray-500 mt-1">in redaction queue</p>
        </div>

        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center gap-2 text-gray-600 mb-1">
            <AlertTriangle size={16} />
            <span className="text-xs font-medium uppercase">With Errors</span>
          </div>
          <p className={`text-lg font-bold ${stats?.redaction_errors > 0 ? 'text-red-600' : 'text-gray-400'}`}>
            {stats?.redaction_errors || 0}
          </p>
          <p className="text-xs text-gray-500 mt-1">need attention</p>
        </div>
      </div>

      {/* IRB Compliance Notice */}
      <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
        <div className="flex items-start gap-3">
          <Shield className="text-blue-600 flex-shrink-0 mt-0.5" size={20} />
          <div>
            <p className="text-blue-800 font-semibold">IRB Compliance</p>
            <p className="text-blue-700 text-sm mt-1">
              This system automatically deletes original message content after the retention period,
              leaving only the redacted (anonymized) content. This ensures PII is not retained
              longer than necessary for clinical purposes.
            </p>
          </div>
        </div>
      </div>

      {/* Settings */}
      <div className="mb-6 bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Retention Settings</h3>

        <div className="space-y-6">
          {/* Enable/Disable */}
          <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
            <div>
              <p className="font-medium text-gray-900">Enable Automated Content Wipe</p>
              <p className="text-xs text-gray-600 mt-1">
                When enabled, original message content is automatically deleted on schedule
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(e) => updateSetting('enabled', e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-byuRoyal"></div>
            </label>
          </div>

          {/* Retention Period */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Retention Period (Hours)
            </label>
            <div className="flex items-center gap-4">
              <input
                type="number"
                value={settings.retention_hours}
                onChange={(e) => updateSetting('retention_hours', parseInt(e.target.value) || 24)}
                min="1"
                max="8760"
                className="w-32 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-byuRoyal"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => updateSetting('retention_hours', 24)}
                  className={`px-3 py-1 text-sm rounded ${settings.retention_hours === 24 ? 'bg-byuRoyal text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                >
                  24h
                </button>
                <button
                  onClick={() => updateSetting('retention_hours', 48)}
                  className={`px-3 py-1 text-sm rounded ${settings.retention_hours === 48 ? 'bg-byuRoyal text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                >
                  48h
                </button>
                <button
                  onClick={() => updateSetting('retention_hours', 72)}
                  className={`px-3 py-1 text-sm rounded ${settings.retention_hours === 72 ? 'bg-byuRoyal text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                >
                  72h
                </button>
                <button
                  onClick={() => updateSetting('retention_hours', 168)}
                  className={`px-3 py-1 text-sm rounded ${settings.retention_hours === 168 ? 'bg-byuRoyal text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                >
                  1 week
                </button>
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Original content is deleted after this many hours (only if redaction is complete)
            </p>
          </div>

          {/* Wipe Time */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Daily Wipe Time
            </label>
            <input
              type="time"
              value={settings.wipe_time}
              onChange={(e) => updateSetting('wipe_time', e.target.value)}
              className="w-32 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-byuRoyal"
            />
            <p className="text-xs text-gray-500 mt-1">
              Automated wipe runs daily at this time (server timezone)
            </p>
          </div>

          {/* Require Redaction Complete */}
          <div className="flex items-center justify-between p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
            <div>
              <p className="font-medium text-gray-900">Require Redaction Complete</p>
              <p className="text-xs text-gray-600 mt-1">
                Only wipe content after AI redaction has completed successfully.
                <strong className="text-yellow-700"> Strongly recommended.</strong>
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={settings.require_redaction_complete}
                onChange={(e) => updateSetting('require_redaction_complete', e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-yellow-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-yellow-500"></div>
            </label>
          </div>
        </div>
      </div>

      {/* Manual Wipe */}
      <div className="mb-6 bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Manual Content Wipe</h3>
        <p className="text-sm text-gray-600 mb-4">
          Trigger an immediate content wipe using current settings. This will delete original
          content for all eligible messages (older than {settings.retention_hours} hours with completed redaction).
        </p>

        <div className="flex items-center gap-4">
          <button
            onClick={handleWipeNow}
            disabled={wiping || (stats?.pending_wipe === 0)}
            className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Trash2 size={16} />
            {wiping ? 'Wiping...' : `Wipe Now (${stats?.pending_wipe || 0} messages)`}
          </button>

          {stats?.pending_wipe === 0 && (
            <span className="text-sm text-gray-500">No messages eligible for wipe</span>
          )}
        </div>

        {settings.last_wipe_at && (
          <p className="text-xs text-gray-500 mt-4">
            Last wipe: {formatDate(settings.last_wipe_at)} ({settings.last_wipe_count} messages)
          </p>
        )}
      </div>

      {/* Wipe History */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Wipe History (Audit Log)</h3>

        {recentWipes.length === 0 ? (
          <p className="text-sm text-gray-500">No wipe operations recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Time</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Triggered By</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Wiped</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Skipped</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Retention</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {recentWipes.map((wipe) => (
                  <tr key={wipe.wipe_id}>
                    <td className="px-4 py-2 text-sm text-gray-900">
                      {formatDate(wipe.started_at)}
                    </td>
                    <td className="px-4 py-2 text-sm text-gray-600">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        wipe.triggered_by === 'manual' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'
                      }`}>
                        {wipe.triggered_by}
                      </span>
                      {wipe.triggered_by_user && (
                        <span className="ml-1 text-gray-500">({wipe.triggered_by_user})</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-sm">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        wipe.status === 'completed' ? 'bg-green-100 text-green-800' :
                        wipe.status === 'failed' ? 'bg-red-100 text-red-800' :
                        'bg-yellow-100 text-yellow-800'
                      }`}>
                        {wipe.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-sm text-gray-900 font-medium">
                      {wipe.messages_wiped}
                    </td>
                    <td className="px-4 py-2 text-sm text-gray-500">
                      {wipe.messages_skipped}
                    </td>
                    <td className="px-4 py-2 text-sm text-gray-500">
                      {wipe.retention_hours}h
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
