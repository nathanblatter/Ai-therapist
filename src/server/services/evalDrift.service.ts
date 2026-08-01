// Eval drift monitoring (ai-therapist-84): after each stored eval, compare the
// rolling mean of each rubric dimension (per ai_model + prompt_version bucket)
// against a prior baseline. A drop beyond the configured threshold opens an
// admin-visible alert (eval_drift_alerts) and, only when explicitly opted in
// (evals.drift_page_enabled) AND the crisis channel is enabled, pages on-call
// via the existing crisis iMessage channel. Never throws.
import {
  getEvalBuckets,
  getRecentDimensionScores,
  insertDriftAlert,
  markDriftAlertPaged,
} from '../db/index.js';
import { EVAL_DIMENSIONS } from './sessionEval.service.js';
import { getSystemConfig } from '../utils/sessionHelpers.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('evalDrift');

export interface DriftConfig {
  drift_window?: number; // rolling window, default 20
  drift_baseline?: number; // baseline sample size, default 100
  drift_threshold?: number; // mean-drop trigger in points, default 0.5
  drift_min_window?: number; // min evals in window to judge, default 10
  drift_page_enabled?: boolean; // page on-call via crisis iMessage channel, default false
}

const DEFAULTS = {
  window: 20,
  baseline: 100,
  threshold: 0.5,
  minWindow: 10,
};

async function getDriftConfig(): Promise<DriftConfig> {
  const config = await getSystemConfig();
  return ((config.evals ?? {}) as DriftConfig) || {};
}

export interface DriftComputation {
  rollingMean: number;
  baselineMean: number;
  drop: number; // baselineMean - rollingMean
  windowN: number;
  baselineN: number;
}

/** Pure: given newest-first scores, split [0..window) vs [window..window+baseline),
 *  return the drift computation or null when either side has < minWindow samples. */
export function computeDrift(
  scores: number[],
  window: number,
  baseline: number,
  minWindow: number
): DriftComputation | null {
  const windowScores = scores.slice(0, window);
  const baselineScores = scores.slice(window, window + baseline);
  if (windowScores.length < minWindow || baselineScores.length < minWindow) return null;

  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const rollingMean = mean(windowScores);
  const baselineMean = mean(baselineScores);
  return {
    rollingMean,
    baselineMean,
    drop: baselineMean - rollingMean,
    windowN: windowScores.length,
    baselineN: baselineScores.length,
  };
}

/** For every (ai_model, prompt_version) bucket and every EVAL_DIMENSIONS dim:
 *  fetch recent scores, computeDrift, and when drop >= threshold insert an open
 *  alert (dedup via the partial unique index). On a successful insert, if
 *  drift_page_enabled === true, page via sendCrisisAlert then markDriftAlertPaged.
 *  All errors caught + logged; never throws. */
export async function checkEvalDrift(): Promise<{ checked: number; alerted: number }> {
  let checked = 0;
  let alerted = 0;
  try {
    const cfg = await getDriftConfig();
    const window = cfg.drift_window ?? DEFAULTS.window;
    const baseline = cfg.drift_baseline ?? DEFAULTS.baseline;
    const threshold = cfg.drift_threshold ?? DEFAULTS.threshold;
    const minWindow = cfg.drift_min_window ?? DEFAULTS.minWindow;
    const pageEnabled = cfg.drift_page_enabled === true;

    const buckets = await getEvalBuckets(minWindow);
    for (const bucket of buckets) {
      for (const dimension of EVAL_DIMENSIONS) {
        checked++;
        try {
          const scores = await getRecentDimensionScores(
            dimension,
            bucket.ai_model,
            bucket.prompt_version,
            window + baseline
          );
          const drift = computeDrift(scores, window, baseline, minWindow);
          if (!drift || drift.drop < threshold) continue;

          const round2 = (n: number) => Math.round(n * 100) / 100;
          const inserted = await insertDriftAlert({
            dimension,
            ai_model: bucket.ai_model,
            prompt_version: bucket.prompt_version,
            rolling_mean: round2(drift.rollingMean),
            baseline_mean: round2(drift.baselineMean),
            drop_amount: round2(drift.drop),
            window_n: drift.windowN,
            baseline_n: drift.baselineN,
          });
          if (!inserted) continue; // open alert already exists for this bucket
          alerted++;

          if (pageEnabled) {
            try {
              const { sendCrisisAlert } = await import('./crisisAlert.service.js');
              await sendCrisisAlert(
                `[EVAL DRIFT] ${dimension} rolling mean ${round2(drift.rollingMean).toFixed(2)} vs baseline ` +
                  `${round2(drift.baselineMean).toFixed(2)} (drop ${round2(drift.drop).toFixed(2)}, n=${drift.windowN}) — model ` +
                  `${bucket.ai_model ?? 'unknown'}, prompt ${bucket.prompt_version}. Check Admin > Analytics.`
              );
              await markDriftAlertPaged(inserted.alert_id);
            } catch (pageErr) {
              log.error({ err: pageErr }, 'Failed to page drift alert');
            }
          }
        } catch (dimErr) {
          log.error({ err: dimErr }, `Drift check failed for ${dimension}/${bucket.ai_model}`);
        }
      }
    }
  } catch (err) {
    log.error({ err }, 'Eval drift check failed');
  }
  return { checked, alerted };
}

/** Fire-and-forget wrapper (mirrors maybeAutoEvalSession's shape). */
export function maybeCheckEvalDrift(): void {
  checkEvalDrift().catch(err => log.error({ err }, 'maybeCheckEvalDrift failed'));
}
