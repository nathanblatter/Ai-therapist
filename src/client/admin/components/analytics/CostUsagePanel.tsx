import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { DollarSign, Activity, Clock, MessageSquare } from 'react-feather';
import useAdminFetch from '../../hooks/useAdminFetch';
import Panel from '../ui/Panel';
import StatCard from '../ui/StatCard';
// Canonical aggregate shape lives in the server data layer (type-only import,
// erased at build time).
import type { FeedbackAggregate } from '../../../../server/db/feedback.queries';

// Cost / token tracking (ai-therapist-25c), extracted from Analytics.tsx into
// the Cost tab (ai-therapist-120). Fetches lazily: mounting only happens when
// the tab is opened.

interface CostTotals {
  total_calls: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_estimated_cost_usd: number;
  total_realtime_minutes: number;
  total_realtime_responses: number;
  total_realtime_cost_usd: number;
}

interface DailySpendRow {
  date: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  estimated_cost_usd: number;
  realtime_cost_usd: number;
}

interface CostAnalyticsData {
  totals: CostTotals;
  daily_spend: DailySpendRow[];
  feedback: FeedbackAggregate;
}

export default function CostUsagePanel() {
  const { data, loading, error } = useAdminFetch<CostAnalyticsData>('/admin/api/analytics/cost');

  if (loading) {
    return (
      <Panel><p className="text-gray-500 text-center py-4">Loading cost analytics...</p></Panel>
    );
  }
  if (error || !data) {
    return (
      <Panel><p className="text-red-600 text-center py-4">{error || 'No cost analytics available'}</p></Panel>
    );
  }

  const dailySpendData = data.daily_spend.slice().reverse().map(d => ({
    date: new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    cost: Math.round(d.estimated_cost_usd * 10000) / 10000,
    realtimeCost: Math.round((d.realtime_cost_usd ?? 0) * 10000) / 10000,
    calls: d.calls,
  }));

  return (
    <div className="space-y-4">
      <h3 className="text-xl font-bold flex items-center gap-2"><DollarSign size={20} /> Cost & Token Tracking</h3>
      <p className="text-sm text-gray-600">
        Estimated LLM spend from tracked token usage: text-pipeline calls (chat, insights, redaction,
        crisis assessment) plus metered realtime voice usage captured per response from the Realtime API
        (text/audio/cached token split). Realtime minutes are a legacy wall-clock estimate kept for reference.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <StatCard label="Est. LLM Spend (all time)" value={`$${data.totals.total_estimated_cost_usd.toFixed(4)}`} icon={DollarSign} />
        <StatCard label="Realtime Voice Spend (metered)" value={`$${(data.totals.total_realtime_cost_usd ?? 0).toFixed(4)}`} icon={DollarSign} />
        <StatCard label="Tracked LLM Calls" value={data.totals.total_calls} icon={Activity} />
        <StatCard label="Realtime Minutes (legacy estimate)" value={data.totals.total_realtime_minutes.toFixed(1)} icon={Clock} />
        <StatCard label="Feedback Responses" value={data.feedback.responses} icon={MessageSquare} />
      </div>

      {dailySpendData.length > 0 && (
        <Panel title="Daily Estimated Spend (Last 30 Days)">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={dailySpendData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip formatter={(value?: number) => `$${(value ?? 0).toFixed(4)}`} />
              <Legend />
              <Bar dataKey="cost" stackId="spend" fill="#0047BA" name="Text LLM Cost (USD)" />
              <Bar dataKey="realtimeCost" stackId="spend" fill="#7C3AED" name="Realtime Voice Cost (USD)" />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      )}

      {data.feedback.responses > 0 && (
        <Panel title="Post-Session Feedback Averages">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="border rounded p-4">
              <p className="text-sm text-gray-600">Helpfulness</p>
              <p className="text-2xl font-bold text-navy mt-1">{data.feedback.avg_helpfulness ?? 'N/A'} / 5</p>
            </div>
            <div className="border rounded p-4">
              <p className="text-sm text-gray-600">Ease of Use</p>
              <p className="text-2xl font-bold text-navy mt-1">{data.feedback.avg_ease ?? 'N/A'} / 5</p>
            </div>
            <div className="border rounded p-4">
              <p className="text-sm text-gray-600">Would Return</p>
              <p className="text-2xl font-bold text-navy mt-1">{data.feedback.avg_would_return ?? 'N/A'} / 5</p>
            </div>
          </div>
        </Panel>
      )}
    </div>
  );
}
