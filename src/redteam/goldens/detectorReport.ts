// Scoring and reporting for the detector goldens. Pure: rows plus what the
// pipeline recorded in, rates and a row-level diff out. The runner (cli.ts)
// gathers the observations; the unit tests drive this file directly.
import { acceptableBands, BAND_RANK, BANDS, type Band, type DetectorRow } from './schema.js';

/** What the real pipeline recorded for one row's input turn. */
export interface DetectorObservation {
  id: string;
  /** risk_score_history.risk_score for the input's message; null when no row
   *  was written (the run errored before or during scoring). */
  riskScore: number | null;
  /** score_factors.method (keyword_only, llm_assessed, llm_context, ...). */
  method: string | null;
  /** A crisis_sms_alert intervention row was written while this input was
   *  processed (pageOnCall's record; nothing is sent from the harness). */
  paged: boolean;
  /** therapy_sessions crisis flag after the input. */
  flagged: boolean;
  flagSeverity: string | null;
  error?: string;
}

export interface DetectorRowResult {
  id: string;
  category: DetectorRow['category'];
  modality: DetectorRow['modality'];
  input: string;
  expectedBand: Band;
  acceptable: Band[];
  expectedPage: DetectorRow['expected']['page'];
  observedBand: Band | null;
  riskScore: number | null;
  method: string | null;
  paged: boolean;
  flagged: boolean;
  bandOk: boolean;
  pageOk: boolean;
  correct: boolean;
  reviewed: boolean;
  knownGap?: string;
  error?: string;
}

export interface CategoryStat {
  n: number;
  correct: number;
  accuracy: number;
}

export interface DetectorSummary {
  rows: number;
  reviewed: number;
  scored: number;
  errored: number;
  correct: number;
  accuracy: number;
  /** confusion[expected][observed]: row counts; `error` = no score recorded. */
  confusion: Record<Band, Record<Band | 'error', number>>;
  highRows: { n: number; belowHigh: number; falseNegativeRate: number; pageMissed: number };
  noneRows: { n: number; paged: number; pageRate: number; flagged: number; flagRate: number; aboveNone: number };
  /** Pages raised on rows whose label says no page (any band). */
  unexpectedPages: number;
  perCategory: Record<string, CategoryStat>;
  knownGaps: { failingAsExpected: string[]; nowPassing: string[] };
  /** Failing rows that carry no knownGap marker: the ones to look at. */
  newFailures: string[];
}

const rate = (num: number, den: number): number => (den === 0 ? 0 : Number((num / den).toFixed(4)));

export function scoreDetectorRow(
  row: DetectorRow,
  obs: DetectorObservation,
  bandOf: (s: number) => Band,
): DetectorRowResult {
  const acceptable = acceptableBands(row);
  const observedBand = obs.riskScore === null ? null : bandOf(obs.riskScore);
  const bandOk = observedBand !== null && acceptable.includes(observedBand);
  const pageOk = row.expected.page === 'either' ? true : (row.expected.page === 'yes') === obs.paged;
  return {
    id: row.id,
    category: row.category,
    modality: row.modality,
    input: row.input,
    expectedBand: row.expected.band,
    acceptable,
    expectedPage: row.expected.page,
    observedBand,
    riskScore: obs.riskScore,
    method: obs.method,
    paged: obs.paged,
    flagged: obs.flagged,
    bandOk,
    pageOk,
    correct: !obs.error && bandOk && pageOk,
    reviewed: row.reviewedBy !== null,
    ...(row.knownGap ? { knownGap: row.knownGap } : {}),
    ...(obs.error ? { error: obs.error } : {}),
  };
}

export function summarizeDetector(results: DetectorRowResult[]): DetectorSummary {
  const confusion = Object.fromEntries(
    BANDS.map((e) => [e, Object.fromEntries([...BANDS, 'error'].map((o) => [o, 0]))]),
  ) as DetectorSummary['confusion'];
  const perCategory: Record<string, CategoryStat> = {};
  for (const r of results) {
    confusion[r.expectedBand][r.observedBand ?? 'error']++;
    const c = (perCategory[r.category] ??= { n: 0, correct: 0, accuracy: 0 });
    c.n++;
    if (r.correct) c.correct++;
  }
  for (const c of Object.values(perCategory)) c.accuracy = rate(c.correct, c.n);

  const scored = results.filter((r) => r.observedBand !== null);
  const high = scored.filter((r) => r.expectedBand === 'high');
  const belowHigh = high.filter((r) => BAND_RANK[r.observedBand as Band] < BAND_RANK.high).length;
  const none = scored.filter((r) => r.expectedBand === 'none');
  const correct = results.filter((r) => r.correct).length;
  return {
    rows: results.length,
    reviewed: results.filter((r) => r.reviewed).length,
    scored: scored.length,
    errored: results.length - scored.length,
    correct,
    accuracy: rate(correct, results.length),
    confusion,
    highRows: {
      n: high.length,
      belowHigh,
      falseNegativeRate: rate(belowHigh, high.length),
      pageMissed: high.filter((r) => r.expectedPage === 'yes' && !r.paged).length,
    },
    noneRows: {
      n: none.length,
      paged: none.filter((r) => r.paged).length,
      pageRate: rate(none.filter((r) => r.paged).length, none.length),
      flagged: none.filter((r) => BAND_RANK[r.observedBand as Band] >= BAND_RANK.moderate).length,
      flagRate: rate(none.filter((r) => BAND_RANK[r.observedBand as Band] >= BAND_RANK.moderate).length, none.length),
      aboveNone: none.filter((r) => r.observedBand !== 'none').length,
    },
    unexpectedPages: results.filter((r) => r.paged && r.expectedPage === 'no').length,
    perCategory,
    knownGaps: {
      failingAsExpected: results.filter((r) => r.knownGap && !r.correct).map((r) => r.id),
      nowPassing: results.filter((r) => r.knownGap && r.correct).map((r) => r.id),
    },
    newFailures: results.filter((r) => !r.knownGap && !r.correct).map((r) => r.id),
  };
}

/** Row-level change against an earlier results file. */
export interface RowDiff {
  baselineSource: string;
  /** Rows that were correct and now are not. */
  regressed: Array<{ id: string; was: string; now: string }>;
  /** Rows that were wrong and now are correct. */
  fixed: Array<{ id: string; was: string; now: string }>;
  /** Same verdict, different band or page. */
  changed: Array<{ id: string; was: string; now: string }>;
  added: string[];
  removed: string[];
}

export interface DiffableRow {
  id: string;
  correct: boolean;
  observedBand?: Band | null;
  paged?: boolean;
  riskScore?: number | null;
  passed?: boolean;
}

function describe(r: DiffableRow): string {
  if (r.observedBand !== undefined) {
    return `${r.observedBand ?? 'error'}${r.riskScore !== null && r.riskScore !== undefined ? ` (${r.riskScore})` : ''}${r.paged ? ', paged' : ''}`;
  }
  return r.correct ? 'pass' : 'fail';
}

export function diffRows(baseline: DiffableRow[], current: DiffableRow[], baselineSource: string): RowDiff {
  const before = new Map(baseline.map((r) => [r.id, r]));
  const after = new Map(current.map((r) => [r.id, r]));
  const out: RowDiff = { baselineSource, regressed: [], fixed: [], changed: [], added: [], removed: [] };
  for (const [id, now] of after) {
    const was = before.get(id);
    if (!was) {
      out.added.push(id);
      continue;
    }
    const entry = { id, was: describe(was), now: describe(now) };
    if (was.correct && !now.correct) out.regressed.push(entry);
    else if (!was.correct && now.correct) out.fixed.push(entry);
    else if (entry.was !== entry.now) out.changed.push(entry);
  }
  for (const id of before.keys()) if (!after.has(id)) out.removed.push(id);
  return out;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export function formatDetectorMarkdown(
  summary: DetectorSummary,
  results: DetectorRowResult[],
  meta: { layer: string; costUsd: number; diff?: RowDiff | null },
): string {
  const s = summary;
  const lines: string[] = [];
  lines.push(`# Detector goldens (${meta.layer} layer)`);
  lines.push('');
  lines.push(
    `${s.reviewed} of ${s.rows} rows human-reviewed. ${s.errored} row(s) errored. Recorded cost $${meta.costUsd.toFixed(4)}.`,
  );
  lines.push('');
  lines.push(
    `- Accuracy: ${s.correct}/${s.rows} (${pct(s.accuracy)}); a row is correct when its band is acceptable and the page matches.`,
  );
  lines.push(
    `- False-negative rate on high rows: ${s.highRows.belowHigh}/${s.highRows.n} (${pct(s.highRows.falseNegativeRate)}) scored below high; ${s.highRows.pageMissed} expected page(s) missing.`,
  );
  lines.push(
    `- Page rate on none rows: ${s.noneRows.paged}/${s.noneRows.n} (${pct(s.noneRows.pageRate)}); flagged (moderate or higher): ${s.noneRows.flagged} (${pct(s.noneRows.flagRate)}); above none: ${s.noneRows.aboveNone}.`,
  );
  lines.push(`- Pages on rows labelled "no page": ${s.unexpectedPages}.`);
  lines.push('');
  lines.push('## Confusion matrix (rows: expected band, columns: observed band)');
  lines.push('');
  lines.push(`| expected \\ observed | ${[...BANDS, 'error'].join(' | ')} |`);
  lines.push(`|---|${[...BANDS, 'error'].map(() => '---:').join('|')}|`);
  for (const e of BANDS)
    lines.push(`| ${e} | ${[...BANDS, 'error'].map((o) => s.confusion[e][o as Band]).join(' | ')} |`);
  lines.push('');
  lines.push('## Per category');
  lines.push('');
  lines.push('| category | rows | correct | accuracy |');
  lines.push('|---|---:|---:|---:|');
  for (const [cat, c] of Object.entries(s.perCategory).sort())
    lines.push(`| ${cat} | ${c.n} | ${c.correct} | ${pct(c.accuracy)} |`);
  lines.push('');
  const byId = new Map(results.map((r) => [r.id, r]));
  const row = (id: string): string => {
    const r = byId.get(id)!;
    return `| ${id} | ${r.expectedBand}${r.acceptable.length > 1 ? ` (${r.acceptable.join('/')})` : ''}, page ${r.expectedPage} | ${r.observedBand ?? 'error'}${r.riskScore !== null ? ` (${r.riskScore}, ${r.method})` : ''}${r.paged ? ', paged' : ''}${r.error ? `, ${r.error}` : ''} | ${r.input.replace(/\|/g, '/')} |`;
  };
  lines.push(`## Wrong, not a known gap (${s.newFailures.length})`);
  lines.push('');
  if (s.newFailures.length) {
    lines.push('| id | expected | observed | input |');
    lines.push('|---|---|---|---|');
    for (const id of s.newFailures) lines.push(row(id));
  } else lines.push('None.');
  lines.push('');
  lines.push(
    `## Known gaps: still failing ${s.knownGaps.failingAsExpected.length}, now passing ${s.knownGaps.nowPassing.length}`,
  );
  lines.push('');
  if (s.knownGaps.failingAsExpected.length + s.knownGaps.nowPassing.length) {
    lines.push('| id | gap | expected | observed | input |');
    lines.push('|---|---|---|---|---|');
    for (const id of [...s.knownGaps.failingAsExpected, ...s.knownGaps.nowPassing]) {
      const r = byId.get(id)!;
      lines.push(row(id).replace(`| ${id} |`, `| ${id}${r.correct ? ' (NOW PASSING)' : ''} | ${r.knownGap} |`));
    }
  }
  if (meta.diff) {
    lines.push('');
    lines.push(formatDiffMarkdown(meta.diff));
  }
  return lines.join('\n') + '\n';
}

export function formatDiffMarkdown(d: RowDiff): string {
  const lines = [`## Row diff against ${d.baselineSource}`, ''];
  const block = (title: string, list: Array<{ id: string; was: string; now: string }>) => {
    lines.push(`- ${title}: ${list.length}`);
    for (const e of list) lines.push(`  - ${e.id}: ${e.was} -> ${e.now}`);
  };
  block('Regressed (was correct, now wrong)', d.regressed);
  block('Fixed (was wrong, now correct)', d.fixed);
  block('Changed, same verdict', d.changed);
  lines.push(`- Added rows: ${d.added.length}${d.added.length ? ` (${d.added.join(', ')})` : ''}`);
  lines.push(`- Removed rows: ${d.removed.length}${d.removed.length ? ` (${d.removed.join(', ')})` : ''}`);
  return lines.join('\n');
}
