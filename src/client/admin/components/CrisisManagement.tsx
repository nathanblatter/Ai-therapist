import { useState, useEffect } from 'react';
import { AlertTriangle, Activity, Users, FileText, TrendingUp, Clock, RefreshCw, ChevronDown, ChevronUp, ArrowUpCircle, MessageSquare } from 'react-feather';
import EscalationComposer from './escalations/EscalationComposer';
import FlaggedMessageRow, { useFlaggedMessageEvents } from './FlaggedMessageRow';

interface CrisisEvent {
  event_id: string;
  session_id: string | null;
  // Owning client: user_id/username come from the session join; message-origin
  // events (076) carry client_user_id directly.
  user_id?: number | null;
  username?: string | null;
  client_user_id?: number | null;
  // 076: message-origin crisis events carry origin='thread_message' and a
  // NULL session_id; they render via FlaggedMessageRow, not session grouping.
  origin?: 'session' | 'thread_message';
  severity?: string;
  event_type: string;
  risk_score?: number;
  triggered_by: string;
  trigger_method: string;
  created_at: string;
  notes?: string;
  risk_factors?: unknown;
  intervention_details?: unknown;
}

interface ClinicalReview {
  review_id: string;
  session_id: string;
  review_type: string;
  review_reason: string;
  status: string;
  risk_score?: number;
  requested_at: string;
  assigned_to?: string;
}

interface InterventionAction {
  action_id: string;
  session_id: string;
  action_type: string;
  risk_score?: number;
  performed_by: string;
  performed_at: string;
  outcome?: string;
}

interface RiskScoreHistory {
  history_id: string;
  session_id: string;
  risk_score: number;
  severity?: string;
  calculated_at: string;
  score_factors?: unknown;
}

interface CrisisData {
  clinicalReviews: ClinicalReview[];
  crisisEvents: CrisisEvent[];
  interventionActions: InterventionAction[];
  riskScoreHistory: RiskScoreHistory[];
}

interface CrisisManagementProps {
  /** Navigate to the messaging inbox (flagged-message "View thread"). */
  onOpenMessages?: () => void;
}

export default function CrisisManagement({ onOpenMessages }: CrisisManagementProps = {}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CrisisData>({
    clinicalReviews: [],
    crisisEvents: [],
    interventionActions: [],
    riskScoreHistory: []
  });
  const [activeTab, setActiveTab] = useState('overview');
  const [expandedSessions, setExpandedSessions] = useState(new Set());
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterSeverity, setFilterSeverity] = useState('all');
  // Adverse-event drafts pending review (ai-therapist-95) — crisis staff live here.
  const [aeDrafts, setAeDrafts] = useState(0);
  // "Escalate to therapist" composer, pre-linked to a crisis event AND its
  // client (never default to an unrelated caseload client).
  const [escalateFor, setEscalateFor] = useState<{
    crisisEventId: number;
    sessionId: string | null;
    clientId: number | null;
    clientName: string | null;
  } | null>(null);
  // Message-origin crisis events (076): rendered as flagged-message rows.
  const flaggedMessages = useFlaggedMessageEvents();

  useEffect(() => {
    fetch('/admin/api/adverse-events?status=draft', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d?.counts) setAeDrafts(d.counts.draft ?? 0); })
      .catch(() => { /* best-effort */ });
  }, []);

  useEffect(() => {
    fetchCrisisData();
  }, []);

  const fetchCrisisData = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/admin/api/crisis/all', {
        credentials: 'include'
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.details || errorData.error || `HTTP ${response.status}`);
      }

      const crisisData = await response.json();
      console.log('[CrisisManagement] Fetched data:', {
        clinicalReviews: crisisData.clinicalReviews?.length || 0,
        crisisEvents: crisisData.crisisEvents?.length || 0,
        interventionActions: crisisData.interventionActions?.length || 0,
        riskScoreHistory: crisisData.riskScoreHistory?.length || 0
      });
      setData(crisisData);
    } catch (err: unknown) {
      console.error('[CrisisManagement] Error fetching data:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const toggleSession = (sessionId: string) => {
    const newExpanded = new Set(expandedSessions);
    if (newExpanded.has(sessionId)) {
      newExpanded.delete(sessionId);
    } else {
      newExpanded.add(sessionId);
    }
    setExpandedSessions(newExpanded);
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  };

  const getSeverityColor = (severity: string | undefined) => {
    switch (severity?.toLowerCase()) {
      case 'high': return 'bg-red-100 text-red-800 border-red-300';
      case 'medium': return 'bg-yellow-100 text-yellow-800 border-yellow-300';
      case 'low': return 'bg-green-100 text-green-800 border-green-300';
      default: return 'bg-gray-100 text-gray-800 border-gray-300';
    }
  };

  const getStatusColor = (status: string | undefined) => {
    switch (status?.toLowerCase()) {
      case 'completed': return 'bg-green-100 text-green-800';
      case 'in_progress': return 'bg-blue-100 text-blue-800';
      case 'pending': return 'bg-yellow-100 text-yellow-800';
      case 'cancelled': return 'bg-gray-100 text-gray-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const getRiskScoreColor = (score: number) => {
    if (score >= 70) return 'text-red-600 font-bold';
    if (score >= 40) return 'text-yellow-600 font-semibold';
    return 'text-green-600';
  };

  // Filter crisis events. Message-origin events (origin='thread_message',
  // session_id NULL) are excluded from the session grouping — they render in
  // the dedicated Flagged Messages section below.
  const filteredEvents = data.crisisEvents.filter(event => {
    if (event.origin === 'thread_message' || event.session_id === null) return false;
    if (filterSeverity !== 'all' && event.severity !== filterSeverity) return false;
    return true;
  });

  // Filter clinical reviews
  const filteredReviews = data.clinicalReviews.filter(review => {
    if (filterStatus !== 'all' && review.status !== filterStatus) return false;
    return true;
  });

  // Group events by session
  const eventsBySession = filteredEvents.reduce<Record<string, CrisisEvent[]>>((acc, event) => {
    const sid = event.session_id ?? 'unknown';
    if (!acc[sid]) {
      acc[sid] = [];
    }
    acc[sid].push(event);
    return acc;
  }, {});

  if (loading) {
    return (
      <div className="p-8">
        <div className="flex items-center justify-center h-64">
          <p className="text-gray-500">Loading crisis management data...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6">
          <div className="flex items-start gap-4">
            <AlertTriangle className="text-red-600 flex-shrink-0" size={24} />
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-red-900 mb-2">Failed to Load Crisis Management Data</h3>
              <p className="text-red-800 mb-4">Error: {error}</p>
              <div className="text-sm text-red-700 bg-red-100 rounded p-3 mb-4">
                <strong>Common causes:</strong>
                <ul className="list-disc ml-5 mt-2 space-y-1">
                  <li>Database tables not created (run migration 011)</li>
                  <li>Database connection issues</li>
                  <li>Permission errors</li>
                </ul>
              </div>
              <button
                onClick={fetchCrisisData}
                className="bg-royal text-white px-4 py-2 rounded hover:bg-navy transition"
              >
                Try Again
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-navy flex items-center gap-3">
            <AlertTriangle className="text-red-600" size={32} />
            Crisis Management Dashboard
          </h1>
          <p className="text-gray-600 mt-1">
            Monitor and manage all crisis-related events, interventions, and reviews
          </p>
          {aeDrafts > 0 && (
            <p className="mt-2 inline-flex items-center gap-1.5 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-3 py-1">
              <FileText size={14} />
              {aeDrafts} adverse-event draft{aeDrafts === 1 ? '' : 's'} pending — see the Adverse Events tab
            </p>
          )}
        </div>
        <button
          onClick={fetchCrisisData}
          className="flex items-center gap-2 bg-royal text-white px-4 py-2 rounded-lg hover:bg-navy transition"
        >
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Crisis Events</p>
              <p className="text-2xl font-bold text-red-600">{data.crisisEvents.length}</p>
            </div>
            <AlertTriangle className="text-red-500" size={32} />
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Clinical Reviews</p>
              <p className="text-2xl font-bold text-blue-600">{data.clinicalReviews.length}</p>
              <p className="text-xs text-gray-500">
                {data.clinicalReviews.filter(r => r.status === 'pending').length} pending
              </p>
            </div>
            <FileText className="text-blue-500" size={32} />
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Interventions</p>
              <p className="text-2xl font-bold text-orange-600">{data.interventionActions.length}</p>
            </div>
            <Activity className="text-orange-500" size={32} />
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Risk Assessments</p>
              <p className="text-2xl font-bold text-indigo-600">{data.riskScoreHistory.length}</p>
            </div>
            <TrendingUp className="text-indigo-500" size={32} />
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-lg shadow mb-6">
        <div className="border-b border-gray-200">
          <nav className="flex -mb-px">
            {[
              { id: 'overview', label: 'Overview', icon: Activity },
              { id: 'events', label: 'Crisis Events', icon: AlertTriangle },
              { id: 'reviews', label: 'Clinical Reviews', icon: FileText },
              { id: 'interventions', label: 'Interventions', icon: Activity },
              { id: 'risk-history', label: 'Risk History', icon: TrendingUp }
            ].map(tab => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-6 py-3 border-b-2 font-medium text-sm transition ${
                    activeTab === tab.id
                      ? 'border-royal text-royal'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  <Icon size={16} />
                  {tab.label}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Tab Content */}
        <div className="p-6">
          {/* Overview Tab */}
          {activeTab === 'overview' && (
            <div className="space-y-6">
              {/* Flagged messages (076 thread-origin crisis events). */}
              {flaggedMessages.events.length > 0 && (
                <div>
                  <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                    <MessageSquare size={18} className="text-amber-600" />
                    Flagged Messages
                  </h3>
                  <div className="space-y-2">
                    {flaggedMessages.events.map(event => (
                      <FlaggedMessageRow
                        key={event.event_id}
                        event={event}
                        onOpenThread={onOpenMessages ? () => onOpenMessages() : undefined}
                      />
                    ))}
                  </div>
                </div>
              )}
              <div>
                <h3 className="text-lg font-semibold mb-4">Recent Crisis Activity</h3>
                <div className="space-y-3">
                  {data.crisisEvents.filter(e => e.origin !== 'thread_message').slice(0, 10).map(event => (
                    <div key={event.event_id} className="bg-gray-50 p-4 rounded-lg border border-gray-200">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-2">
                            <span className={`px-3 py-1 rounded-full text-xs font-medium ${getSeverityColor(event.severity)}`}>
                              {event.severity || 'N/A'}
                            </span>
                            <span className="text-sm font-semibold text-gray-700">
                              {event.event_type.replace(/_/g, ' ').toUpperCase()}
                            </span>
                            {event.risk_score && (
                              <span className={`text-sm font-semibold ${getRiskScoreColor(event.risk_score)}`}>
                                Risk: {event.risk_score}
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-gray-600">
                            Session: <code className="bg-white px-2 py-1 rounded text-xs">{event.session_id}</code>
                          </p>
                          <p className="text-xs text-gray-500 mt-1">
                            Triggered by {event.triggered_by} via {event.trigger_method} at {formatDate(event.created_at)}
                          </p>
                          {event.notes && (
                            <p className="text-sm text-gray-700 mt-2 italic">{event.notes}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Crisis Events Tab */}
          {activeTab === 'events' && (
            <div>
              <div className="mb-4 flex items-center gap-4">
                <div>
                  <label className="text-sm font-medium text-gray-700 mr-2">Severity:</label>
                  <select
                    value={filterSeverity}
                    onChange={(e) => setFilterSeverity(e.target.value)}
                    className="px-3 py-2 border rounded-lg text-sm"
                  >
                    <option value="all">All</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </div>
              </div>

              <div className="space-y-4">
                {Object.entries(eventsBySession).map(([sessionId, events]) => (
                  <div key={sessionId} className="bg-white border rounded-lg overflow-hidden">
                    <button
                      onClick={() => toggleSession(sessionId)}
                      className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 transition"
                    >
                      <div className="flex items-center gap-3">
                        <AlertTriangle size={20} className="text-red-500" />
                        <div className="text-left">
                          <p className="font-semibold text-gray-900">Session: {sessionId}</p>
                          <p className="text-sm text-gray-600">{events.length} events</p>
                        </div>
                      </div>
                      {expandedSessions.has(sessionId) ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                    </button>

                    {expandedSessions.has(sessionId) && (
                      <div className="border-t bg-gray-50 p-4">
                        <div className="space-y-3">
                          {events.map(event => (
                            <div key={event.event_id} className="bg-white p-4 rounded-lg border">
                              <div className="flex items-start justify-between mb-2">
                                <div className="flex items-center gap-2">
                                  <span className={`px-2 py-1 rounded-full text-xs font-medium border ${getSeverityColor(event.severity)}`}>
                                    {event.severity || 'N/A'}
                                  </span>
                                  <span className="text-sm font-semibold">
                                    {event.event_type.replace(/_/g, ' ')}
                                  </span>
                                </div>
                                {event.risk_score && (
                                  <span className={`text-lg font-bold ${getRiskScoreColor(event.risk_score)}`}>
                                    {event.risk_score}
                                  </span>
                                )}
                              </div>

                              <div className="grid grid-cols-2 gap-2 text-sm mb-2">
                                <div>
                                  <span className="text-gray-600">Triggered by:</span> {event.triggered_by}
                                </div>
                                <div>
                                  <span className="text-gray-600">Method:</span> {event.trigger_method}
                                </div>
                                <div className="col-span-2">
                                  <span className="text-gray-600">Time:</span> {formatDate(event.created_at)}
                                </div>
                              </div>

                              {Boolean(event.risk_factors) && (
                                <div className="mt-2 p-2 bg-gray-50 rounded text-xs">
                                  <strong>Risk Factors:</strong>
                                  <pre className="mt-1 whitespace-pre-wrap">{JSON.stringify(event.risk_factors, null, 2)}</pre>
                                </div>
                              )}

                              {Boolean(event.intervention_details) && (
                                <div className="mt-2 p-2 bg-blue-50 rounded text-xs">
                                  <strong>Intervention Details:</strong>
                                  <pre className="mt-1 whitespace-pre-wrap">{JSON.stringify(event.intervention_details, null, 2)}</pre>
                                </div>
                              )}

                              {event.notes && (
                                <p className="mt-2 text-sm italic text-gray-700">{event.notes}</p>
                              )}

                              <div className="mt-3">
                                <button
                                  onClick={() => setEscalateFor({
                                    crisisEventId: Number(event.event_id),
                                    sessionId: event.session_id,
                                    clientId: event.client_user_id ?? event.user_id ?? null,
                                    clientName: event.username ?? null,
                                  })}
                                  className="inline-flex items-center gap-1.5 text-sm font-medium text-royal hover:text-navy"
                                >
                                  <ArrowUpCircle size={15} />
                                  Escalate to therapist
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {filteredEvents.length === 0 && (
                  <div className="text-center py-12 text-gray-500">
                    No crisis events found
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Clinical Reviews Tab */}
          {activeTab === 'reviews' && (
            <div>
              <div className="mb-4">
                <label className="text-sm font-medium text-gray-700 mr-2">Status:</label>
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="px-3 py-2 border rounded-lg text-sm"
                >
                  <option value="all">All</option>
                  <option value="pending">Pending</option>
                  <option value="in_progress">In Progress</option>
                  <option value="completed">Completed</option>
                </select>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Session</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Reason</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Risk Score</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Requested</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Assigned To</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {filteredReviews.map(review => (
                      <tr key={review.review_id} className="hover:bg-gray-50">
                        <td className="px-6 py-4">
                          <code className="text-xs bg-gray-100 px-2 py-1 rounded">
                            {review.session_id.substring(0, 12)}...
                          </code>
                        </td>
                        <td className="px-6 py-4 text-sm">{review.review_type.replace(/_/g, ' ')}</td>
                        <td className="px-6 py-4 text-sm">{review.review_reason}</td>
                        <td className="px-6 py-4">
                          <span className={`px-2 py-1 rounded-full text-xs ${getStatusColor(review.status)}`}>
                            {review.status}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          {review.risk_score && (
                            <span className={`font-semibold ${getRiskScoreColor(review.risk_score)}`}>
                              {review.risk_score}
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {formatDate(review.requested_at)}
                        </td>
                        <td className="px-6 py-4 text-sm">{review.assigned_to || 'Unassigned'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {filteredReviews.length === 0 && (
                  <div className="text-center py-12 text-gray-500">
                    No clinical reviews found
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Interventions Tab */}
          {activeTab === 'interventions' && (
            <div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Session</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Action Type</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Risk Score</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Performed By</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Performed At</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Outcome</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {data.interventionActions.map(action => (
                      <tr key={action.action_id} className="hover:bg-gray-50">
                        <td className="px-6 py-4">
                          <code className="text-xs bg-gray-100 px-2 py-1 rounded">
                            {action.session_id.substring(0, 12)}...
                          </code>
                        </td>
                        <td className="px-6 py-4 text-sm font-medium">
                          {action.action_type.replace(/_/g, ' ')}
                        </td>
                        <td className="px-6 py-4">
                          {action.risk_score && (
                            <span className={`font-semibold ${getRiskScoreColor(action.risk_score)}`}>
                              {action.risk_score}
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-sm">{action.performed_by}</td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {formatDate(action.performed_at)}
                        </td>
                        <td className="px-6 py-4 text-sm">{action.outcome || 'N/A'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {data.interventionActions.length === 0 && (
                  <div className="text-center py-12 text-gray-500">
                    No interventions recorded
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Risk History Tab */}
          {activeTab === 'risk-history' && (
            <div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Session</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Risk Score</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Severity</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Calculated At</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Assessment</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {data.riskScoreHistory.map(history => {
                      const f = (history.score_factors ?? {}) as Record<string, unknown>;
                      const method = typeof f.method === 'string' ? f.method : null;
                      const context = typeof f.llm_context === 'string' ? f.llm_context : null;
                      const reasoning = typeof f.llm_reasoning === 'string' ? f.llm_reasoning : null;
                      return (
                      <tr key={history.history_id} className="hover:bg-gray-50">
                        <td className="px-6 py-4">
                          <code className="text-xs bg-gray-100 px-2 py-1 rounded">
                            {history.session_id.substring(0, 12)}...
                          </code>
                        </td>
                        <td className="px-6 py-4">
                          <span className={`text-lg font-bold ${getRiskScoreColor(history.risk_score)}`}>
                            {history.risk_score}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <span className={`px-2 py-1 rounded-full text-xs font-medium border ${getSeverityColor(history.severity)}`}>
                            {history.severity || 'N/A'}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {formatDate(history.calculated_at)}
                        </td>
                        <td className="px-6 py-4 max-w-md">
                          <div className="flex flex-wrap items-center gap-1 mb-1">
                            {method && (
                              <span className="px-1.5 py-0.5 rounded text-xs font-mono bg-gray-100 text-gray-600">{method}</span>
                            )}
                            {context && (
                              <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${context === 'genuine' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                                {context}
                              </span>
                            )}
                          </div>
                          {reasoning && <p className="text-xs text-gray-600">{reasoning}</p>}
                          <details className="text-xs">
                            <summary className="cursor-pointer text-blue-600 hover:text-blue-800">
                              Raw factors
                            </summary>
                            <pre className="mt-2 p-2 bg-gray-100 rounded overflow-x-auto">
                              {JSON.stringify(history.score_factors, null, 2)}
                            </pre>
                          </details>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>

                {data.riskScoreHistory.length === 0 && (
                  <div className="text-center py-12 text-gray-500">
                    No risk score history recorded
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Escalation composer, pre-linked to the crisis event/session. */}
      {escalateFor && (
        <EscalationComposer
          crisisEventId={escalateFor.crisisEventId}
          sessionId={escalateFor.sessionId}
          clientId={escalateFor.clientId ?? undefined}
          clientName={escalateFor.clientName ?? undefined}
          onClose={() => setEscalateFor(null)}
          onCreated={() => setEscalateFor(null)}
        />
      )}
    </div>
  );
}
