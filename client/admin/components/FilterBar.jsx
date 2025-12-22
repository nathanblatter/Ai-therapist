import { useState, useEffect } from "react";

export default function FilterBar({ onFilterChange }) {
  const [filters, setFilters] = useState({
    search: '',
    startDate: '',
    endDate: '',
    minMessages: '',
    maxMessages: ''
  });

  // Debounce filter changes
  useEffect(() => {
    const timer = setTimeout(() => {
      onFilterChange(filters);
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
      maxMessages: ''
    };
    setFilters(clearedFilters);
    onFilterChange(clearedFilters);
  };

  return (
    <div className="bg-white p-4 rounded-lg shadow flex flex-wrap gap-4">
      <input
        type="text"
        placeholder="Search session ID..."
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
        onClick={handleClear}
        className="bg-gray-200 px-4 py-2 rounded hover:bg-gray-300"
      >
        Clear Filters
      </button>
    </div>
  );
}
