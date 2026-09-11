// Counterfactual backend-model sweep — CLI.
//
//   npm run counterfactual -- --session <id> [options]
//
// Options:
//   --session <id>      Session to branch from (required)
//   --mode replay|fork  replay (default) uses the Responses API and works on any
//                       session; fork branches the real GPT-Live session and is
//                       restricted to non-study sessions.
//   --models default|all|<a,b,c>
//   --point <n>         Branch at this message index; omit for the last
//                       participant turn.
//   --risk-spike        Branch at the highest-risk participant turn instead.
//   --judge             Score the candidates with an LLM judge afterwards.
//
// Examples:
//   npm run counterfactual -- --session live_abc --risk-spike --judge
//   npm run counterfactual -- --session live_abc --models all
//   npm run counterfactual -- --session live_abc --mode fork --models gpt-6-astra,gpt-5.6-luna

import { runCounterfactual, findRiskSpikePoint } from '../../server/services/counterfactualEval.service.js';
import { getCounterfactualRun } from '../../server/db/counterfactual.queries.js';
import { getBackendModel } from '../../server/utils/backendModels.js';
import { pool } from '../../server/config/db.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function usd(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : `$${n.toFixed(5)}`;
}

async function main(): Promise<void> {
  const sessionId = arg('session');
  if (!sessionId) {
    console.error('Usage: npm run counterfactual -- --session <id> [--mode replay|fork] [--models default|all|a,b] [--point n] [--risk-spike] [--judge]');
    process.exit(1);
  }

  const modeArg = arg('mode') ?? 'replay';
  if (modeArg !== 'replay' && modeArg !== 'fork') {
    console.error(`Invalid --mode "${modeArg}". Use replay or fork.`);
    process.exit(1);
  }

  const modelsArg = arg('models') ?? 'default';
  const models = modelsArg === 'default' || modelsArg === 'all'
    ? modelsArg
    : modelsArg.split(',').map(s => s.trim()).filter(Boolean);

  let decisionPoint: number | undefined;
  let probeReason = 'manual';
  if (flag('risk-spike')) {
    const spike = await findRiskSpikePoint(sessionId);
    if (spike === null) {
      console.error('No scored risk history on this session; cannot locate a risk spike. Omit --risk-spike.');
      process.exit(1);
    }
    decisionPoint = spike;
    probeReason = 'risk_spike';
  } else if (arg('point')) {
    decisionPoint = Number(arg('point'));
  }

  const summary = await runCounterfactual({
    sessionId,
    mode: modeArg,
    models,
    decisionPoint,
    probeReason,
    judge: flag('judge'),
    createdBy: 'cli',
  });

  const stored = await getCounterfactualRun(summary.runId);
  if (!stored) {
    console.error('Run vanished after completion.');
    process.exit(1);
  }

  console.log('\n' + '='.repeat(78));
  console.log(`Counterfactual run ${summary.runId} — session ${sessionId}`);
  console.log(`mode=${summary.mode}  branch=@${summary.decisionPoint}  baseline=${summary.baselineModel ?? 'unknown'}`);
  console.log('='.repeat(78));
  console.log(`\nParticipant said:\n  "${summary.probeText}"\n`);

  // Cheapest first, so the quality/price tradeoff reads down the page.
  const rows = [...stored.responses].sort((a, b) => {
    const ca = getBackendModel(a.model)?.inputPerMillion ?? Number.MAX_SAFE_INTEGER;
    const cb = getBackendModel(b.model)?.inputPerMillion ?? Number.MAX_SAFE_INTEGER;
    return ca - cb;
  });

  for (const r of rows) {
    console.log('-'.repeat(78));
    if (r.error) {
      console.log(`${r.model}\n  FAILED: ${r.error}`);
      continue;
    }
    const scores = r.judge_scores
      ? Object.entries(r.judge_scores).map(([k, v]) => `${k}=${v}`).join(' ')
      : null;
    console.log(
      `${r.model}   ${usd(r.estimated_cost_usd)}  ${r.latency_ms ?? '—'}ms` +
      `  in=${r.tokens_in ?? '—'} out=${r.tokens_out ?? '—'}`,
    );
    if (scores) console.log(`  judge: ${scores}`);
    if (r.judge_rationale) console.log(`  "${r.judge_rationale}"`);
    console.log(`\n  ${(r.response_text ?? '(empty)').replace(/\n/g, '\n  ')}`);
    if (r.spoken_text) console.log(`\n  SPOKEN: ${r.spoken_text.replace(/\n/g, '\n  ')}`);
  }

  console.log('-'.repeat(78));
  console.log(`\n${summary.succeeded} succeeded, ${summary.failed} failed, of ${summary.candidates} candidates.`);

  if (stored.responses.some(r => r.judge_scores)) {
    const ranked = stored.responses
      .filter(r => r.judge_scores)
      .map(r => ({
        model: r.model,
        total: Object.values(r.judge_scores!).reduce((a, b) => a + b, 0),
        cost: r.estimated_cost_usd,
      }))
      .sort((a, b) => b.total - a.total);
    console.log('\nRanked by judge total:');
    for (const r of ranked) console.log(`  ${r.total.toString().padStart(3)}  ${r.model}  ${usd(r.cost)}`);
  }
}

main()
  .then(() => pool.end())
  .catch(async err => {
    console.error('\nCounterfactual run failed:', err instanceof Error ? err.message : err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
