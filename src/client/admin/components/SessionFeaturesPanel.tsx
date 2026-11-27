// Read-only panel inside SessionDetail: the structured per-session features
// of an ended session (ai-therapist-172). An automated judge codes the
// redacted transcript on a fixed codebook; this lists what it found, by
// codebook group. Researcher-only (the route enforces it). Renders nothing
// when the session has no row, which is every session while
// system_config.session_features is off.
import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle } from 'react-feather';
import { getJson, HttpError } from '../../shared/http';
// Canonical shapes live in the server codebook module (type-only import,
// erased at build time).
import type { FeatureSummaryGroup, FeatureSummaryItem } from '../../../server/services/sessionFeatures';

export interface SessionFeaturesRead {
  status: 'extracted' | 'too_short' | 'errored';
  stale: boolean;
  feature_set_version: string;
  model: string | null;
  extracted_at: string;
  transcript_truncated: boolean;
  unknown_count: number | null;
  groups: FeatureSummaryGroup[];
}

/** States that mean "no answer": shown as such, never as absent. */
const NO_ANSWER = new Set(['uncertain', 'unknown', 'not_stored']);

/** A yes/no variable has one of these states; anything else is a choice option. */
const YES_NO = new Set(['present', 'absent', 'uncertain', 'unknown', 'not_stored']);

/** One group as display text: what is present, the chosen options, and what
 *  could not be told. Absent yes/no variables are left out. */
export function describeGroup(items: FeatureSummaryItem[]): { found: string[]; noAnswer: string[] } {
  const found: string[] = [];
  const noAnswer: string[] = [];
  for (const item of items) {
    if (NO_ANSWER.has(item.state)) noAnswer.push(`${item.label} (${item.state.replace(/_/g, ' ')})`);
    else if (item.state === 'present') found.push(item.label);
    else if (!YES_NO.has(item.state)) found.push(`${item.label}: ${item.state.replace(/_/g, ' ')}`);
  }
  return { found, noAnswer };
}

/** The one-line summary next to the panel title. */
export function summaryLine(features: SessionFeaturesRead): string {
  if (features.status === 'too_short') return 'Too short to code';
  if (features.status === 'errored') return 'Judge gave no answer';
  const items = features.groups.flatMap((g) => g.items);
  const present = items.filter((i) => i.state === 'present').length;
  const noAnswer = items.filter((i) => NO_ANSWER.has(i.state)).length;
  return `${present} present${noAnswer ? ` · ${noAnswer} not determined` : ''}`;
}

export default function SessionFeaturesPanel({ sessionId }: { sessionId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [features, setFeatures] = useState<SessionFeaturesRead | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFeatures(null);
    getJson<{ features: SessionFeaturesRead | null }>(`/admin/api/sessions/${sessionId}/session-features`)
      .then((data) => {
        if (!cancelled) setFeatures(data.features);
      })
      .catch((err) => {
        // 404 = not coded (the normal case while the job is off); 403 = not a
        // researcher. Neither is worth a console error.
        if (err instanceof HttpError && (err.status === 404 || err.status === 403)) return;
        console.error('Failed to fetch session features:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (!features) return null;

  return (
    <div className="mb-4 border rounded-lg bg-white">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left min-h-[44px]"
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-gray-700">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          Session features
        </span>
        <span className="text-xs text-gray-500">
          {features.stale ? 'Out of date · ' : ''}
          {summaryLine(features)}
        </span>
      </button>
      {expanded && (
        <div className="px-4 pb-4 text-sm text-gray-700">
          {features.status === 'errored' && (
            <p className="flex items-center gap-2 text-amber-700 mb-2">
              <AlertTriangle size={14} />
              The judge call failed, so this session has not been coded. Nothing here means "absent".
            </p>
          )}
          {features.status === 'too_short' && (
            <p className="mb-2">The session has too little participant speech to code. No variable was judged.</p>
          )}
          {features.stale && (
            <p className="flex items-center gap-2 text-amber-700 mb-2">
              <AlertTriangle size={14} />
              Out of date: the transcript has changed since this was computed (a late message, a corrected redaction or
              a leak review). It will be coded again; do not use these values until then.
            </p>
          )}
          {features.status === 'extracted' && (
            <dl className="grid grid-cols-1 gap-2">
              {features.groups.map((group) => {
                const { found, noAnswer } = describeGroup(group.items);
                return (
                  <div key={group.group}>
                    <dt className="font-medium">{group.title}</dt>
                    <dd>
                      {found.length ? found.join(', ') : 'Nothing coded as present'}
                      {noAnswer.length > 0 && (
                        <span className="block text-xs text-gray-500">Not determined: {noAnswer.join(', ')}</span>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}
          <p className="mt-3 text-xs text-gray-500">
            Coded automatically from the redacted transcript. "Not determined" means the judge was uncertain or gave no
            usable answer for that variable; it does not mean absent. Feature set {features.feature_set_version}
            {features.model ? `, ${features.model}` : ''}, {new Date(features.extracted_at).toLocaleString()}
            {features.transcript_truncated ? '; long session, only its opening and close were coded' : ''}. A research
            measure checked only against invented transcripts so far: not for clinical use.
          </p>
        </div>
      )}
    </div>
  );
}
