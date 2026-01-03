import { useState, useEffect } from 'react';
import { Save, RotateCcw, AlertCircle, CheckCircle } from 'react-feather';

export default function SystemConfig() {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(null);
  const [hasChanges, setHasChanges] = useState(false);

  // Local state for form fields
  const [crisisContact, setCrisisContact] = useState({
    hotline: '',
    phone: '',
    text: '',
    enabled: true
  });

  const [sessionLimits, setSessionLimits] = useState({
    max_duration_minutes: 60,
    max_sessions_per_day: 3,
    cooldown_minutes: 30,
    enabled: false
  });

  const [features, setFeatures] = useState({
    voice_enabled: true,
    chat_enabled: true,
    file_upload_enabled: false,
    session_recording_enabled: false
  });

  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/admin/api/config');
      if (!response.ok) throw new Error('Failed to fetch configuration');

      const data = await response.json();
      setConfig(data);

      // Populate form fields
      if (data.crisis_contact) {
        setCrisisContact(data.crisis_contact.value);
      }
      if (data.session_limits) {
        setSessionLimits(data.session_limits.value);
      }
      if (data.features) {
        setFeatures(data.features.value);
      }

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
      // Save crisis contact
      const crisisResponse = await fetch('/admin/api/config/crisis_contact', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: crisisContact })
      });
      if (!crisisResponse.ok) throw new Error('Failed to save crisis contact');

      // Save session limits
      const limitsResponse = await fetch('/admin/api/config/session_limits', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: sessionLimits })
      });
      if (!limitsResponse.ok) throw new Error('Failed to save session limits');

      // Save features
      const featuresResponse = await fetch('/admin/api/config/features', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: features })
      });
      if (!featuresResponse.ok) throw new Error('Failed to save features');

      setSaveSuccess('Configuration saved successfully!');
      setHasChanges(false);

      // Refresh config to get updated timestamps
      await fetchConfig();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (window.confirm('Are you sure you want to reset to the last saved configuration?')) {
      fetchConfig();
    }
  };

  const updateCrisisContact = (field, value) => {
    setCrisisContact(prev => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  const updateSessionLimits = (field, value) => {
    setSessionLimits(prev => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  const updateFeatures = (field, value) => {
    setFeatures(prev => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-gray-500">Loading configuration...</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-900">System Configuration</h2>
        <div className="flex gap-2">
          <button
            onClick={handleReset}
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

      {/* Crisis Contact Configuration */}
      <div className="mb-6 bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Crisis Contact Information</h3>
        <p className="text-sm text-gray-600 mb-4">
          This information is displayed to users in the AI's initial message and when crisis keywords are detected.
        </p>

        <div className="space-y-4">
          <div className="flex items-center gap-2 mb-4">
            <input
              type="checkbox"
              id="crisis-enabled"
              checked={crisisContact.enabled}
              onChange={(e) => updateCrisisContact('enabled', e.target.checked)}
              className="w-4 h-4 text-byuRoyal border-gray-300 rounded focus:ring-byuRoyal"
            />
            <label htmlFor="crisis-enabled" className="text-sm font-medium text-gray-700">
              Display crisis information to users
            </label>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Hotline Name
            </label>
            <input
              type="text"
              value={crisisContact.hotline}
              onChange={(e) => updateCrisisContact('hotline', e.target.value)}
              placeholder="BYU Counseling and Psychological Services"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-byuRoyal"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Phone Number
            </label>
            <input
              type="text"
              value={crisisContact.phone}
              onChange={(e) => updateCrisisContact('phone', e.target.value)}
              placeholder="(801) 422-3035"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-byuRoyal"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Crisis Text Line (optional)
            </label>
            <input
              type="text"
              value={crisisContact.text}
              onChange={(e) => updateCrisisContact('text', e.target.value)}
              placeholder="Text HELLO to 741741"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-byuRoyal"
            />
          </div>
        </div>
      </div>

      {/* Session Limits Configuration */}
      <div className="mb-6 bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Session Limits</h3>
        <p className="text-sm text-gray-600 mb-4">
          Control session duration and frequency to prevent overuse or fatigue.
        </p>

        <div className="space-y-4">
          <div className="flex items-center gap-2 mb-4">
            <input
              type="checkbox"
              id="limits-enabled"
              checked={sessionLimits.enabled}
              onChange={(e) => updateSessionLimits('enabled', e.target.checked)}
              className="w-4 h-4 text-byuRoyal border-gray-300 rounded focus:ring-byuRoyal"
            />
            <label htmlFor="limits-enabled" className="text-sm font-medium text-gray-700">
              Enable session limits
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Max Duration (minutes)
              </label>
              <input
                type="number"
                value={sessionLimits.max_duration_minutes}
                onChange={(e) => updateSessionLimits('max_duration_minutes', parseInt(e.target.value))}
                min="5"
                max="180"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-byuRoyal"
              />
              <p className="text-xs text-gray-500 mt-1">Sessions will auto-end after this time</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Max Sessions/Day
              </label>
              <input
                type="number"
                value={sessionLimits.max_sessions_per_day}
                onChange={(e) => updateSessionLimits('max_sessions_per_day', parseInt(e.target.value))}
                min="1"
                max="20"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-byuRoyal"
              />
              <p className="text-xs text-gray-500 mt-1">Per user, per day</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Cooldown (minutes)
              </label>
              <input
                type="number"
                value={sessionLimits.cooldown_minutes}
                onChange={(e) => updateSessionLimits('cooldown_minutes', parseInt(e.target.value))}
                min="0"
                max="1440"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-byuRoyal"
              />
              <p className="text-xs text-gray-500 mt-1">Wait time between sessions</p>
            </div>
          </div>
        </div>
      </div>

      {/* Feature Flags Configuration */}
      <div className="mb-6 bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Feature Flags</h3>
        <p className="text-sm text-gray-600 mb-4">
          Enable or disable specific features for all users.
        </p>

        <div className="space-y-3">
          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
            <div>
              <p className="font-medium text-gray-900">Voice Chat</p>
              <p className="text-xs text-gray-600">Allow users to speak with the AI using voice</p>
            </div>
            <input
              type="checkbox"
              checked={features.voice_enabled}
              onChange={(e) => updateFeatures('voice_enabled', e.target.checked)}
              className="w-4 h-4 text-byuRoyal border-gray-300 rounded focus:ring-byuRoyal"
            />
          </div>

          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
            <div>
              <p className="font-medium text-gray-900">Text Chat</p>
              <p className="text-xs text-gray-600">Allow users to type messages to the AI</p>
            </div>
            <input
              type="checkbox"
              checked={features.chat_enabled}
              onChange={(e) => updateFeatures('chat_enabled', e.target.checked)}
              className="w-4 h-4 text-byuRoyal border-gray-300 rounded focus:ring-byuRoyal"
            />
          </div>

          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
            <div>
              <p className="font-medium text-gray-900">File Upload</p>
              <p className="text-xs text-gray-600">Allow users to upload files during sessions</p>
            </div>
            <input
              type="checkbox"
              checked={features.file_upload_enabled}
              onChange={(e) => updateFeatures('file_upload_enabled', e.target.checked)}
              className="w-4 h-4 text-byuRoyal border-gray-300 rounded focus:ring-byuRoyal"
            />
          </div>

          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
            <div>
              <p className="font-medium text-gray-900">Session Recording</p>
              <p className="text-xs text-gray-600">Record audio of voice sessions for review</p>
            </div>
            <input
              type="checkbox"
              checked={features.session_recording_enabled}
              onChange={(e) => updateFeatures('session_recording_enabled', e.target.checked)}
              className="w-4 h-4 text-byuRoyal border-gray-300 rounded focus:ring-byuRoyal"
            />
          </div>
        </div>
      </div>

      {config && (
        <div className="text-xs text-gray-500 mt-6">
          Last updated: {config.crisis_contact?.updated_at ? new Date(config.crisis_contact.updated_at).toLocaleString() : 'Never'}
          {config.crisis_contact?.updated_by && ` by ${config.crisis_contact.updated_by}`}
        </div>
      )}
    </div>
  );
}
