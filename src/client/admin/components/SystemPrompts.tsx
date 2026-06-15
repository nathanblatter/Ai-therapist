import { useState, useEffect } from 'react';
import { Save, RotateCcw, AlertCircle, CheckCircle, Eye, Code } from 'react-feather';

export default function SystemPrompts() {
  const [prompts, setPrompts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [activeTab, setActiveTab] = useState('realtime');

  // Preview state
  const [showPreview, setShowPreview] = useState(false);
  const [previewLanguage, setPreviewLanguage] = useState('en');
  const [previewContent, setPreviewContent] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [languages, setLanguages] = useState([]);

  // Original prompts for reset functionality
  const [originalPrompts, setOriginalPrompts] = useState(null);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/admin/api/config');
      if (!response.ok) throw new Error('Failed to fetch configuration');

      const data = await response.json();

      if (data.system_prompts) {
        setPrompts(data.system_prompts.value);
        setOriginalPrompts(JSON.parse(JSON.stringify(data.system_prompts.value)));
      } else {
        // Initialize with empty prompts if not in database yet
        const defaultPrompts = {
          realtime: { prompt: '', description: 'System prompt for realtime voice therapy sessions', last_modified: null },
          chat: { prompt: '', description: 'System prompt for chat-only text therapy sessions', last_modified: null }
        };
        setPrompts(defaultPrompts);
        setOriginalPrompts(JSON.parse(JSON.stringify(defaultPrompts)));
      }

      // Load languages for preview selector
      if (data.languages?.value?.languages) {
        setLanguages(data.languages.value.languages.filter(l => l.enabled));
      }

      setHasChanges(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handlePromptChange = (sessionType, value) => {
    setPrompts(prev => ({
      ...prev,
      [sessionType]: {
        ...prev[sessionType],
        prompt: value
      }
    }));
    setHasChanges(true);
    setSaveSuccess(null);
  };

  const handleDescriptionChange = (sessionType, value) => {
    setPrompts(prev => ({
      ...prev,
      [sessionType]: {
        ...prev[sessionType],
        description: value
      }
    }));
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
        body: JSON.stringify({ value: prompts })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to save system prompts');
      }

      setSaveSuccess('System prompts saved successfully!');
      setHasChanges(false);
      setOriginalPrompts(JSON.parse(JSON.stringify(prompts)));

      // Refresh to get updated timestamps
      await fetchData();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (window.confirm('Are you sure you want to discard unsaved changes?')) {
      setPrompts(JSON.parse(JSON.stringify(originalPrompts)));
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

      const data = await response.json();
      setPreviewContent(data.prompt);
    } catch (err) {
      setPreviewContent(`Error loading preview: ${err.message}`);
    } finally {
      setPreviewLoading(false);
    }
  };

  useEffect(() => {
    if (showPreview) {
      fetchPreview();
    }
  }, [showPreview, activeTab, previewLanguage]);

  const getCharacterCount = (text) => {
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
                ? 'border-byuRoyal text-byuRoyal'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            Realtime (Voice) Sessions
          </button>
          <button
            onClick={() => setActiveTab('chat')}
            className={`pb-3 px-1 border-b-2 font-medium text-sm transition ${
              activeTab === 'chat'
                ? 'border-byuRoyal text-byuRoyal'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            Chat-Only Sessions
          </button>
        </nav>
      </div>

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
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-byuRoyal"
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
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-byuRoyal font-mono text-sm resize-y"
                style={{ minHeight: '400px' }}
              />
            </div>

            {prompts?.[activeTab]?.last_modified && (
              <p className="text-xs text-gray-500 mt-3">
                Last modified: {new Date(prompts[activeTab].last_modified).toLocaleString('en-US', {
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
                    className="px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-1 focus:ring-byuRoyal"
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
    </div>
  );
}
