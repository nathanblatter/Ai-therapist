// Collapsible panel inside SessionDetail showing the LLM-judge quality scores
// for an ended session (eval harness v1), with a button to run/re-run the
// judge on demand. Backed by routes/admin/evals.routes.ts.
import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, RefreshCw } from 'react-feather';
import { toast } from '../../shared/components/Toast';

interface EvalDimension {
  score: number;
  rationale: string;
}

interface HumanRatingDimension {
  score: number;
  note?: string;
}

interface HumanRating {
  rating_id: number;
  rater_user_id: number;
  rater_username?: string;
  rubric: Record<string, HumanRatingDimension>;
  overall_notes: string | null;
  rubric_version: string;
  updated_at: string;
}

interface SessionEval {
  eval_id: number;
  rubric: Record<string, EvalDimension>;
  overall_comments: string | null;
  judge_model: string;
  prompt_version: string;
  created_at: string;
}

interface SessionEvalPanelProps {
  sessionId: string;
  sessionStatus?: string;
}

// Display order + labels for the rubric dimensions (matches EVAL_DIMENSIONS
// in sessionEval.service.ts).
const DIMENSION_LABELS: Array<[string, string]> = [
  ['safety_protocol', 'Safety protocol'],
  ['empathy', 'Empathy / reflective listening'],
  ['modality_fidelity', 'Modality fidelity'],
  ['disclaimer_compliance', 'Disclaimer compliance'],
  ['non_directiveness', 'Non-directiveness'],
  ['clinical_claims', 'No hallucinated clinical claims'],
];

function scoreClasses(score: number): string {
  if (score >= 4) return 'bg-green-100 text-green-800';
  if (score === 3) return 'bg-yellow-100 text-yellow-800';
  return 'bg-red-100 text-red-800';
}

export default function SessionEvalPanel({ sessionId, sessionStatus }: SessionEvalPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [evalRow, setEvalRow] = useState<SessionEval | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [running, setRunning] = useState(false);

  const fetchEval = useCallback(async () => {
    setNotFound(false);
    try {
      const res = await fetch(`/admin/api/sessions/${sessionId}/eval`);
      if (res.status === 404) {
        setNotFound(true);
        setEvalRow(null);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEvalRow(data.eval);
    } catch (err) {
      console.error('Failed to fetch session eval:', err);
    }
  }, [sessionId]);

  useEffect(() => {
    fetchEval();
  }, [fetchEval]);

  const runEval = async (force: boolean) => {
    setRunning(true);
    try {
      const res = await fetch(`/admin/api/sessions/${sessionId}/eval`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.details || data.error || 'Eval failed');
        return;
      }
      setEvalRow(data.eval);
      setNotFound(false);
      toast.success('Eval complete');
    } catch (err) {
      console.error('Eval run failed:', err);
      toast.error('Eval run failed');
    } finally {
      setRunning(false);
    }
  };

  // Evals only apply to ended sessions; hide the panel entirely while live.
  if (sessionStatus !== 'ended') return null;

  const avgScore = evalRow
    ? (
        DIMENSION_LABELS.reduce((sum, [key]) => sum + (evalRow.rubric[key]?.score ?? 0), 0) /
        DIMENSION_LABELS.length
      ).toFixed(1)
    : null;

  return (
    <div className="mb-4 bg-white border border-gray-200 rounded-lg">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-3 text-left hover:bg-gray-50 transition"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          <span className="font-semibold text-navy">Quality Eval (LLM judge)</span>
          {avgScore && (
            <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${scoreClasses(Math.round(Number(avgScore)))}`}>
              avg {avgScore}/5
            </span>
          )}
          {notFound && <span className="text-xs text-gray-500">not evaluated yet</span>}
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-gray-500">
              {evalRow
                ? `Judge: ${evalRow.judge_model} · prompt ${evalRow.prompt_version} · ${new Date(evalRow.created_at).toLocaleString()}`
                : 'Scores the assistant’s conduct on the therapist-quality rubric (see docs/eval-system.md).'}
            </p>
            <button
              onClick={() => runEval(Boolean(evalRow))}
              disabled={running}
              className="flex items-center gap-1 px-3 py-1.5 bg-royal text-white rounded hover:bg-navy transition text-sm disabled:opacity-50 min-h-[36px]"
            >
              <RefreshCw size={14} className={running ? 'animate-spin' : ''} />
              {running ? 'Evaluating…' : evalRow ? 'Re-run eval' : 'Run eval'}
            </button>
          </div>

          {evalRow && (
            <div className="space-y-2">
              {DIMENSION_LABELS.map(([key, label]) => {
                const dim = evalRow.rubric[key];
                if (!dim) return null;
                return (
                  <div key={key} className="flex items-start gap-3 p-2 bg-gray-50 rounded">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-bold shrink-0 ${scoreClasses(dim.score)}`}>
                      {dim.score}/5
                    </span>
                    <div>
                      <p className="text-sm font-medium text-gray-900">{label}</p>
                      <p className="text-xs text-gray-600">{dim.rationale}</p>
                    </div>
                  </div>
                );
              })}
              {evalRow.overall_comments && (
                <div className="p-2 bg-blue-50 border-l-2 border-royal rounded text-sm text-gray-800">
                  <span className="font-medium">Overall: </span>
                  {evalRow.overall_comments}
                </div>
              )}
            </div>
          )}

          <HumanRatingSection sessionId={sessionId} />
        </div>
      )}
    </div>
  );
}

// ---- Human rating subsection (ai-therapist-80) ----

function avgRating(rubric: Record<string, HumanRatingDimension>): string {
  const scores = DIMENSION_LABELS.map(([k]) => rubric[k]?.score).filter((s): s is number => typeof s === 'number');
  if (!scores.length) return '—';
  return (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);
}

function HumanRatingSection({ sessionId }: { sessionId: string }) {
  const [ratings, setRatings] = useState<HumanRating[]>([]);
  const [myUserId, setMyUserId] = useState<number | null>(null);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [overallNotes, setOverallNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [expandedOther, setExpandedOther] = useState<number | null>(null);

  const applyMine = useCallback((mine: HumanRating | undefined) => {
    if (!mine) return;
    const s: Record<string, number> = {};
    const n: Record<string, string> = {};
    for (const [key] of DIMENSION_LABELS) {
      if (mine.rubric[key]) {
        s[key] = mine.rubric[key].score;
        if (mine.rubric[key].note) n[key] = mine.rubric[key].note as string;
      }
    }
    setScores(s);
    setNotes(n);
    setOverallNotes(mine.overall_notes ?? '');
  }, []);

  const fetchRatings = useCallback(async () => {
    try {
      const res = await fetch(`/admin/api/sessions/${sessionId}/human-ratings`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRatings(data.ratings ?? []);
      setMyUserId(data.my_user_id ?? null);
      const mine = (data.ratings ?? []).find((r: HumanRating) => r.rater_user_id === data.my_user_id);
      applyMine(mine);
    } catch (err) {
      console.error('Failed to fetch human ratings:', err);
    }
  }, [sessionId, applyMine]);

  useEffect(() => {
    fetchRatings();
  }, [fetchRatings]);

  const mine = ratings.find(r => r.rater_user_id === myUserId);
  const others = ratings.filter(r => r.rater_user_id !== myUserId);
  const allChosen = DIMENSION_LABELS.every(([key]) => typeof scores[key] === 'number');

  const save = async () => {
    if (!allChosen) return;
    setSaving(true);
    try {
      const rubric: Record<string, HumanRatingDimension> = {};
      for (const [key] of DIMENSION_LABELS) {
        rubric[key] = { score: scores[key] };
        if (notes[key]?.trim()) rubric[key].note = notes[key].trim();
      }
      const res = await fetch(`/admin/api/sessions/${sessionId}/human-rating`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rubric, overall_notes: overallNotes || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to save rating');
        return;
      }
      toast.success('Rating saved');
      await fetchRatings();
    } catch (err) {
      console.error('Failed to save rating:', err);
      toast.error('Failed to save rating');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 pt-4 border-t border-gray-200">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-navy">Human rating</h4>
        {mine && (
          <span className="text-xs text-gray-500">
            Your rating · saved {new Date(mine.updated_at).toLocaleString()}
          </span>
        )}
      </div>

      <div className="space-y-2">
        {DIMENSION_LABELS.map(([key, label]) => (
          <div key={key} className="flex flex-col gap-1 p-2 bg-gray-50 rounded">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-gray-900">{label}</span>
              <div className="flex gap-1 shrink-0">
                {[1, 2, 3, 4, 5].map(n => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setScores(prev => ({ ...prev, [key]: n }))}
                    className={`w-7 h-7 rounded text-xs font-bold border transition ${
                      scores[key] === n
                        ? `${scoreClasses(n)} border-transparent`
                        : 'bg-white text-gray-500 border-gray-300 hover:bg-gray-100'
                    }`}
                    aria-pressed={scores[key] === n}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <input
              type="text"
              value={notes[key] ?? ''}
              onChange={e => setNotes(prev => ({ ...prev, [key]: e.target.value }))}
              placeholder="Optional note"
              className="text-xs border border-gray-200 rounded px-2 py-1 w-full"
            />
          </div>
        ))}
      </div>

      <textarea
        value={overallNotes}
        onChange={e => setOverallNotes(e.target.value)}
        rows={2}
        maxLength={4000}
        placeholder="Overall notes (optional)"
        className="mt-2 w-full text-sm border border-gray-200 rounded px-2 py-1"
      />

      <button
        onClick={save}
        disabled={saving || !allChosen}
        className="mt-2 px-3 py-1.5 bg-royal text-white rounded hover:bg-navy transition text-sm disabled:opacity-50 min-h-[36px]"
      >
        {saving ? 'Saving…' : 'Save rating'}
      </button>
      {!allChosen && <p className="mt-1 text-xs text-gray-500">Choose all six scores to save.</p>}

      {others.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold text-gray-600 mb-1">Other raters</p>
          <div className="space-y-1">
            {others.map(r => (
              <div key={r.rating_id} className="text-xs">
                <button
                  type="button"
                  onClick={() => setExpandedOther(expandedOther === r.rating_id ? null : r.rating_id)}
                  className="flex items-center gap-1 text-gray-700 hover:text-navy"
                >
                  {expandedOther === r.rating_id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span className="font-medium">{r.rater_username ?? `user ${r.rater_user_id}`}</span>
                  <span className="text-gray-500">· avg {avgRating(r.rubric)}/5 · {new Date(r.updated_at).toLocaleDateString()}</span>
                </button>
                {expandedOther === r.rating_id && (
                  <div className="mt-1 ml-4 space-y-0.5">
                    {DIMENSION_LABELS.map(([key, label]) => (
                      <div key={key} className="flex justify-between gap-2">
                        <span className="text-gray-600">{label}</span>
                        <span className="font-semibold">{r.rubric[key]?.score ?? '—'}/5</span>
                      </div>
                    ))}
                    {r.overall_notes && <p className="text-gray-600 italic mt-1">{r.overall_notes}</p>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
