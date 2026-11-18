// Red-team config drift notice (System Config and System Prompts screens).
//
// Shown whenever the environment's current evaluated configuration (prompts,
// models, crisis and prompt-affecting feature settings; see
// src/server/utils/evaluatedConfig.ts) has no passing red-team evaluation on
// record. Deliberately non-dismissable, and deliberately never blocking: saving
// a configuration and running sessions stay possible, the notice just stays up
// until the redteam-config workflow has evaluated the new configuration and it
// passed. Data: GET /admin/api/config-evaluation/status.
import { useEffect, useState } from 'react';
import { AlertTriangle, Clock, ExternalLink, XCircle } from 'react-feather';
import { getJson } from '../../shared/http';

type EvalState = 'passed' | 'failed' | 'running' | 'unevaluated';

interface EvaluationSummary {
  id: number;
  fingerprint: string;
  status: 'running' | 'passed' | 'failed' | 'error';
  started_at: string;
  finished_at: string | null;
  scenarios_total: number | null;
  scenarios_passed: number | null;
  scenarios_failed: number | null;
  known_gaps: number | null;
  result_url: string | null;
}

export interface ConfigEvalStatus {
  fingerprint: string;
  short_fingerprint: string;
  state: EvalState;
  evaluated: boolean;
  last_change: { at: string | null; by: string | null; key: string | null };
  current_evaluation: EvaluationSummary | null;
  last_evaluated: EvaluationSummary | null;
  reason: string | null;
  runs_last_24h: number;
  daily_cap: number;
  settle_minutes: number;
  table_missing: boolean;
}

const POLL_MS = 60_000;

function fmt(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString() : 'an unknown date';
}

function resultLine(e: EvaluationSummary): string {
  const counts =
    e.scenarios_total !== null
      ? `${e.scenarios_passed ?? 0} of ${e.scenarios_total} scenarios passed` +
        (e.known_gaps ? `, ${e.known_gaps} known gap${e.known_gaps === 1 ? '' : 's'}` : '')
      : 'no totals';
  return `${e.status === 'passed' ? 'Passed' : 'Failed'} on ${fmt(e.finished_at)} (${counts})`;
}

/** The headline sentence, exported for tests. */
export function headline(status: ConfigEvalStatus): string {
  if (!status.last_change.at)
    return 'The AI configuration on this environment has not been through the safety evaluation.';
  return `The AI configuration was changed on ${fmt(status.last_change.at)} by ${
    status.last_change.by ?? 'an unknown user'
  } and has not been through the safety evaluation.`;
}

/** What happens next, exported for tests. */
export function nextStep(status: ConfigEvalStatus): string {
  if (status.table_missing) {
    return 'Evaluation records are not set up on this environment yet (database migration 126).';
  }
  const cur = status.current_evaluation;
  if (status.state === 'running' && cur) {
    return `An evaluation of this configuration has been running since ${fmt(cur.started_at)}.`;
  }
  if (status.state === 'failed' && cur) {
    return `This configuration FAILED the safety evaluation: ${resultLine(cur)}. Correct the configuration (which starts a new evaluation) or ask the study owner to review the results.`;
  }
  if (status.reason === 'daily_cap') {
    return `The daily limit of ${status.daily_cap} automatic evaluations has been reached; it will be evaluated when the limit frees up.`;
  }
  return `It is evaluated automatically once it has been unchanged for ${status.settle_minutes} minutes (checked every 30 minutes).`;
}

export default function ConfigEvalNotice({ refreshKey }: { refreshKey?: unknown }) {
  const [status, setStatus] = useState<ConfigEvalStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getJson<ConfigEvalStatus>('/admin/api/config-evaluation/status')
        .then((s) => {
          if (cancelled) return;
          setStatus(s);
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    void load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshKey]);

  if (failed && !status) {
    return (
      <div
        className="mb-6 p-3 rounded-lg border border-gray-300 bg-gray-50 text-sm text-gray-700 flex gap-2"
        role="status"
      >
        <AlertTriangle size={18} className="flex-shrink-0 mt-0.5 text-gray-500" />
        Safety-evaluation status of the AI configuration is unavailable right now.
      </div>
    );
  }
  if (!status || status.evaluated) return null;

  const isFailed = status.state === 'failed';
  const Icon = isFailed ? XCircle : status.state === 'running' ? Clock : AlertTriangle;
  const tone = isFailed ? 'border-red-300 bg-red-50 text-red-900' : 'border-amber-300 bg-amber-50 text-amber-900';
  const last = status.last_evaluated;

  return (
    <div className={`mb-6 p-4 rounded-lg border ${tone}`} role="alert" data-testid="config-eval-notice">
      <div className="flex gap-3">
        <Icon size={20} className="flex-shrink-0 mt-0.5" />
        <div className="space-y-1 text-sm">
          <p className="font-semibold">{headline(status)}</p>
          <p>{nextStep(status)}</p>
          <p>
            {last
              ? `Last evaluated configuration (${last.fingerprint.slice(0, 12)}): ${resultLine(last)}.`
              : 'No configuration on this environment has been evaluated yet.'}{' '}
            {last?.result_url && (
              <a
                href={last.result_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 underline"
              >
                Results <ExternalLink size={12} />
              </a>
            )}
          </p>
          <p className="text-xs opacity-80">
            Current configuration fingerprint {status.short_fingerprint}. Saving changes and running sessions are not
            blocked by this notice.
          </p>
        </div>
      </div>
    </div>
  );
}
