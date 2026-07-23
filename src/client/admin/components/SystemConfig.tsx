import { useState, useEffect } from 'react';
import { Save, RotateCcw, AlertCircle, CheckCircle } from 'react-feather';

interface CrisisContact {
  hotline: string;
  phone: string;
  text: string;
  enabled: boolean;
}

interface SessionLimits {
  max_duration_minutes: number;
  max_sessions_per_day: number;
  cooldown_minutes: number;
  enabled: boolean;
}

interface Features {
  voice_enabled: boolean;
  chat_enabled: boolean;
  file_upload_enabled: boolean;
  session_recording_enabled: boolean;
  output_modalities: string[];
  /** AI tools removed from new sessions (ai-therapist-32). */
  disabled_tools?: string[];
}

interface AiToolInfo {
  name: string;
  description: string;
  enabled: boolean;
  invocations: number;
  sessions: number;
  last_used: string | null;
}

interface AiModel {
  model: string;
  description: string;
}

interface ClientLogging {
  enabled: boolean;
}

interface VoiceEntry {
  value: string;
  label: string;
  description?: string;
  enabled: boolean;
}

interface LanguageEntry {
  value: string;
  label: string;
  description?: string;
  systemPromptAddition?: string;
  enabled: boolean;
}

interface VoicesConfig {
  voices: VoiceEntry[];
  default_voice: string;
}

interface LanguagesConfig {
  languages: LanguageEntry[];
  default_language: string;
}

interface ConfigEntry<T> {
  value: T;
  updated_at?: string;
  updated_by?: string;
}

interface SystemConfigData {
  crisis_contact?: ConfigEntry<CrisisContact>;
  session_limits?: ConfigEntry<SessionLimits>;
  features?: ConfigEntry<Features>;
  ai_model?: ConfigEntry<AiModel>;
  transcription_model?: ConfigEntry<AiModel>;
  client_logging?: ConfigEntry<ClientLogging>;
  voices?: ConfigEntry<VoicesConfig>;
  languages?: ConfigEntry<LanguagesConfig>;
}

// Latest OpenAI Realtime + transcription models, offered as a good/cheap pair
// each. Kept in sync with the migration 030 defaults and the server fallbacks
// in db/stats.queries.ts.
const REALTIME_MODEL_OPTIONS = [
  { model: 'gpt-realtime-2.1-mini', tier: 'Cheaper', description: 'Latest cost-effective realtime model' },
  { model: 'gpt-realtime-2.1', tier: 'Best quality', description: 'Latest highest-quality realtime model' },
];

const TRANSCRIPTION_MODEL_OPTIONS = [
  { model: 'gpt-4o-mini-transcribe', tier: 'Cheaper', description: 'Latest cost-effective transcription model' },
  { model: 'gpt-4o-transcribe', tier: 'Best accuracy', description: 'Latest highest-accuracy transcription model' },
];

export default function SystemConfig() {
  const [config, setConfig] = useState<SystemConfigData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  // Local state for form fields
  const [crisisContact, setCrisisContact] = useState<CrisisContact>({
    hotline: '',
    phone: '',
    text: '',
    enabled: true
  });

  const [sessionLimits, setSessionLimits] = useState<SessionLimits>({
    max_duration_minutes: 30,
    max_sessions_per_day: 3,
    cooldown_minutes: 30,
    enabled: true
  });

  const [features, setFeatures] = useState<Features>({
    voice_enabled: true,
    chat_enabled: true,
    file_upload_enabled: false,
    session_recording_enabled: false,
    output_modalities: ["audio"]
  });

  const [aiModel, setAiModel] = useState<AiModel>({
    model: 'gpt-realtime-2.1-mini',
    description: 'Latest cost-effective realtime model'
  });

  const [transcriptionModel, setTranscriptionModel] = useState<AiModel>({
    model: 'gpt-4o-mini-transcribe',
    description: 'Latest cost-effective transcription model'
  });

  const [clientLogging, setClientLogging] = useState<ClientLogging>({
    enabled: false
  });

  const [voices, setVoices] = useState<VoicesConfig>({
    voices: [],
    default_voice: 'cedar'
  });

  const [languages, setLanguages] = useState<LanguagesConfig>({
    languages: [],
    default_language: 'en'
  });

  // New voice/language form states
  const [aiTools, setAiTools] = useState<AiToolInfo[]>([]);
  const [newVoice, setNewVoice] = useState<Omit<VoiceEntry, 'enabled'>>({ value: '', label: '', description: '' });
  const [newLanguage, setNewLanguage] = useState<Omit<LanguageEntry, 'enabled'>>({
    value: '',
    label: '',
    description: '',
    systemPromptAddition: ''
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

      const data: SystemConfigData = await response.json();
      setConfig(data);

      // Registered AI tools + usage counts (non-fatal if unavailable).
      fetch('/admin/api/tools')
        .then(res => (res.ok ? res.json() : null))
        .then((t: { tools: AiToolInfo[] } | null) => { if (t) setAiTools(t.tools); })
        .catch(() => { /* tools panel just stays empty */ });

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
      if (data.ai_model) {
        setAiModel(data.ai_model.value);
      }
      if (data.transcription_model) {
        setTranscriptionModel(data.transcription_model.value);
      }
      if (data.client_logging) {
        setClientLogging(data.client_logging.value);
      }
      if (data.voices) {
        setVoices(data.voices.value);
      }
      if (data.languages) {
        setLanguages(data.languages.value);
      }

      setHasChanges(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
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

      // Save AI model
      const modelResponse = await fetch('/admin/api/config/ai_model', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: aiModel })
      });
      if (!modelResponse.ok) throw new Error('Failed to save AI model');

      // Save transcription model
      const transcriptionResponse = await fetch('/admin/api/config/transcription_model', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: transcriptionModel })
      });
      if (!transcriptionResponse.ok) throw new Error('Failed to save transcription model');

      // Save client logging
      const loggingResponse = await fetch('/admin/api/config/client_logging', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: clientLogging })
      });
      if (!loggingResponse.ok) throw new Error('Failed to save client logging');

      // Save voices
      const voicesResponse = await fetch('/admin/api/config/voices', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: voices })
      });
      if (!voicesResponse.ok) {
        const errorData = await voicesResponse.json();
        throw new Error(errorData.error || 'Failed to save voices');
      }

      // Save languages
      const languagesResponse = await fetch('/admin/api/config/languages', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: languages })
      });
      if (!languagesResponse.ok) {
        const errorData = await languagesResponse.json();
        throw new Error(errorData.error || 'Failed to save languages');
      }

      setSaveSuccess('Configuration saved successfully!');
      setHasChanges(false);

      // Refresh config to get updated timestamps
      await fetchConfig();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (window.confirm('Are you sure you want to reset to the last saved configuration?')) {
      fetchConfig();
    }
  };

  const updateCrisisContact = (field: keyof CrisisContact, value: string | boolean) => {
    setCrisisContact(prev => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  const updateSessionLimits = (field: keyof SessionLimits, value: number | boolean) => {
    setSessionLimits(prev => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  const updateFeatures = (field: keyof Features, value: boolean | string[]) => {
    setFeatures(prev => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  const toggleTool = (name: string, enabled: boolean) => {
    const disabled = new Set(features.disabled_tools ?? []);
    if (enabled) disabled.delete(name); else disabled.add(name);
    updateFeatures('disabled_tools', Array.from(disabled));
  };

  const updateAiModel = (model: string, description: string) => {
    setAiModel({ model, description });
    setHasChanges(true);
  };

  const updateTranscriptionModel = (model: string, description: string) => {
    setTranscriptionModel({ model, description });
    setHasChanges(true);
  };

  const updateClientLogging = (field: keyof ClientLogging, value: boolean) => {
    setClientLogging(prev => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  const updateVoiceField = (index: number, field: keyof VoiceEntry, value: string | boolean) => {
    const updated = { ...voices };
    updated.voices = [...updated.voices];
    updated.voices[index] = { ...updated.voices[index], [field]: value };
    setVoices(updated);
    setHasChanges(true);
  };

  const toggleVoiceEnabled = (index: number) => {
    const updated = { ...voices };
    updated.voices = [...updated.voices];
    updated.voices[index] = { ...updated.voices[index], enabled: !updated.voices[index].enabled };
    setVoices(updated);
    setHasChanges(true);
  };

  const deleteVoice = (index: number) => {
    const updated = { ...voices };
    updated.voices = updated.voices.filter((_, i) => i !== index);
    setVoices(updated);
    setHasChanges(true);
  };

  const addNewVoiceToList = () => {
    if (!newVoice.value || !newVoice.label) {
      alert('Voice code and label are required');
      return;
    }
    const updated = { ...voices };
    updated.voices = [...updated.voices, { ...newVoice, enabled: true }];
    setVoices(updated);
    setNewVoice({ value: '', label: '', description: '' });
    setHasChanges(true);
  };

  const updateLanguageField = (index: number, field: keyof LanguageEntry, value: string | boolean) => {
    const updated = { ...languages };
    updated.languages = [...updated.languages];
    updated.languages[index] = { ...updated.languages[index], [field]: value };
    setLanguages(updated);
    setHasChanges(true);
  };

  const toggleLanguageEnabled = (index: number) => {
    const updated = { ...languages };
    updated.languages = [...updated.languages];
    updated.languages[index] = { ...updated.languages[index], enabled: !updated.languages[index].enabled };
    setLanguages(updated);
    setHasChanges(true);
  };

  const deleteLanguage = (index: number) => {
    const updated = { ...languages };
    updated.languages = updated.languages.filter((_, i) => i !== index);
    setLanguages(updated);
    setHasChanges(true);
  };

  const addNewLanguageToList = () => {
    if (!newLanguage.value || !newLanguage.label) {
      alert('Language code and label are required');
      return;
    }
    const updated = { ...languages };
    updated.languages = [...updated.languages, { ...newLanguage, enabled: true }];
    setLanguages(updated);
    setNewLanguage({ value: '', label: '', description: '', systemPromptAddition: '' });
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
            className="flex items-center gap-2 px-4 py-2 bg-royal text-white rounded-lg hover:bg-navy transition disabled:opacity-50 disabled:cursor-not-allowed"
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
              className="w-4 h-4 text-royal border-gray-300 rounded focus:ring-royal"
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
              placeholder="988 Suicide & Crisis Lifeline"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-royal"
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
              placeholder="988"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-royal"
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
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-royal"
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
        <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
          <p className="text-sm text-blue-800">
            <strong>Note:</strong> Researcher accounts are exempt from these limits and can start unlimited sessions.
          </p>
        </div>

        <div className="space-y-4">
          <div className="flex items-center gap-2 mb-4">
            <input
              type="checkbox"
              id="limits-enabled"
              checked={sessionLimits.enabled}
              onChange={(e) => updateSessionLimits('enabled', e.target.checked)}
              className="w-4 h-4 text-royal border-gray-300 rounded focus:ring-royal"
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
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-royal"
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
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-royal"
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
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-royal"
              />
              <p className="text-xs text-gray-500 mt-1">Wait time between sessions</p>
            </div>
          </div>
        </div>
      </div>

      {/* AI Model Configuration */}
      <div className="mb-6 bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">AI Model Selection</h3>
        <p className="text-sm text-gray-600 mb-4">
          Choose the OpenAI Realtime model for all therapy sessions. Changes apply to all new sessions immediately.
        </p>
        <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
          <p className="text-sm text-yellow-800">
            <strong> Important:</strong> Changing the model affects all active and future sessions. Different models have different costs and capabilities.
          </p>
        </div>

        <div className="space-y-3">
          {REALTIME_MODEL_OPTIONS.map(opt => (
            <div
              key={opt.model}
              onClick={() => updateAiModel(opt.model, opt.description)}
              className={`flex items-center justify-between p-4 rounded-lg border-2 cursor-pointer transition ${
                aiModel.model === opt.model
                  ? 'border-royal bg-blue-50'
                  : 'border-gray-200 hover:border-gray-300 bg-white'
              }`}
            >
              <div>
                <p className="font-medium text-gray-900">{opt.model}</p>
                <p className="text-xs text-gray-500">{opt.tier} — {opt.description}</p>
              </div>
              <input
                type="radio"
                name="ai_model"
                checked={aiModel.model === opt.model}
                onChange={() => updateAiModel(opt.model, opt.description)}
                className="w-4 h-4 text-royal border-gray-300 focus:ring-royal"
              />
            </div>
          ))}
        </div>
      </div>

      {/* Transcription Model Configuration */}
      <div className="mb-6 bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Transcription Model</h3>
        <p className="text-sm text-gray-600 mb-4">
          Model that transcribes participant audio. This transcription feeds crisis
          detection and the redaction pipeline, so accuracy matters. Applies to new sessions.
        </p>

        <div className="space-y-3">
          {TRANSCRIPTION_MODEL_OPTIONS.map(opt => (
            <div
              key={opt.model}
              onClick={() => updateTranscriptionModel(opt.model, opt.description)}
              className={`flex items-center justify-between p-4 rounded-lg border-2 cursor-pointer transition ${
                transcriptionModel.model === opt.model
                  ? 'border-royal bg-blue-50'
                  : 'border-gray-200 hover:border-gray-300 bg-white'
              }`}
            >
              <div>
                <p className="font-medium text-gray-900">{opt.model}</p>
                <p className="text-xs text-gray-500">{opt.tier} — {opt.description}</p>
              </div>
              <input
                type="radio"
                name="transcription_model"
                checked={transcriptionModel.model === opt.model}
                onChange={() => updateTranscriptionModel(opt.model, opt.description)}
                className="w-4 h-4 text-royal border-gray-300 focus:ring-royal"
              />
            </div>
          ))}
        </div>
      </div>

      {/* Voice Management */}
      <div className="mb-6 bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Voice Configuration</h3>
        <p className="text-sm text-gray-600 mb-4">
          Manage available AI voices for therapy sessions. Users can only select from enabled voices.
        </p>

        {/* Voice List */}
        <div className="space-y-3 mb-6">
          {voices.voices && voices.voices.map((voice, index) => (
            <div key={voice.value} className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg">
              <input
                type="checkbox"
                checked={voice.enabled}
                onChange={() => toggleVoiceEnabled(index)}
                disabled={voices.voices.filter(v => v.enabled).length === 1 && voice.enabled}
                className="mt-1 w-4 h-4 text-royal border-gray-300 rounded focus:ring-royal"
                title={voices.voices.filter(v => v.enabled).length === 1 && voice.enabled ? "At least one voice must be enabled" : ""}
              />
              <div className="flex-1 grid grid-cols-3 gap-3">
                <input
                  type="text"
                  value={voice.label}
                  onChange={(e) => updateVoiceField(index, 'label', e.target.value)}
                  placeholder="Label (e.g., Cedar)"
                  className="px-2 py-1 border border-gray-300 rounded text-sm focus:ring-1 focus:ring-royal focus:border-royal"
                />
                <input
                  type="text"
                  value={voice.description || ''}
                  onChange={(e) => updateVoiceField(index, 'description', e.target.value)}
                  placeholder="Description (e.g., Warm & natural)"
                  className="px-2 py-1 border border-gray-300 rounded text-sm focus:ring-1 focus:ring-royal focus:border-royal"
                />
                <div className="flex items-center gap-2">
                  <code className="text-xs bg-gray-200 px-2 py-1 rounded flex-1">{voice.value}</code>
                  {(!voice.enabled && voice.value !== voices.default_voice) && (
                    <button
                      onClick={() => deleteVoice(index)}
                      className="text-red-600 hover:text-red-800 text-xs font-medium"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Default Voice Selector */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Default Voice
          </label>
          <select
            value={voices.default_voice}
            onChange={(e) => setVoices({...voices, default_voice: e.target.value})}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-royal"
          >
            {voices.voices && voices.voices
              .filter(v => v.enabled)
              .map(voice => (
                <option key={voice.value} value={voice.value}>
                  {voice.label}
                </option>
              ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            Used when a user's saved preference is unavailable
          </p>
        </div>

        {/* Add New Voice Form */}
        <div className="border-t border-gray-200 pt-6">
          <h4 className="text-sm font-semibold text-gray-900 mb-3">Add New Voice</h4>
          <div className="grid grid-cols-3 gap-3">
            <input
              type="text"
              value={newVoice.value}
              onChange={(e) => setNewVoice({...newVoice, value: e.target.value})}
              placeholder="Voice code (e.g., nova)"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-1 focus:ring-royal focus:border-royal"
            />
            <input
              type="text"
              value={newVoice.label}
              onChange={(e) => setNewVoice({...newVoice, label: e.target.value})}
              placeholder="Label (e.g., Nova)"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-1 focus:ring-royal focus:border-royal"
            />
            <input
              type="text"
              value={newVoice.description}
              onChange={(e) => setNewVoice({...newVoice, description: e.target.value})}
              placeholder="Description"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-1 focus:ring-royal focus:border-royal"
            />
          </div>
          <button
            onClick={addNewVoiceToList}
            className="mt-3 px-4 py-2 bg-royal text-white rounded-lg hover:bg-blue-800 text-sm font-medium"
          >
            Add Voice
          </button>
        </div>
      </div>

      {/* Language Management */}
      <div className="mb-6 bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Language Configuration</h3>
        <p className="text-sm text-gray-600 mb-4">
          Manage available languages for therapy sessions. Users can only select from enabled languages.
        </p>

        {/* Language List */}
        <div className="space-y-4 mb-6">
          {languages.languages && languages.languages.map((language, index) => (
            <div key={language.value} className="border border-gray-200 rounded-lg p-4">
              <div className="flex items-start gap-3 mb-3">
                <input
                  type="checkbox"
                  checked={language.enabled}
                  onChange={() => toggleLanguageEnabled(index)}
                  disabled={languages.languages.filter(l => l.enabled).length === 1 && language.enabled}
                  className="mt-1 w-4 h-4 text-royal border-gray-300 rounded focus:ring-royal"
                  title={languages.languages.filter(l => l.enabled).length === 1 && language.enabled ? "At least one language must be enabled" : ""}
                />
                <div className="flex-1 grid grid-cols-2 gap-3">
                  <input
                    type="text"
                    value={language.label}
                    onChange={(e) => updateLanguageField(index, 'label', e.target.value)}
                    placeholder="Label (e.g., English)"
                    className="px-2 py-1 border border-gray-300 rounded text-sm focus:ring-1 focus:ring-royal focus:border-royal"
                  />
                  <div className="flex items-center gap-2">
                    <code className="text-xs bg-gray-200 px-2 py-1 rounded flex-1">{language.value}</code>
                    {(!language.enabled && language.value !== languages.default_language) && (
                      <button
                        onClick={() => deleteLanguage(index)}
                        className="text-red-600 hover:text-red-800 text-xs font-medium"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="ml-7">
                <label className="block text-xs text-gray-600 mb-1">System Prompt Addition</label>
                <textarea
                  value={language.systemPromptAddition || ''}
                  onChange={(e) => updateLanguageField(index, 'systemPromptAddition', e.target.value)}
                  placeholder="e.g., \n\n**IMPORTANT: Please respond in English.**"
                  rows={2}
                  className="w-full px-2 py-1 border border-gray-300 rounded text-xs font-mono focus:ring-1 focus:ring-royal focus:border-royal"
                />
              </div>
            </div>
          ))}
        </div>

        {/* Default Language Selector */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Default Language
          </label>
          <select
            value={languages.default_language}
            onChange={(e) => setLanguages({...languages, default_language: e.target.value})}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-royal"
          >
            {languages.languages && languages.languages
              .filter(l => l.enabled)
              .map(language => (
                <option key={language.value} value={language.value}>
                  {language.label}
                </option>
              ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            Used when a user's saved preference is unavailable
          </p>
        </div>

        {/* Add New Language Form */}
        <div className="border-t border-gray-200 pt-6">
          <h4 className="text-sm font-semibold text-gray-900 mb-3">Add New Language</h4>
          <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
            <p className="text-xs text-blue-800 font-medium mb-2">Example format:</p>
            <code className="text-xs text-blue-900 block bg-white p-2 rounded">
              \n\n**IMPORTANT: Please respond in [Language] ([Native Name]). Use [specific vocabulary notes].**
            </code>
          </div>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <input
              type="text"
              value={newLanguage.value}
              onChange={(e) => setNewLanguage({...newLanguage, value: e.target.value})}
              placeholder="Language code (e.g., pt-BR)"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-1 focus:ring-royal focus:border-royal"
            />
            <input
              type="text"
              value={newLanguage.label}
              onChange={(e) => setNewLanguage({...newLanguage, label: e.target.value})}
              placeholder="Label (e.g., Português (Brasil))"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-1 focus:ring-royal focus:border-royal"
            />
          </div>
          <textarea
            value={newLanguage.systemPromptAddition}
            onChange={(e) => setNewLanguage({...newLanguage, systemPromptAddition: e.target.value})}
            placeholder="System prompt addition for this language..."
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-1 focus:ring-royal focus:border-royal mb-3"
          />
          <button
            onClick={addNewLanguageToList}
            className="px-4 py-2 bg-royal text-white rounded-lg hover:bg-blue-800 text-sm font-medium"
          >
            Add Language
          </button>
        </div>
      </div>

      {/* Therapy Mode Selection */}
      <div className="mb-6 bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Therapy Session Mode</h3>
        <p className="text-sm text-gray-600 mb-4">
          Choose the primary therapy mode for all users. This setting determines which OpenAI API is used.
        </p>

        {/* Current Mode Indicator */}
        <div className={`mb-4 p-4 rounded-lg border-2 ${
          features.voice_enabled
            ? 'bg-purple-50 border-purple-300'
            : 'bg-blue-50 border-blue-300'
        }`}>
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full ${features.voice_enabled ? 'bg-purple-500' : 'bg-blue-500'} animate-pulse`}></div>
            <div>
              <p className="font-semibold text-gray-900">
                Current Mode: {features.voice_enabled ? 'Realtime Voice Therapy' : 'Chat-Only Therapy'}
              </p>
              <p className="text-sm text-gray-700 mt-1">
                {features.voice_enabled
                  ? 'Using OpenAI Realtime API with WebRTC (voice + optional text)'
                  : 'Using OpenAI GPT-5.2 Responses API (text only)'}
              </p>
            </div>
          </div>
        </div>

        {/* Mode Selection */}
        <div className="space-y-3">
          <div
            onClick={() => updateFeatures('voice_enabled', true)}
            className={`p-4 rounded-lg border-2 cursor-pointer transition ${
              features.voice_enabled
                ? 'border-purple-500 bg-purple-50'
                : 'border-gray-200 hover:border-gray-300 bg-white'
            }`}
          >
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="therapy_mode"
                    checked={features.voice_enabled}
                    onChange={() => updateFeatures('voice_enabled', true)}
                    className="w-4 h-4 text-purple-600 border-gray-300 focus:ring-purple-500 mt-1"
                  />
                  <div>
                    <p className="font-semibold text-gray-900">Realtime Voice Therapy</p>
                    <p className="text-xs text-gray-600 mt-1">
                      Users can speak with AI using voice input and receive audio responses. WebRTC connection with low latency.
                    </p>
                    <div className="mt-2 p-2 bg-white rounded border border-purple-200">
                      <p className="text-xs font-semibold text-purple-800">Features:</p>
                      <ul className="text-xs text-gray-700 mt-1 space-y-1">
                        <li>• Voice input with microphone</li>
                        <li>• AI speaks responses (audio output)</li>
                        <li>• Optional text chat in same session (if "Text Input in Voice Sessions" enabled below)</li>
                        <li>• Real-time voice activity detection</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div
            onClick={() => updateFeatures('voice_enabled', false)}
            className={`p-4 rounded-lg border-2 cursor-pointer transition ${
              !features.voice_enabled
                ? 'border-blue-500 bg-blue-50'
                : 'border-gray-200 hover:border-gray-300 bg-white'
            }`}
          >
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="therapy_mode"
                    checked={!features.voice_enabled}
                    onChange={() => updateFeatures('voice_enabled', false)}
                    className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500 mt-1"
                  />
                  <div>
                    <p className="font-semibold text-gray-900">Chat-Only Therapy (Text Only)</p>
                    <p className="text-xs text-gray-600 mt-1">
                      Users communicate entirely via text messages. No voice input or output.
                    </p>
                    <div className="mt-2 p-2 bg-white rounded border border-blue-200">
                      <p className="text-xs font-semibold text-blue-800">Features:</p>
                      <ul className="text-xs text-gray-700 mt-1 space-y-1">
                        <li>• Text-based messaging only</li>
                        <li>• AI responds with text (GPT-5.2 Responses API)</li>
                        <li>• No voice input or audio output</li>

                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Additional Features (only shown for Realtime Voice mode) */}
      {/* AI Tools (ai-therapist-32): per-tool enable/disable + usage counts */}
      {aiTools.length > 0 && (
        <div className="mb-6 bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-1">AI Tools</h3>
          <p className="text-sm text-gray-600 mb-4">
            Functions the AI can call during sessions. Disabling a tool removes it from new
            sessions (and blocks it in running ones) — usable as a study condition.
          </p>
          <div className="space-y-2">
            {aiTools.map(tool => {
              const enabled = !(features.disabled_tools ?? []).includes(tool.name);
              return (
                <div key={tool.name} className="flex items-start justify-between gap-4 p-3 bg-gray-50 rounded-lg">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900 font-mono text-sm">{tool.name}</p>
                    <p className="text-xs text-gray-600 mt-0.5">{tool.description}</p>
                    <p className="text-xs text-gray-400 mt-1">
                      {tool.invocations} call{tool.invocations === 1 ? '' : 's'} across {tool.sessions} session{tool.sessions === 1 ? '' : 's'}
                      {tool.last_used ? ` · last used ${new Date(tool.last_used).toLocaleDateString()}` : ''}
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => toggleTool(tool.name, e.target.checked)}
                    aria-label={`Enable ${tool.name}`}
                    className="w-4 h-4 mt-1 flex-shrink-0 text-royal border-gray-300 rounded focus:ring-royal"
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {features.voice_enabled && (
        <div className="mb-6 bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Realtime Voice Session Options</h3>
          <p className="text-sm text-gray-600 mb-4">
            Additional features for realtime voice therapy sessions.
          </p>

          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <div>
                <p className="font-medium text-gray-900">Text Input in Voice Sessions</p>
                <p className="text-xs text-gray-600">Allow users to type messages during voice sessions (in addition to speaking)</p>
              </div>
              <input
                type="checkbox"
                checked={features.chat_enabled}
                onChange={(e) => updateFeatures('chat_enabled', e.target.checked)}
                className="w-4 h-4 text-royal border-gray-300 rounded focus:ring-royal"
              />
            </div>

            {/* Output Modalities */}
            <div className="p-3 bg-purple-50 rounded-lg border border-purple-200">
              <div>
                <p className="font-medium text-gray-900 mb-2">AI Response Format</p>
                <p className="text-xs text-gray-600 mb-3">How should the AI respond in voice sessions?</p>
              </div>
              <div className="space-y-2">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="output_modalities"
                    checked={JSON.stringify(features.output_modalities) === JSON.stringify(["audio"])}
                    onChange={() => updateFeatures('output_modalities', ["audio"])}
                    className="w-4 h-4 text-purple-600 border-gray-300 focus:ring-purple-500"
                  />
                  <div>
                    <span className="text-sm text-gray-900 font-medium">Audio Only</span>
                    <p className="text-xs text-gray-600">AI speaks responses (no text transcription shown to user)</p>
                  </div>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="output_modalities"
                    checked={JSON.stringify(features.output_modalities) === JSON.stringify(["text"])}
                    onChange={() => updateFeatures('output_modalities', ["text"])}
                    className="w-4 h-4 text-purple-600 border-gray-300 focus:ring-purple-500"
                  />
                  <div>
                    <span className="text-sm text-gray-900 font-medium">Text Only</span>
                    <p className="text-xs text-gray-600">AI shows text responses (no audio, useful for testing)</p>
                  </div>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="output_modalities"
                    checked={JSON.stringify(features.output_modalities) === JSON.stringify(["audio", "text"]) || JSON.stringify(features.output_modalities) === JSON.stringify(["text", "audio"])}
                    onChange={() => updateFeatures('output_modalities', ["audio", "text"])}
                    className="w-4 h-4 text-purple-600 border-gray-300 focus:ring-purple-500"
                  />
                  <div>
                    <span className="text-sm text-gray-900 font-medium">Audio + Text (Recommended)</span>
                    <p className="text-xs text-gray-600">AI speaks AND shows text transcription for accessibility</p>
                  </div>
                </label>
              </div>
            </div>


          </div>
        </div>
      )}

      {/* Other Features */}
      <div className="mb-6 bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Additional Features</h3>
        <p className="text-sm text-gray-600 mb-4">
          Other experimental features (available in both modes).
        </p>

        <div className="space-y-3">
          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
            <div>
              <p className="font-medium text-gray-900">File Upload</p>
              <p className="text-xs text-gray-600">Allow users to upload files during sessions (experimental)</p>
            </div>
            <input
              type="checkbox"
              checked={features.file_upload_enabled}
              onChange={(e) => updateFeatures('file_upload_enabled', e.target.checked)}
              className="w-4 h-4 text-royal border-gray-300 rounded focus:ring-royal"
            />
          </div>
        </div>
      </div>

      {/* Client Logging Configuration */}
      <div className="mb-6 bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Developer Tools</h3>
        <p className="text-sm text-gray-600 mb-4">
          Control client-side debugging features. These settings only affect the participant interface.
        </p>

        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="client-logging-enabled"
              checked={clientLogging.enabled}
              onChange={(e) => updateClientLogging('enabled', e.target.checked)}
              className="w-4 h-4 text-royal border-gray-300 rounded focus:ring-royal"
            />
            <label htmlFor="client-logging-enabled" className="text-sm font-medium text-gray-700">
              Enable client-side console logging
            </label>
          </div>
          <p className="text-xs text-gray-500 ml-6">
            When enabled, the participant interface will output debug messages to the browser console. Keep disabled in production for cleaner logs.
          </p>
        </div>
      </div>

      {config && (
        <div className="text-xs text-gray-500 mt-6">
          Last updated: {config.crisis_contact?.updated_at ? new Date(config.crisis_contact.updated_at).toLocaleString('en-US', {
            month: 'numeric',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
          }) : 'Never'}
          {config.crisis_contact?.updated_by && ` by ${config.crisis_contact.updated_by}`}
        </div>
      )}
    </div>
  );
}
