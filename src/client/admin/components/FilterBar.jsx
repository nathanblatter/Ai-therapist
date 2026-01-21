import { useState, useEffect } from "react";

// Filter option constants
const VOICE_OPTIONS = [
  { value: 'alloy', label: 'Alloy' },
  { value: 'ash', label: 'Ash' },
  { value: 'ballad', label: 'Ballad' },
  { value: 'cedar', label: 'Cedar' },
  { value: 'coral', label: 'Coral' },
  { value: 'echo', label: 'Echo' },
  { value: 'marin', label: 'Marin' },
  { value: 'sage', label: 'Sage' },
  { value: 'shimmer', label: 'Shimmer' },
  { value: 'verse', label: 'Verse' }
];

const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'es-ES', label: 'Spanish (ES)' },
  { value: 'es-419', label: 'Spanish (LA)' },
  { value: 'fr-FR', label: 'French (FR)' },
  { value: 'fr-CA', label: 'French (CA)' },
  { value: 'pt-BR', label: 'Portuguese (BR)' },
  { value: 'pt-PT', label: 'Portuguese (PT)' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'ar', label: 'Arabic' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ru', label: 'Russian' }
];

const DURATION_OPTIONS = [
  { value: 'short', label: 'Short (0-5 min)' },
  { value: 'medium', label: 'Medium (5-30 min)' },
  { value: 'long', label: 'Long (30+ min)' }
];

const SESSION_TYPE_OPTIONS = [
  { value: 'realtime', label: 'Realtime' },
  { value: 'chat', label: 'Chat' }
];

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'ended', label: 'Ended' },
  { value: 'archived', label: 'Archived' }
];

const ENDED_BY_OPTIONS = [
  { value: 'user', label: 'User' },
  { value: 'admin', label: 'Admin' },
  { value: 'system', label: 'System' }
];

const CRISIS_SEVERITY_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
];

// Reusable MultiSelectFilter component
function MultiSelectFilter({ label, options, selected, onChange }) {
  const handleToggle = (value) => {
    if (selected.includes(value)) {
      onChange(selected.filter(v => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  const handleSelectAll = () => {
    onChange(options.map(opt => opt.value));
  };

  const handleClearAll = () => {
    onChange([]);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-semibold text-gray-700">{label}</label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleSelectAll}
            className="text-xs text-byuRoyal hover:underline"
          >
            All
          </button>
          <button
            type="button"
            onClick={handleClearAll}
            className="text-xs text-gray-500 hover:underline"
          >
            Clear
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-1 max-h-40 overflow-y-auto border rounded p-2 bg-gray-50">
        {options.map(option => (
          <label key={option.value} className="flex items-center gap-2 cursor-pointer hover:bg-gray-100 px-1 rounded">
            <input
              type="checkbox"
              checked={selected.includes(option.value)}
              onChange={() => handleToggle(option.value)}
              className="accent-byuRoyal"
            />
            <span className="text-sm">{option.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export default function FilterBar({ onFilterChange }) {
  const [filters, setFilters] = useState({
    // Existing filters
    search: '',
    startDate: '',
    endDate: '',
    minMessages: '',
    maxMessages: '',
    // New filters
    voices: [],
    languages: [],
    durations: [],
    sessionTypes: [],
    statuses: [],
    endedBy: [],
    crisisFlagged: '',
    crisisSeverity: ''
  });

  const [showAdvanced, setShowAdvanced] = useState(false);

  // Debounce filter changes
  useEffect(() => {
    const timer = setTimeout(() => {
      // Serialize array filters to CSV strings
      const serializedFilters = {
        ...filters,
        voices: filters.voices.length > 0 ? filters.voices.join(',') : '',
        languages: filters.languages.length > 0 ? filters.languages.join(',') : '',
        durations: filters.durations.length > 0 ? filters.durations.join(',') : '',
        sessionTypes: filters.sessionTypes.length > 0 ? filters.sessionTypes.join(',') : '',
        statuses: filters.statuses.length > 0 ? filters.statuses.join(',') : '',
        endedBy: filters.endedBy.length > 0 ? filters.endedBy.join(',') : ''
      };
      onFilterChange(serializedFilters);
    }, 500);

    return () => clearTimeout(timer);
  }, [filters, onFilterChange]);

  const handleChange = (field, value) => {
    setFilters(prev => ({ ...prev, [field]: value }));
  };

  const handleClear = () => {
    const clearedFilters = {
      search: '',
      startDate: '',
      endDate: '',
      minMessages: '',
      maxMessages: '',
      voices: [],
      languages: [],
      durations: [],
      sessionTypes: [],
      statuses: [],
      endedBy: [],
      crisisFlagged: '',
      crisisSeverity: ''
    };
    setFilters(clearedFilters);
  };

  const handleClearAdvanced = () => {
    setFilters(prev => ({
      ...prev,
      voices: [],
      languages: [],
      durations: [],
      sessionTypes: [],
      statuses: [],
      endedBy: [],
      crisisFlagged: '',
      crisisSeverity: ''
    }));
  };

  // Calculate active advanced filter count
  const advancedFilterCount = [
    filters.voices.length > 0,
    filters.languages.length > 0,
    filters.durations.length > 0,
    filters.sessionTypes.length > 0,
    filters.statuses.length > 0,
    filters.endedBy.length > 0,
    filters.crisisFlagged !== '',
    filters.crisisSeverity !== ''
  ].filter(Boolean).length;

  return (
    <div className="bg-white p-4 rounded-lg shadow">
      {/* Row 1: Basic Filters */}
      <div className="flex flex-wrap gap-4 mb-4">
        <input
          type="text"
          placeholder="Search session ID, name, or username..."
          className="border rounded px-3 py-2 flex-1 min-w-[200px]"
          value={filters.search}
          onChange={(e) => handleChange('search', e.target.value)}
        />

        <input
          type="date"
          placeholder="Start date"
          className="border rounded px-3 py-2"
          value={filters.startDate}
          onChange={(e) => handleChange('startDate', e.target.value)}
        />

        <input
          type="date"
          placeholder="End date"
          className="border rounded px-3 py-2"
          value={filters.endDate}
          onChange={(e) => handleChange('endDate', e.target.value)}
        />

        <input
          type="number"
          placeholder="Min messages"
          className="border rounded px-3 py-2 w-32"
          value={filters.minMessages}
          onChange={(e) => handleChange('minMessages', e.target.value)}
        />

        <input
          type="number"
          placeholder="Max messages"
          className="border rounded px-3 py-2 w-32"
          value={filters.maxMessages}
          onChange={(e) => handleChange('maxMessages', e.target.value)}
        />

        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className={`px-4 py-2 rounded font-medium transition-colors ${
            showAdvanced
              ? 'bg-byuRoyal text-white'
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
          }`}
        >
          Advanced Filters {showAdvanced ? '▲' : '▼'}
          {advancedFilterCount > 0 && (
            <span className="ml-2 bg-white text-byuRoyal px-2 py-0.5 rounded-full text-xs font-bold">
              {advancedFilterCount}
            </span>
          )}
        </button>

        <button
          onClick={handleClear}
          className="bg-gray-200 px-4 py-2 rounded hover:bg-gray-300"
        >
          Clear All
        </button>
      </div>

      {/* Row 2: Advanced Filters (Collapsible) */}
      {showAdvanced && (
        <div className="border-t pt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            {/* Voice Filter */}
            <MultiSelectFilter
              label="Voice"
              options={VOICE_OPTIONS}
              selected={filters.voices}
              onChange={(value) => handleChange('voices', value)}
            />

            {/* Language Filter */}
            <MultiSelectFilter
              label="Language"
              options={LANGUAGE_OPTIONS}
              selected={filters.languages}
              onChange={(value) => handleChange('languages', value)}
            />

            {/* Duration Filter */}
            <MultiSelectFilter
              label="Duration"
              options={DURATION_OPTIONS}
              selected={filters.durations}
              onChange={(value) => handleChange('durations', value)}
            />

            {/* Session Type Filter */}
            <MultiSelectFilter
              label="Session Type"
              options={SESSION_TYPE_OPTIONS}
              selected={filters.sessionTypes}
              onChange={(value) => handleChange('sessionTypes', value)}
            />

            {/* Status Filter */}
            <MultiSelectFilter
              label="Status"
              options={STATUS_OPTIONS}
              selected={filters.statuses}
              onChange={(value) => handleChange('statuses', value)}
            />

            {/* Ended By Filter */}
            <MultiSelectFilter
              label="Ended By"
              options={ENDED_BY_OPTIONS}
              selected={filters.endedBy}
              onChange={(value) => handleChange('endedBy', value)}
            />

            {/* Crisis Flagged Filter */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-semibold text-gray-700">Crisis Flagged</label>
              <div className="flex flex-col gap-2 border rounded p-2 bg-gray-50">
                <label className="flex items-center gap-2 cursor-pointer hover:bg-gray-100 px-1 rounded">
                  <input
                    type="radio"
                    name="crisisFlagged"
                    value=""
                    checked={filters.crisisFlagged === ''}
                    onChange={(e) => handleChange('crisisFlagged', e.target.value)}
                    className="accent-byuRoyal"
                  />
                  <span className="text-sm">All</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer hover:bg-gray-100 px-1 rounded">
                  <input
                    type="radio"
                    name="crisisFlagged"
                    value="true"
                    checked={filters.crisisFlagged === 'true'}
                    onChange={(e) => handleChange('crisisFlagged', e.target.value)}
                    className="accent-byuRoyal"
                  />
                  <span className="text-sm">Yes</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer hover:bg-gray-100 px-1 rounded">
                  <input
                    type="radio"
                    name="crisisFlagged"
                    value="false"
                    checked={filters.crisisFlagged === 'false'}
                    onChange={(e) => handleChange('crisisFlagged', e.target.value)}
                    className="accent-byuRoyal"
                  />
                  <span className="text-sm">No</span>
                </label>
              </div>
            </div>

            {/* Crisis Severity Filter */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-semibold text-gray-700">Crisis Severity</label>
              <select
                value={filters.crisisSeverity}
                onChange={(e) => handleChange('crisisSeverity', e.target.value)}
                className="border rounded px-3 py-2 bg-white"
              >
                {CRISIS_SEVERITY_OPTIONS.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <button
            onClick={handleClearAdvanced}
            className="bg-gray-200 px-4 py-2 rounded hover:bg-gray-300 text-sm"
          >
            Clear Advanced Filters
          </button>
        </div>
      )}
    </div>
  );
}
