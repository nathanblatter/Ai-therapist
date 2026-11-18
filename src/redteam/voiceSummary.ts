// Markdown job summary for the voice red-team workflow (redteam-voice.yml).
//
//   npx tsx src/redteam/voiceSummary.ts redteam-results/summary.json
//
// Reads the summary.json the CLI wrote and appends a readable report to
// $GITHUB_STEP_SUMMARY (stdout when unset): per-scenario result, every gating
// failure with its detail, the GPT-Live client probes, which layer answered
// each beat, and the non-gating notes. It never sets the exit code: the
// workflow goes red from the suite step's own exit code, after the upload.
// Kept separate from report.ts on purpose (that file belongs to the nightly).
import fs from 'node:fs';
import { formatVoiceAggregate, type VoiceAggregate } from './voice/aggregate.js';

interface SummaryAssertion {
  id: string;
  passed: boolean;
  gating: boolean;
  detail: string;
}

interface SummaryScenario {
  id: string;
  passed: boolean;
  assertions: SummaryAssertion[];
  judge?: { scores?: Record<string, number> } | null;
  costUsd: number;
  durationMs: number;
  error?: string;
}

export interface VoiceSummaryJson {
  startedAt?: string;
  finishedAt?: string;
  suite?: string;
  gitSha?: string | null;
  scenarios: SummaryScenario[];
  /** P50/P90 voice metrics (voice/aggregate.ts), when the run produced any. */
  totals?: { voice?: VoiceAggregate | null };
}

/** Table-cell safe: no pipes, no newlines, bounded length. */
function cell(text: string, max = 220): string {
  const flat = text.replace(/\r?\n/g, ' ').replace(/\|/g, '/').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function minutes(ms: number): string {
  return `${(ms / 60_000).toFixed(1)} min`;
}

export type KnownGaps = Record<string, { reason: string; ref: string }>;

export function formatVoiceSummary(s: VoiceSummaryJson, knownGaps: KnownGaps = {}): string {
  const scenarios = s.scenarios ?? [];
  const gapOf = (id: string) => knownGaps[id.replace(/#v\d+$/, '')];
  const passed = scenarios.filter((x) => x.passed).length;
  const gatingFailures = scenarios.flatMap((x) =>
    x.assertions.filter((a) => !a.passed && a.gating).map((a) => ({ scenario: x.id, a })),
  );
  const errored = scenarios.filter((x) => x.error);
  const cost = scenarios.reduce((n, x) => n + (x.costUsd || 0), 0);
  const wall = scenarios.reduce((n, x) => n + (x.durationMs || 0), 0);
  const ok = passed === scenarios.length && scenarios.length > 0;

  const out: string[] = [];
  out.push(`## Red-team ${s.suite && s.suite !== 'voice-safety' ? s.suite : 'voice-safety'} suite (GPT-Live)`);
  out.push('');
  out.push(
    `**${ok ? 'PASS' : 'FAIL'}**: ${passed}/${scenarios.length} scenarios passed, ` +
      `${gatingFailures.length} gating assertion failure(s)${errored.length ? `, ${errored.length} scenario error(s)` : ''}. ` +
      `Estimated cost $${cost.toFixed(2)}, ${minutes(wall)} of scenario time` +
      `${s.gitSha ? `, commit \`${s.gitSha.slice(0, 7)}\`` : ''}.`,
  );
  out.push('');
  out.push('| Scenario | Result | Gating assertions | Judge | Cost | Time |');
  out.push('|---|---|---|---|---|---|');
  for (const x of scenarios) {
    const gating = x.assertions.filter((a) => a.gating);
    const judge = x.judge?.scores
      ? Object.entries(x.judge.scores)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')
      : '-';
    out.push(
      `| ${x.id} | ${x.error ? 'ERROR' : x.passed ? 'pass' : gapOf(x.id) ? `FAIL (known gap ${gapOf(x.id)!.ref})` : 'FAIL'} | ` +
        `${gating.filter((a) => a.passed).length}/${gating.length} | ${cell(judge, 160)} | ` +
        `$${(x.costUsd || 0).toFixed(3)} | ${minutes(x.durationMs || 0)} |`,
    );
  }

  if (gatingFailures.length || errored.length) {
    out.push('');
    out.push('### Failures');
    out.push('');
    for (const x of errored) out.push(`- **${x.id}**: scenario error: ${cell(x.error ?? '', 400)}`);
    for (const { scenario, a } of gatingFailures) out.push(`- **${scenario}** \`${a.id}\`: ${cell(a.detail, 400)}`);
  }

  const gaps = scenarios.filter((x) => !x.passed && gapOf(x.id));
  if (gaps.length) {
    out.push('');
    out.push('### Known gaps (filed, still gating)');
    out.push('');
    for (const x of gaps) out.push(`- **${x.id}** (${gapOf(x.id)!.ref}): ${cell(gapOf(x.id)!.reason, 400)}`);
  }

  const probes = scenarios.flatMap((x) =>
    x.assertions.filter((a) => a.id.startsWith('live-client-probe')).map((a) => ({ scenario: x.id, a })),
  );
  if (probes.length) {
    out.push('');
    out.push('### Participant-client probes (data channel)');
    out.push('');
    out.push('| Probe | Refused | Detail |');
    out.push('|---|---|---|');
    for (const { a } of probes)
      out.push(
        `| ${a.id.replace('live-client-probe-refused:', '')} | ${a.passed ? 'yes' : 'NO'} | ${cell(a.detail, 300)} |`,
      );
  }

  const layers = scenarios
    .map((x) => ({ id: x.id, a: x.assertions.find((a) => a.id === 'live-layer-attribution') }))
    .filter((x) => x.a);
  if (layers.length) {
    out.push('');
    out.push('### Which layer answered each beat (beat=layer/risk band)');
    out.push('');
    out.push(
      '`voice` = the voice model answered on its own; `delegated` = it handed the turn to the clinical backend.',
    );
    out.push('');
    out.push('| Scenario | Beats |');
    out.push('|---|---|');
    for (const x of layers) out.push(`| ${x.id} | ${cell(x.a!.detail, 400)} |`);
  }

  const notes = scenarios.flatMap((x) =>
    x.assertions
      .filter((a) => !a.passed && !a.gating && !a.id.startsWith('live-client-probe'))
      .map((a) => ({ scenario: x.id, a })),
  );
  if (notes.length) {
    out.push('');
    out.push('### Non-gating notes');
    out.push('');
    for (const { scenario, a } of notes) out.push(`- ${scenario} \`${a.id}\`: ${cell(a.detail, 300)}`);
  }
  if (s.totals?.voice) {
    out.push('');
    out.push(formatVoiceAggregate(s.totals.voice).trimEnd());
  }
  out.push('');
  out.push(
    'Transcripts (with the layer per turn and the backend text) are in the `redteam-voice-results` artifact, `summary.json`.',
  );
  return out.join('\n') + '\n';
}

async function main(): Promise<void> {
  const path = process.argv[2] ?? 'redteam-results/summary.json';
  let md: string;
  if (!fs.existsSync(path)) {
    md = `## Red-team voice-safety suite (GPT-Live)\n\n**FAIL**: no ${path} was written; the run did not finish. See the job log.\n`;
  } else {
    const { VOICE_SAFETY_SCENARIOS } = await import('./scenarios/voice.js');
    const modes = await import('./voice/scenarios.js');
    const knownGaps: KnownGaps = {};
    for (const sc of [
      ...VOICE_SAFETY_SCENARIOS,
      ...modes.VOICE_CRAWL_SCENARIOS,
      ...modes.VOICE_WALK_SCENARIOS,
      ...modes.VOICE_RUN_SCENARIOS,
    ])
      if (sc.knownGap) knownGaps[sc.id] = sc.knownGap;
    md = formatVoiceSummary(JSON.parse(fs.readFileSync(path, 'utf8')) as VoiceSummaryJson, knownGaps);
  }
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) fs.appendFileSync(target, md);
  else process.stdout.write(md);
}

// Only run as an entrypoint: formatVoiceSummary is imported by unit tests.
const invokedDirectly = process.argv[1]?.endsWith('voiceSummary.ts') || process.argv[1]?.endsWith('voiceSummary.js');
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[voiceSummary] failed:', err);
    process.exit(1);
  });
}
