import { useState, useEffect } from 'react';
import { Save, RotateCcw, AlertCircle, CheckCircle, Eye, Code } from 'react-feather';
// Canonical modality-preset shape lives in the server helpers (type-only
// import, erased at build time).
import type { ModalityPreset } from '../../../server/utils/sessionHelpers';

interface PromptEntry {
  prompt: string;
  description: string;
  last_modified: string | null;
}

interface PromptsMap {
  [sessionType: string]: PromptEntry;
}

interface Language {
  value: string;
  label: string;
  enabled: boolean;
}

export default function SystemPrompts() {
  const [prompts, setPrompts] = useState<PromptsMap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [activeTab, setActiveTab] = useState('realtime');

  // Preview state
  const [showPreview, setShowPreview] = useState(false);
  const [previewLanguage, setPreviewLanguage] = useState('en');
  const [previewContent, setPreviewContent] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [languages, setLanguages] = useState<Language[]>([]);

  // Original prompts for reset functionality
  const [originalPrompts, setOriginalPrompts] = useState<PromptsMap | null>(null);

  // Therapeutic modality presets (ai-therapist-41): appendix blocks applied to
  // the base prompt; active_modality selects the study condition.
  const [modalityPresets, setModalityPresets] = useState<Record<string, ModalityPreset>>({});
  const [activeModality, setActiveModality] = useState<string>('none');
  const [editingModality, setEditingModality] = useState<string | null>(null);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/admin/api/config');
      if (!response.ok) throw new Error('Failed to fetch configuration');

      const data = await response.json() as {
        system_prompts?: {
          value: PromptsMap & {
            modality_presets?: Record<string, ModalityPreset>;
            active_modality?: string | null;
          };
        };
        languages?: { value: { languages: Language[] } };
      };

      // Modality presets: saved config wins, otherwise the built-in defaults.
      const savedPresets = data.system_prompts?.value?.modality_presets;
      if (savedPresets && Object.keys(savedPresets).length > 0) {
        setModalityPresets(savedPresets);
      } else {
        try {
          const defaultsRes = await fetch('/admin/api/config/modality-defaults');
          if (defaultsRes.ok) {
            const defaults = await defaultsRes.json() as { presets: Record<string, ModalityPreset> };
            setModalityPresets(defaults.presets);
          }
        } catch { /* modality editing just starts empty */ }
      }
      setActiveModality(data.system_prompts?.value?.active_modality || 'none');

      if (data.system_prompts) {
        const { modality_presets: _mp, active_modality: _am, ...promptEntries } = data.system_prompts.value;
        setPrompts(promptEntries as PromptsMap);
        setOriginalPrompts(JSON.parse(JSON.stringify(promptEntries)) as PromptsMap);
      } else {
        // Initialize with empty prompts if not in database yet
        const defaultPrompts: PromptsMap = {
          realtime: { prompt: '', description: 'System prompt for realtime voice therapy sessions', last_modified: null },
          chat: { prompt: '', description: 'System prompt for chat-only text therapy sessions', last_modified: null }
        };
        setPrompts(defaultPrompts);
        setOriginalPrompts(JSON.parse(JSON.stringify(defaultPrompts)) as PromptsMap);
      }

      // Load languages for preview selector
      if (data.languages?.value?.languages) {
        setLanguages(data.languages.value.languages.filter((l: Language) => l.enabled));
      }

      setHasChanges(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handlePromptChange = (sessionType: string, value: string) => {
    setPrompts(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        [sessionType]: {
          ...prev[sessionType],
          prompt: value
        }
      };
    });
    setHasChanges(true);
    setSaveSuccess(null);
  };

  const handleDescriptionChange = (sessionType: string, value: string) => {
    setPrompts(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        [sessionType]: {
          ...prev[sessionType],
          description: value
        }
      };
    });
    setHasChanges(true);
    setSaveSuccess(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaveSuccess(null);

    try {
      const response = await fetch('/admin/api/config/system_prompts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          value: {
            ...prompts,
            modality_presets: modalityPresets,
            active_modality: activeModality === 'none' ? null : activeModality,
          },
        })
      });

      if (!response.ok) {
        const errorData = await response.json() as { error?: string };
        throw new Error(errorData.error || 'Failed to save system prompts');
      }

      setSaveSuccess('System prompts saved successfully!');
      setHasChanges(false);
      setOriginalPrompts(JSON.parse(JSON.stringify(prompts)) as PromptsMap);

      // Refresh to get updated timestamps
      await fetchData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (window.confirm('Are you sure you want to discard unsaved changes?')) {
      setPrompts(JSON.parse(JSON.stringify(originalPrompts)) as PromptsMap);
      setHasChanges(false);
      setError(null);
      setSaveSuccess(null);
    }
  };

  const fetchPreview = async () => {
    setPreviewLoading(true);
    try {
      const response = await fetch(
        `/admin/api/config/system-prompt-preview?sessionType=${activeTab}&language=${previewLanguage}`
      );
      if (!response.ok) throw new Error('Failed to load preview');

      const data = await response.json() as { prompt: string };
      setPreviewContent(data.prompt);
    } catch (err: unknown) {
      setPreviewContent(`Error loading preview: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPreviewLoading(false);
    }
  };

  useEffect(() => {
    if (showPreview && activeTab !== 'modality') {
      fetchPreview();
    }
  }, [showPreview, activeTab, previewLanguage]);

  const getCharacterCount = (text: string | undefined) => {
    return text?.length || 0;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-gray-500">Loading system prompts...</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">System Prompts</h2>
          <p className="text-sm text-gray-600 mt-1">
            Configure the AI system prompts for different session types
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowPreview(!showPreview)}
            className={`flex items-center gap-2 px-4 py-2 border rounded-lg transition ${
              showPreview
                ? 'bg-blue-50 border-blue-300 text-blue-700'
                : 'border-gray-300 hover:bg-gray-50'
            }`}
          >
            <Eye size={16} />
            {showPreview ? 'Hide Preview' : 'Show Preview'}
          </button>
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

      {hasChanges && (
        <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
          <p className="text-sm text-yellow-800">
            You have unsaved changes. Remember to save before leaving this page.
          </p>
        </div>
      )}

      {/* Variable Hints */}
      <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
        <div className="flex items-start gap-2">
          <Code size={18} className="text-blue-600 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-blue-800">Available Variables</p>
            <p className="text-sm text-blue-700 mt-1">
              Use <code className="bg-blue-100 px-1 rounded">{"{{crisis_text}}"}</code> to insert the configured crisis contact information dynamically.
              This will be replaced with the current crisis hotline, phone, and text line when the prompt is used.
            </p>
          </div>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex gap-4">
          <button
            onClick={() => setActiveTab('realtime')}
            className={`pb-3 px-1 border-b-2 font-medium text-sm transition ${
              activeTab === 'realtime'
                ? 'border-royal text-royal'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            Realtime (Voice) Sessions
          </button>
          <button
            onClick={() => setActiveTab('chat')}
            className={`pb-3 px-1 border-b-2 font-medium text-sm transition ${
              activeTab === 'chat'
                ? 'border-royal text-royal'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            Chat-Only Sessions
          </button>
          <button
            onClick={() => setActiveTab('modality')}
            className={`pb-3 px-1 border-b-2 font-medium text-sm transition ${
              activeTab === 'modality'
                ? 'border-royal text-royal'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            Therapeutic Modality
            {activeModality !== 'none' && (
              <span className="ml-2 text-xs bg-royal text-white px-2 py-0.5 rounded-full">
                {modalityPresets[activeModality]?.label || activeModality}
              </span>
            )}
          </button>
        </nav>
      </div>

      {activeTab === 'modality' ? (
        /* Modality panel: pick the active therapeutic approach + edit presets */
        <div className="bg-white rounded-lg shadow p-6 space-y-6">
          <div>
            <h3 className="text-sm font-semibold text-gray-800 mb-1">Active modality</h3>
            <p className="text-xs text-gray-500 mb-3">
              The selected approach is appended to the base prompt for every new session
              and recorded on the session&apos;s configuration — treat it as the study condition.
            </p>
            <div className="space-y-2">
              <label className="flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:bg-gray-50">
                <input
                  type="radio"
                  name="active-modality"
                  checked={activeModality === 'none'}
                  onChange={() => { setActiveModality('none'); setHasChanges(true); setSaveSuccess(null); }}
                />
                <span className="text-sm font-medium text-gray-700">None (base prompt only)</span>
              </label>
              {Object.entries(modalityPresets).map(([key, preset]) => (
                <div key={key} className="border rounded-lg">
                  <label className="flex items-center gap-3 p-3 cursor-pointer hover:bg-gray-50">
                    <input
                      type="radio"
                      name="active-modality"
                      checked={activeModality === key}
                      onChange={() => { setActiveModality(key); setHasChanges(true); setSaveSuccess(null); }}
                    />
                    <span className="text-sm font-medium text-gray-700 flex-1">{preset.label}</span>
                    <button
                      type="button"
                      onClick={(e) => { e.preventDefault(); setEditingModality(editingModality === key ? null : key); }}
                      className="text-xs text-royal hover:underline px-2 py-1"
                    >
                      {editingModality === key ? 'Close' : 'Edit'}
                    </button>
                  </label>
                  {editingModality === key && (
                    <div className="px-4 pb-4 space-y-3 border-t border-gray-100 pt-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Label</label>
                        <input
                          type="text"
                          value={preset.label}
                          onChange={(e) => {
                            setModalityPresets(prev => ({ ...prev, [key]: { ...prev[key], label: e.target.value } }));
                            setHasChanges(true); setSaveSuccess(null);
                          }}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-royal"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">
                          Prompt appendix ({preset.addition.length} characters)
                        </label>
                        <textarea
                          value={preset.addition}
                          onChange={(e) => {
                            setModalityPresets(prev => ({ ...prev, [key]: { ...prev[key], addition: e.target.value } }));
                            setHasChanges(true); setSaveSuccess(null);
                          }}
                          rows={6}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-royal resize-y"
                        />
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
      <div className="flex gap-6">
        {/* Editor Panel */}
        <div className={`${showPreview ? 'w-1/2' : 'w-full'} transition-all`}>
          <div className="bg-white rounded-lg shadow p-6">
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Description
              </label>
              <input
                type="text"
                value={prompts?.[activeTab]?.description || ''}
                onChange={(e) => handleDescriptionChange(activeTab, e.target.value)}
                placeholder="Brief description of this prompt..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-royal"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-gray-700">
                  System Prompt
                </label>
                <span className="text-xs text-gray-500">
                  {getCharacterCount(prompts?.[activeTab]?.prompt)} characters
                  {getCharacterCount(prompts?.[activeTab]?.prompt) < 100 && (
                    <span className="text-red-500 ml-2">(min 100 required)</span>
                  )}
                </span>
              </div>
              <textarea
                value={prompts?.[activeTab]?.prompt || ''}
                onChange={(e) => handlePromptChange(activeTab, e.target.value)}
                placeholder="Enter the system prompt..."
                rows={20}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-royal font-mono text-sm resize-y"
                style={{ minHeight: '400px' }}
              />
            </div>

            {prompts?.[activeTab]?.last_modified && (
              <p className="text-xs text-gray-500 mt-3">
                Last modified: {new Date(prompts[activeTab].last_modified as string).toLocaleString('en-US', {
                  month: 'numeric',
                  day: 'numeric',
                  year: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                  hour12: true
                })}
              </p>
            )}
          </div>
        </div>

        {/* Preview Panel */}
        {showPreview && (
          <div className="w-1/2">
            <div className="bg-white rounded-lg shadow p-6 sticky top-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900">Preview</h3>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-gray-600">Language:</label>
                  <select
                    value={previewLanguage}
                    onChange={(e) => setPreviewLanguage(e.target.value)}
                    className="px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-1 focus:ring-royal"
                  >
                    <option value="en">English</option>
                    {languages.map(lang => (
                      <option key={lang.value} value={lang.value}>
                        {lang.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="mb-3 p-2 bg-gray-100 rounded text-xs text-gray-600">
                This preview shows how the prompt will appear after variable interpolation
                and language additions are applied.
              </div>

              {previewLoading ? (
                <div className="flex items-center justify-center h-64">
                  <p className="text-gray-500">Loading preview...</p>
                </div>
              ) : (
                <div
                  className="bg-gray-50 border border-gray-200 rounded-lg p-4 font-mono text-sm whitespace-pre-wrap overflow-auto"
                  style={{ maxHeight: '500px' }}
                >
                  {previewContent || 'No preview available. Save changes first to see the interpolated prompt.'}
                </div>
              )}

              <p className="text-xs text-gray-500 mt-3">
                Preview character count: {previewContent?.length || 0}
              </p>
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
