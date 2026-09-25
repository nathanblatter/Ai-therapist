// Structured risk-ladder panel (ai-therapist-198).
//
// The run_risk_check tool logs a C-SSRS-style ladder (ideation -> plan ->
// means -> timeframe -> intent, plus protective_factors) into risk_check_steps.
// That is the highest-quality risk instrument the platform has, and until now
// it had NO clinical surface: the rows only reached a human buried inside an
// adverse-event draft's timeline. This renders a compact read of one session's
// ladder (SessionDetail, CrisisManagement) or every ladder a participant has
// (ParticipantProfile).
//
// Summary-tier viewers (caseworkers) get the rungs, bands and timestamps but
// no `answer` text — the server drops it (tierScrub RISK_CHECK_STEP_SUMMARY_
// FIELDS), so the component simply renders what it is given.
import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, CheckSquare } from 'react-feather';

export type RiskBand = 'none' | 'low' | 'moderate' | 'high' | 'imminent';

interface LadderStep {
  check_step_id: number;
  session_id: string;
  step: string;
  /** Absent for summary-tier viewers. */
  answer?: string;
  risk_band: RiskBand;
  sequence: number;
  created_at: string;
}

export interface Ladder {
  session_id: string;
  steps: LadderStep[];
  resolved_band: RiskBand | null;
  furthest_step: string | null;
  completed: boolean;
  started_at: string | null;
  last_step_at: string | null;
}

type Props =
  | { sessionId: string; userId?: never; onViewSession?: (sessionId: string) => void }
  | { userId: number; sessionId?: never; onViewSession?: (sessionId: string) => void };

// Core rungs in order; protective_factors is a counterweight, not a rung.
const LADDER_ORDER = ['ideation', 'plan', 'means', 'timeframe', 'intent'] as const;

const STEP_LABEL: Record<string, string> = {
  ideation: 'Ideation',
  plan: 'Plan',
  means: 'Means',
  timeframe: 'Timeframe',
  intent: 'Intent',
  protective_factors: 'Protective factors',
};

// Band vocabulary mirrors the shared severity palette (medium/moderate amber,
// high red); imminent is the only stronger tone. No orange anywhere.
const BAND_CLASS: Record<RiskBand, string> = {
  none: 'bg-gray-100 text-gray-600',
  low: 'bg-green-100 text-green-800',
  moderate: 'bg-amber-100 text-amber-800',
  high: 'bg-red-100 text-red-800',
  imminent: 'bg-red-600 text-white',
};

function bandClass(band: RiskBand | null): string {
  return band ? BAND_CLASS[band] ?? 'bg-gray-100 text-gray-600' : 'bg-gray-100 text-gray-600';
}

/** The rung track: which core questions were asked, in order. */
function LadderTrack({ steps }: { steps: LadderStep[] }) {
  const asked = new Map(steps.map(s => [s.step, s]));
  return (
    <div className="flex flex-wrap items-center gap-1">
      {LADDER_ORDER.map((rung, i) => {
        const hit = asked.get(rung);
        return (
          <span key={rung} className="flex items-center gap-1">
            {i > 0 && <span className="text-gray-300" aria-hidden="true">&rarr;</span>}
            <span
              className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                hit ? bandClass(hit.risk_band) : 'bg-white text-gray-400 border border-dashed border-gray-300'
              }`}
            >
              {STEP_LABEL[rung]}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function LadderBody({ ladder, onViewSession }: { ladder: Ladder; onViewSession?: (id: string) => void }) {
  const protective = ladder.steps.filter(s => s.step === 'protective_factors');
  return (
    <div className="bg-white rounded p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`px-2 py-0.5 rounded text-xs font-semibold ${bandClass(ladder.resolved_band)}`}>
          resolved: {ladder.resolved_band ?? 'unrated'}
        </span>
        <span className="text-xs text-gray-500">
          {ladder.completed ? 'ladder completed through intent' : `reached ${STEP_LABEL[ladder.furthest_step ?? ''] ?? 'no core rung'}`}
        </span>
        {protective.length > 0 && (
          <span className="text-xs text-gray-500">{protective.length} protective-factor note{protective.length === 1 ? '' : 's'}</span>
        )}
        {onViewSession && (
          <button
            onClick={() => onViewSession(ladder.session_id)}
            className="ml-auto text-xs text-royal hover:underline"
          >
            View session
          </button>
        )}
      </div>

      <LadderTrack steps={ladder.steps} />

      <ol className="space-y-1.5 pt-1">
        {ladder.steps.map(step => (
          <li key={step.check_step_id} className="border-b border-gray-100 last:border-0 pb-1.5 last:pb-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-medium text-gray-700">{step.sequence}. {STEP_LABEL[step.step] ?? step.step}</span>
              <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${bandClass(step.risk_band)}`}>{step.risk_band}</span>
              <span className="text-xs text-gray-400 ml-auto">{new Date(step.created_at).toLocaleString()}</span>
            </div>
            {step.answer
              ? <p className="text-xs text-gray-600 mt-0.5">&ldquo;{step.answer}&rdquo;</p>
              : <p className="text-xs text-gray-400 mt-0.5 italic">Answer text is restricted at your access level.</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function RiskCheckLadder(props: Props) {
  const { sessionId, userId, onViewSession } = props as { sessionId?: string; userId?: number; onViewSession?: (id: string) => void };
  const [expanded, setExpanded] = useState(false);
  const [ladders, setLadders] = useState<Ladder[] | null>(null);
  const [loading, setLoading] = useState(false);

  const url = sessionId
    ? `/admin/api/sessions/${sessionId}/risk-check`
    : `/admin/api/users/${userId}/risk-checks`;

  const fetchLadders = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json() as { ladder?: Ladder; ladders?: Ladder[] };
        const list = data.ladders ?? (data.ladder ? [data.ladder] : []);
        // A session with no ladder still returns an (empty) summary object.
        setLadders(list.filter(l => l.steps.length > 0));
      } else {
        setLadders([]);
      }
    } catch {
      setLadders([]);
    } finally {
      setLoading(false);
    }
  }, [url]);

  // The panel can be re-pointed at another session/participant without
  // remounting (AdminApp reuses mounted instances) — drop stale data.
  useEffect(() => { setLadders(null); }, [url]);

  useEffect(() => {
    if (expanded && ladders === null) void fetchLadders();
  }, [expanded, ladders, fetchLadders]);

  const peak = (ladders ?? []).reduce<RiskBand | null>((acc, l) => {
    const rank: Record<RiskBand, number> = { none: 0, low: 1, moderate: 2, high: 3, imminent: 4 };
    if (!l.resolved_band) return acc;
    return acc === null || rank[l.resolved_band] > rank[acc] ? l.resolved_band : acc;
  }, null);

  return (
    <div className="mb-4 border border-gray-200 bg-gray-50 rounded-lg">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 text-left min-h-[44px]"
        aria-expanded={expanded}
      >
        <span className="text-sm font-semibold text-gray-700 flex items-center gap-2">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <CheckSquare size={16} />
          Structured risk ladder
          {ladders !== null && ladders.length > 0 && peak && (
            <span className={`text-xs px-1.5 py-0.5 rounded font-semibold ${bandClass(peak)}`}>{peak}</span>
          )}
          {ladders !== null && ladders.length === 0 && (
            <span className="text-xs font-normal text-gray-400">none recorded</span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 text-sm">
          {loading && <p className="text-gray-500">Loading risk ladder&hellip;</p>}

          {!loading && ladders !== null && ladders.length === 0 && (
            <p className="text-gray-500 text-xs">
              No structured assessment (run_risk_check) was logged
              {sessionId ? ' in this session' : ' for this participant'}. The automatic keyword/LLM
              risk pipeline is unaffected &mdash; see the risk timeline.
            </p>
          )}

          {(ladders ?? []).map(ladder => (
            <LadderBody
              key={ladder.session_id}
              ladder={ladder}
              onViewSession={userId !== undefined ? onViewSession : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}
