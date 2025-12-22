import { useState, useEffect } from "react";
import FilterBar from "./FilterBar";

export default function SessionList({ onViewSession }) {
  const [sessions, setSessions] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 50, totalCount: 0 });
  const [filters, setFilters] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchSessions = async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        page: pagination.page,
        limit: pagination.limit,
        ...Object.fromEntries(
          Object.entries(filters).filter(([_, v]) => v !== '' && v !== null)
        )
      });

      const response = await fetch(`/admin/api/sessions?${params}`);
      if (!response.ok) throw new Error('Failed to fetch sessions');

      const data = await response.json();
      setSessions(data.sessions);
      setPagination(data.pagination);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSessions();
  }, [filters, pagination.page]);

  const formatDuration = (seconds) => {
    if (!seconds) return '0s';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleString();
  };

  const handlePageChange = (newPage) => {
    setPagination(prev => ({ ...prev, page: newPage }));
  };

  const totalPages = Math.ceil(pagination.totalCount / pagination.limit);

  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-4">Session History</h2>

      <FilterBar onFilterChange={setFilters} />

      {loading && (
        <div className="text-center py-8">
          <p className="text-gray-500">Loading sessions...</p>
        </div>
      )}

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mt-4">
          Error: {error}
        </div>
      )}

      {!loading && !error && sessions.length === 0 && (
        <div className="text-center py-8">
          <p className="text-gray-500">No sessions found</p>
        </div>
      )}

      {!loading && !error && sessions.length > 0 && (
        <>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full bg-white rounded-lg shadow">
              <thead className="bg-byuNavy text-white">
                <tr>
                  <th className="px-4 py-3 text-left">Session ID</th>
                  <th className="px-4 py-3 text-left">Start Time</th>
                  <th className="px-4 py-3 text-left">Duration</th>
                  <th className="px-4 py-3 text-left">Messages</th>
                  <th className="px-4 py-3 text-left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session, idx) => (
                  <tr key={session.session_id} className={`hover:bg-gray-50 ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                    <td className="px-4 py-3 font-mono text-sm">{session.session_id}</td>
                    <td className="px-4 py-3">{formatDate(session.start_time)}</td>
                    <td className="px-4 py-3">{formatDuration(session.duration_seconds)}</td>
                    <td className="px-4 py-3">
                      <span className="text-byuRoyal font-semibold">{session.total_messages}</span>
                      <span className="text-sm text-gray-500 ml-2">
                        ({session.user_messages}U / {session.assistant_messages}A)
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => onViewSession(session.session_id)}
                        className="bg-byuRoyal text-white px-3 py-1 rounded hover:bg-byuNavy transition"
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex justify-between items-center">
            <div className="text-sm text-gray-600">
              Showing {Math.min((pagination.page - 1) * pagination.limit + 1, pagination.totalCount)} - {Math.min(pagination.page * pagination.limit, pagination.totalCount)} of {pagination.totalCount} sessions
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => handlePageChange(pagination.page - 1)}
                disabled={pagination.page === 1}
                className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <span className="px-4 py-2">
                Page {pagination.page} of {totalPages}
              </span>
              <button
                onClick={() => handlePageChange(pagination.page + 1)}
                disabled={pagination.page >= totalPages}
                className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
