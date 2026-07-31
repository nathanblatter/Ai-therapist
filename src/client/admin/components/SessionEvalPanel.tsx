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
        </div>
      )}
    </div>
  );
}
