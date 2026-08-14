import { useState } from 'react';
import type { AnalyticsFilterState } from './types';

// Date + advanced filter bar for the Usage tab of the analytics dashboard.
// These filters only affect the main /admin/api/analytics fetch, so the bar
// is rendered on the Usage tab only (ai-therapist-120).

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

export const EMPTY_FILTERS: AnalyticsFilterState = {
  startDate: '',
  endDate: '',
  voices: [],
  languages: [],
  sessionTypes: [],
  statuses: [],
  endedBy: [],
  crisisFlagged: ''
};

interface FilterOption {
  value: string;
  label: string;
}

interface MultiSelectFilterProps {
  label: string;
  options: FilterOption[];
  selected: string[];
  onChange: (values: string[]) => void;
}

function MultiSelectFilter({ label, options, selected, onChange }: MultiSelectFilterProps) {
  const handleToggle = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter((v: string) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-semibold text-gray-700">{label}</label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onChange(options.map((opt: FilterOption) => opt.value))}
            className="text-xs text-royal hover:underline"
          >
            All
          </button>
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-xs text-gray-500 hover:underline"
          >
            Clear
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-1 max-h-32 overflow-y-auto border rounded p-2 bg-gray-50">
        {options.map((option: FilterOption) => (
          <label key={option.value} className="flex items-center gap-2 cursor-pointer hover:bg-gray-100 px-1 rounded">
            <input
              type="checkbox"
              checked={selected.includes(option.value)}
              onChange={() => handleToggle(option.value)}
              className="accent-royal"
            />
            <span className="text-sm">{option.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

interface AnalyticsFilterBarProps {
  filters: AnalyticsFilterState;
  onChange: (filters: AnalyticsFilterState) => void;
}

export default function AnalyticsFilterBar({ filters, onChange }: AnalyticsFilterBarProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const setField = (field: keyof AnalyticsFilterState, value: string | string[]) => {
    onChange({ ...filters, [field]: value });
  };

  const setCurrentMonth = () => {
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    onChange({
      ...filters,
      startDate: firstDay.toISOString().split('T')[0],
      endDate: lastDay.toISOString().split('T')[0]
    });
  };

  const handleClearAdvanced = () => {
    onChange({ ...filters, ...EMPTY_FILTERS, startDate: filters.startDate, endDate: filters.endDate });
  };

  // Active advanced filter count for the toggle badge.
  const advancedFilterCount = [
    filters.voices.length > 0,
    filters.languages.length > 0,
    filters.sessionTypes.length > 0,
    filters.statuses.length > 0,
    filters.endedBy.length > 0,
    filters.crisisFlagged !== ''
  ].filter(Boolean).length;

  return (
    <div className="bg-white p-4 rounded-lg shadow">
      {/* Row 1: Date Filters */}
      <div className="flex flex-wrap gap-4 mb-4">
        <input
          type="date"
          value={filters.startDate}
          onChange={(e) => setField('startDate', e.target.value)}
          className="border rounded px-3 py-2"
          placeholder="Start date"
        />
        <input
          type="date"
          value={filters.endDate}
          onChange={(e) => setField('endDate', e.target.value)}
          className="border rounded px-3 py-2"
          placeholder="End date"
        />
        <button
          onClick={setCurrentMonth}
          className="bg-royal text-white px-4 py-2 rounded hover:bg-navy"
        >
          Current Month
        </button>
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className={`px-4 py-2 rounded font-medium transition-colors ${
            showAdvanced
              ? 'bg-royal text-white'
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
          }`}
        >
          Advanced Filters {showAdvanced ? '▲' : '▼'}
          {advancedFilterCount > 0 && (
            <span className="ml-2 bg-white text-royal px-2 py-0.5 rounded-full text-xs font-bold">
              {advancedFilterCount}
            </span>
          )}
        </button>
        <button
          onClick={() => onChange(EMPTY_FILTERS)}
          className="bg-gray-200 px-4 py-2 rounded hover:bg-gray-300"
        >
          Clear All
        </button>
      </div>

      {/* Row 2: Advanced Filters (Collapsible) */}
      {showAdvanced && (
        <div className="border-t pt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-4">
            <MultiSelectFilter
              label="Voice"
              options={VOICE_OPTIONS}
              selected={filters.voices}
              onChange={(value: string[]) => setField('voices', value)}
            />
            <MultiSelectFilter
              label="Language"
              options={LANGUAGE_OPTIONS}
              selected={filters.languages}
              onChange={(value: string[]) => setField('languages', value)}
            />
            <MultiSelectFilter
              label="Session Type"
              options={SESSION_TYPE_OPTIONS}
              selected={filters.sessionTypes}
              onChange={(value: string[]) => setField('sessionTypes', value)}
            />
            <MultiSelectFilter
              label="Status"
              options={STATUS_OPTIONS}
              selected={filters.statuses}
              onChange={(value: string[]) => setField('statuses', value)}
            />
            <MultiSelectFilter
              label="Ended By"
              options={ENDED_BY_OPTIONS}
              selected={filters.endedBy}
              onChange={(value: string[]) => setField('endedBy', value)}
            />

            {/* Crisis Flagged Filter */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-semibold text-gray-700">Crisis Flagged</label>
              <div className="flex flex-col gap-2 border rounded p-2 bg-gray-50">
                {[
                  { value: '', label: 'All' },
                  { value: 'true', label: 'Yes' },
                  { value: 'false', label: 'No' }
                ].map(opt => (
                  <label key={opt.value} className="flex items-center gap-2 cursor-pointer hover:bg-gray-100 px-1 rounded">
                    <input
                      type="radio"
                      name="crisisFlagged"
                      value={opt.value}
                      checked={filters.crisisFlagged === opt.value}
                      onChange={(e) => setField('crisisFlagged', e.target.value)}
                      className="accent-royal"
                    />
                    <span className="text-sm">{opt.label}</span>
                  </label>
                ))}
              </div>
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
