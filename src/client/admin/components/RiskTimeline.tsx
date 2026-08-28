// Per-session risk timeline inside SessionDetail: a sparkline of every
// per-message risk score plus the stage-2 LLM's context judgment and
// reasoning for each scored message, so a reviewer can see WHY a session
// was (or wasn't) flagged. Backed by /admin/api/sessions/:id/risk-history.
import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, Activity } from 'react-feather';
import { riskScoreTextClass } from '../../shared/severity';

interface RiskEntry {
  history_id: string;
  risk_score: number;
  severity: string | null;
  score_factors?: {
    method?: string;
    keywords?: string[];
    llm_context?: string;
    llm_reasoning?: string;
    trajectory_trend?: string;
  } | null;
  calculated_at: string;
}

interface RiskTimelineProps {
  sessionId: string;
}

// Shared score bands (src/client/shared/severity) mirror the server's
// crisisDetection thresholds; medium renders amber, sub-25 muted.
const scoreColor = riskScoreTextClass;

function Sparkline({ scores }: { scores: number[] }) {
  const w = 220;
  const h = 36;
  if (scores.length < 2) return null;
  const step = w / (scores.length - 1);
  const points = scores.map((s, i) => `${(i * step).toFixed(1)},${(h - (s / 100) * h).toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} className="block" aria-label="Risk score sparkline">
      <line x1={0} y1={h - (75 / 100) * h} x2={w} y2={h - (75 / 100) * h} stroke="#fecaca" strokeWidth={1} strokeDasharray="3,3" />
      <line x1={0} y1={h - (50 / 100) * h} x2={w} y2={h - (50 / 100) * h} stroke="#fed7aa" strokeWidth={1} strokeDasharray="3,3" />
      <polyline points={points} fill="none" stroke="#6366f1" strokeWidth={1.5} />
      {scores.map((s, i) =>
        s > 0 ? <circle key={i} cx={i * step} cy={h - (s / 100) * h} r={2.5} fill={s >= 75 ? '#dc2626' : s >= 50 ? '#ea580c' : '#d97706'} /> : null
      )}
    </svg>
  );
}

export default function RiskTimeline({ sessionId }: RiskTimelineProps) {
  const [expanded, setExpanded] = useState(false);
  const [history, setHistory] = useState<RiskEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/admin/api/sessions/${sessionId}/risk-history`);
      if (res.ok) {
        const data = await res.json() as { history: RiskEntry[] };
        setHistory(data.history);
      }
    } catch {
      setHistory([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (expanded && history === null) void fetchHistory();
  }, [expanded, history, fetchHistory]);

  const scored = (history ?? []).filter(e => e.risk_score > 0);
  const maxScore = Math.max(0, ...(history ?? []).map(e => e.risk_score));

  return (
    <div className="mb-4 border border-gray-200 bg-gray-50 rounded-lg">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 text-left min-h-[44px]"
        aria-expanded={expanded}
      >
        <span className="text-sm font-semibold text-gray-700 flex items-center gap-2">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <Activity size={16} />
          Risk timeline
          {history !== null && maxScore > 0 && (
            <span className={`text-xs font-bold ${scoreColor(maxScore)}`}>peak {maxScore}/100</span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 text-sm">
          {loading && <p className="text-gray-500">Loading risk history…</p>}

          {history !== null && history.length === 0 && !loading && (
            <p className="text-gray-500">No messages scored for this session.</p>
          )}

          {history !== null && history.length >= 2 && (
            <div className="bg-white rounded p-3">
              <Sparkline scores={history.map(e => e.risk_score)} />
              <p className="text-xs text-gray-400 mt-1">{history.length} scored messages · dashed lines at 50 (medium) and 75 (high)</p>
            </div>
          )}

          {scored.length > 0 && (
            <div className="bg-white rounded p-3 space-y-2">
              {scored.map(e => {
                const f = e.score_factors ?? {};
                return (
                  <div key={e.history_id} className="border-b border-gray-100 last:border-0 pb-2 last:pb-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`font-bold ${scoreColor(e.risk_score)}`}>{e.risk_score}</span>
                      {e.severity && <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{e.severity}</span>}
                      {f.method && <span className="text-xs font-mono text-gray-400">{f.method}</span>}
                      {f.llm_context && (
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${f.llm_context === 'genuine' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                          {f.llm_context}
                        </span>
                      )}
                      <span className="text-xs text-gray-400 ml-auto">{new Date(e.calculated_at).toLocaleTimeString()}</span>
                    </div>
                    {f.llm_reasoning && <p className="text-xs text-gray-600 mt-0.5">{f.llm_reasoning}</p>}
                    {f.keywords && f.keywords.length > 0 && (
                      <p className="text-xs text-gray-400 mt-0.5">keywords: {f.keywords.join(', ')}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {history !== null && history.length > 0 && scored.length === 0 && (
            <p className="text-gray-500 text-xs">All {history.length} scored messages came back 0 — no risk signals.</p>
          )}
        </div>
      )}
    </div>
  );
}
