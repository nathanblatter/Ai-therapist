// Read-only panel inside SessionDetail: the linguistic working-alliance
// markers for an ended session (ai-therapist-173). An automated judge rates
// Task, Bond and Goal from the redacted transcript; this shows the stored
// numbers. Researcher-only (the route enforces it). Renders nothing when the
// session has no rating, which is every session while
// system_config.alliance_markers is off.
import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle } from 'react-feather';
import { getJson, HttpError } from '../../shared/http';
// Canonical row shape lives in the server data layer (type-only import,
// erased at build time).
import type { AllianceRatingRow } from '../../../server/db/allianceRatings.queries';

const SUBSCALES = [
  ['task', 'Task', 'Agreement on what to do in the session, and that it is useful'],
  ['bond', 'Bond', 'Liking, trust and respect; feeling understood'],
  ['goal', 'Goal', 'Agreement on what the work is for'],
] as const;

/** One subscale as display text: "4 of 5 (mean 4.21, 78% on that level)" or "Not rateable". */
export function describeSubscale(row: AllianceRatingRow, subscale: 'task' | 'bond' | 'goal'): string {
  if (row.status === 'errored') return 'No answer';
  if (row[`${subscale}_rateable`] !== true) return 'Not rateable';
  const level = row[`${subscale}_level`];
  const score = row[`${subscale}_score`];
  const confidence = row[`${subscale}_confidence`];
  const mean = typeof score === 'number' ? `mean ${score.toFixed(2)}` : null;
  const share = typeof confidence === 'number' ? `${Math.round(confidence * 100)}% on that level` : null;
  const detail = [mean, share].filter(Boolean).join(', ');
  return `${level} of 5${detail ? ` (${detail})` : ''}`;
}

export default function SessionAlliancePanel({ sessionId }: { sessionId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [rating, setRating] = useState<AllianceRatingRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRating(null);
    getJson<{ rating: AllianceRatingRow | null }>(`/admin/api/sessions/${sessionId}/alliance-rating`)
      .then((data) => {
        if (!cancelled) setRating(data.rating);
      })
      .catch((err) => {
        // 404 = not rated (the normal case while the job is off); 403 = not a
        // researcher. Neither is worth a console error.
        if (err instanceof HttpError && (err.status === 404 || err.status === 403)) return;
        console.error('Failed to fetch alliance rating:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (!rating) return null;

  return (
    <div className="mb-4 border rounded-lg bg-white">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left min-h-[44px]"
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-gray-700">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          Working-alliance markers
        </span>
        <span className="text-xs text-gray-500">
          {rating.status === 'rated'
            ? SUBSCALES.map(
                ([key, label]) => `${label} ${rating[`${key}_rateable`] ? rating[`${key}_level`] : 'n/r'}`,
              ).join(' · ')
            : rating.status === 'too_short'
              ? 'Too short to rate'
              : 'Judge gave no answer'}
        </span>
      </button>
      {expanded && (
        <div className="px-4 pb-4 text-sm text-gray-700">
          {rating.status === 'errored' && (
            <p className="flex items-center gap-2 text-amber-700 mb-2">
              <AlertTriangle size={14} />
              The judge call failed, so this session has no rating. It is not a low score.
            </p>
          )}
          <dl className="grid grid-cols-1 gap-2">
            {SUBSCALES.map(([key, label, meaning]) => (
              <div key={key} className="flex flex-col sm:flex-row sm:items-baseline sm:gap-3">
                <dt className="font-medium w-16">{label}</dt>
                <dd>
                  {describeSubscale(rating, key)}
                  <span className="block text-xs text-gray-500">{meaning}</span>
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-gray-500">
            Rated automatically from the redacted transcript on a 1 to 5 scale (5 = strongest). "Not rateable" means the
            session held too little evidence for that subscale. Judge {rating.judge_version}
            {rating.model ? `, ${rating.model}` : ''}, {new Date(rating.rated_at).toLocaleString()}
            {rating.transcript_truncated ? '; long session, only its opening and close were rated' : ''}. A research
            measure that has not yet been validated against the weekly self-report: not for clinical use.
          </p>
        </div>
      )}
    </div>
  );
}
