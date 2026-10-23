// Thin wrapper over the v1 LLM judge (sessionEval.evaluateSession). Reuses the
// existing session_evals path — no new table (spec §6, §9).
import { evaluateSessionDetailed, EVAL_DIMENSIONS, type EvalDimensionId } from '../server/services/sessionEval.service.js';
import type { CostTracker, RedteamConfig } from './config.js';
import { QUALITY_SCENARIOS } from './scenarios/index.js';
import type { AssertionResult, JudgeScores, Scenario } from './types.js';

export interface JudgeOutcome {
  scores: JudgeScores;
  /** Floor breaches: dimension → { score, floor }. Empty when none. */
  breaches: Array<{ dimension: EvalDimensionId; score: number; floor: number }>;
  /** One `judge-floor:<dimension>` assertion per declared judgeMinScores
   *  floor, so breaches show up in JUnit, summary.json and run diffs. Gating
   *  on safety scenarios; on QUALITY scenarios only with --gate-quality. */
  floorAssertions: AssertionResult[];
}

const QUALITY_IDS = new Set(QUALITY_SCENARIOS.map(s => s.id));

/** Whether a judge-floor breach fails this scenario (docs/redteam.md, "Promotion policy"). */
export function floorIsGating(scenario: Scenario, cfg: Pick<RedteamConfig, 'gateQuality'>): boolean {
  return QUALITY_IDS.has(scenario.id) ? cfg.gateQuality : true;
}

/** Build the per-floor assertion results from consensus scores. Pure. */
export function buildFloorAssertions(
  scenario: Scenario,
  scores: Partial<Record<EvalDimensionId, number>>,
  gating: boolean,
): { breaches: JudgeOutcome['breaches']; floorAssertions: AssertionResult[] } {
  const breaches: JudgeOutcome['breaches'] = [];
  const floorAssertions: AssertionResult[] = [];
  for (const [dim, floor] of Object.entries(scenario.judgeMinScores ?? {}) as Array<[EvalDimensionId, number]>) {
    const score = scores[dim];
    const passed = typeof score === 'number' && score >= floor;
    if (!passed && typeof score === 'number') breaches.push({ dimension: dim, score, floor });
    floorAssertions.push({
      id: `judge-floor:${dim}`,
      passed,
      gating,
      detail: typeof score === 'number' ? `${dim}=${score} (floor ${floor})` : `${dim} not scored (floor ${floor})`,
    });
  }
  return { breaches, floorAssertions };
}

/**
 * Run the v1 judge over an ended session and return its scores plus any
 * judgeMinScores floor breaches. Judge scores are reported; they gate the
 * scenario ONLY when the scenario sets judgeMinScores (spec §6).
 */
export async function runJudge(
  sessionId: string,
  scenario: Scenario,
  cfg: RedteamConfig,
  cost: CostTracker,
): Promise<JudgeOutcome | null> {
  if (cfg.dryRun) {
    // Offline: fabricate perfect scores so the pipeline completes without a key.
    const scores: Partial<Record<EvalDimensionId, number>> = {};
    for (const d of EVAL_DIMENSIONS) scores[d] = 5;
    const dry = buildFloorAssertions(scenario, scores, floorIsGating(scenario, cfg));
    return { scores: { scores, overall: 'dry-run: judge skipped' }, ...dry };
  }

  // judgeModelOverride (--judge-model) pins a single judge; otherwise the
  // configured ensemble (system_config.evals.judge_models) runs.
  const detailed = await evaluateSessionDetailed(sessionId, { force: true, judgeModel: cfg.judgeModelOverride });
  if (!detailed) return null;
  const { row, runs, spread } = detailed;

  // One judge call per (model, run); estimate each (usage not returned).
  if (runs.length === 0) cost.estimate(cfg.judgeModel, 3000, 400);
  for (const run of runs) cost.estimate(run.judgeModel, 3000, 400);

  const scores: Partial<Record<EvalDimensionId, number>> = {};
  for (const d of EVAL_DIMENSIONS) scores[d] = row.rubric[d]?.score;
  const perJudge: NonNullable<JudgeScores['perJudge']> = {};
  for (const run of runs) {
    const key = run.runIndex > 0 ? `${run.judgeModel}#${run.runIndex + 1}` : run.judgeModel;
    const s: Partial<Record<EvalDimensionId, number>> = {};
    for (const d of EVAL_DIMENSIONS) s[d] = run.rubric[d]?.score;
    perJudge[key] = s;
  }

  const { breaches, floorAssertions } = buildFloorAssertions(scenario, scores, floorIsGating(scenario, cfg));

  return {
    scores: { scores, overall: row.overall_comments ?? null, judgeModel: row.judge_model, perJudge, spread },
    breaches,
    floorAssertions,
  };
}
