// Scoring and reporting for the shadow risk scorer's offline evaluation
// (shadowEval.ts). Pure: golden rows, the shadow answers and the production
// detector's committed baseline in; confusion tables and a row-level
// disagreement list out. The unit test drives this file directly.
import { acceptableBands, BAND_RANK, BANDS, type Band, type DetectorRow } from './schema.js';
import type { ShadowPredicate } from '../../server/services/shadowRiskQuestions.js';

/** One golden row's shadow answer (or the reason there is none). */
export interface ShadowEvalAnswer {
  id: string;
  /** The shadow severity in the goldens' vocabulary (`medium` is `moderate`);
   *  null when the call failed or a question was refused. */
  band: Band | null;
  severityProbabilities: Record<Band, number> | null;
  predicates: Partial<Record<ShadowPredicate, number>> | null;
  latencyMs: number | null;
  tokensIn: number | null;
  error?: string;
  /** Questions the model refused (the row then counts as "no answer"). */
  refused?: string[];
  /** The severity that did come back on a row with a refused predicate. */
  partialBand?: Band | null;
}

/** What the production detector did on the same row (the committed baseline). */
export interface ProductionBaselineRow {
  id: string;
  observedBand: Band | null;
  paged: boolean;
}

export type Confusion = Record<Band, Record<Band | 'error', number>>;

export interface ShadowEvalRow {
  id: string;
  category: DetectorRow['category'];
  input: string;
  expectedBand: Band;
  acceptable: Band[];
  expectedPage: DetectorRow['expected']['page'];
  shadowBand: Band | null;
  /** P(high) from the severity question; null when errored. */
  shadowPHigh: number | null;
  shadowOk: boolean;
  productionBand: Band | null;
  productionPaged: boolean | null;
  productionOk: boolean | null;
  knownGap?: string;
}

export interface SideStats {
  scored: number;
  errored: number;
  /** Band within the row's acceptable range. */
  bandOk: number;
  bandAccuracy: number;
  /** Rows whose label says "page: yes": how many reached high. */
  mustPage: { n: number; high: number; missed: string[] };
  /** Rows labelled none or low with "page: no": how many were called high. */
  mustNotPage: { n: number; high: number; ids: string[] };
  /** Rows labelled none: how many were called moderate or high (a flag). */
  noneRows: { n: number; flagged: number };
}

export interface ShadowEvalSummary {
  rows: number;
  shadow: SideStats;
  production: SideStats | null;
  /** [expected][shadow] */
  shadowVsExpected: Confusion;
  /** [expected][production] */
  productionVsExpected: Confusion | null;
  /** [production][shadow], rows both sides scored. */
  shadowVsProduction: Confusion | null;
  agreement: { n: number; same: number; rate: number; shadowHigher: number; shadowLower: number } | null;
  perCategory: Record<string, { n: number; shadowOk: number; productionOk: number | null }>;
  /** Mean probability of each predicate per golden category. */
  predicateMeans: Record<string, Partial<Record<ShadowPredicate, number>>>;
  /** Rows where exactly one side is within the acceptable range. */
  shadowRightProductionWrong: string[];
  productionRightShadowWrong: string[];
  bothWrong: string[];
}

const rate = (num: number, den: number): number => (den === 0 ? 0 : Number((num / den).toFixed(4)));

const emptyConfusion = (): Confusion =>
  Object.fromEntries(BANDS.map((b) => [b, { none: 0, low: 0, moderate: 0, high: 0, error: 0 }])) as Confusion;

export function scoreShadowRows(
  rows: DetectorRow[],
  answers: Map<string, ShadowEvalAnswer>,
  production: Map<string, ProductionBaselineRow> | null,
): ShadowEvalRow[] {
  return rows.map((row) => {
    const acceptable = acceptableBands(row);
    const a = answers.get(row.id);
    const p = production?.get(row.id) ?? null;
    const shadowBand = a?.band ?? null;
    const productionBand = p?.observedBand ?? null;
    return {
      id: row.id,
      category: row.category,
      input: row.input,
      expectedBand: row.expected.band,
      acceptable,
      expectedPage: row.expected.page,
      shadowBand,
      shadowPHigh: a?.severityProbabilities?.high ?? null,
      shadowOk: shadowBand !== null && acceptable.includes(shadowBand),
      productionBand,
      productionPaged: p ? p.paged : null,
      productionOk: p ? productionBand !== null && acceptable.includes(productionBand) : null,
      ...(row.knownGap ? { knownGap: row.knownGap } : {}),
    };
  });
}

function sideStats(rows: ShadowEvalRow[], bandOf: (r: ShadowEvalRow) => Band | null): SideStats {
  const scored = rows.filter((r) => bandOf(r) !== null);
  const ok = scored.filter((r) => r.acceptable.includes(bandOf(r) as Band));
  const mustPage = rows.filter((r) => r.expectedPage === 'yes');
  const mustNotPage = rows.filter(
    (r) => r.expectedPage === 'no' && (r.expectedBand === 'none' || r.expectedBand === 'low'),
  );
  const none = rows.filter((r) => r.expectedBand === 'none');
  const isHigh = (r: ShadowEvalRow): boolean => bandOf(r) === 'high';
  return {
    scored: scored.length,
    errored: rows.length - scored.length,
    bandOk: ok.length,
    bandAccuracy: rate(ok.length, rows.length),
    mustPage: {
      n: mustPage.length,
      high: mustPage.filter(isHigh).length,
      missed: mustPage.filter((r) => !isHigh(r)).map((r) => r.id),
    },
    mustNotPage: {
      n: mustNotPage.length,
      high: mustNotPage.filter(isHigh).length,
      ids: mustNotPage.filter(isHigh).map((r) => r.id),
    },
    noneRows: {
      n: none.length,
      flagged: none.filter((r) => {
        const b = bandOf(r);
        return b !== null && BAND_RANK[b] >= BAND_RANK.moderate;
      }).length,
    },
  };
}

export function summarizeShadowEval(
  rows: ShadowEvalRow[],
  answers: Map<string, ShadowEvalAnswer>,
  hasProduction: boolean,
): ShadowEvalSummary {
  const shadowVsExpected = emptyConfusion();
  const productionVsExpected = hasProduction ? emptyConfusion() : null;
  const shadowVsProduction = hasProduction ? emptyConfusion() : null;
  const perCategory: ShadowEvalSummary['perCategory'] = {};
  const predicateSums: Record<string, { n: number; sums: Partial<Record<ShadowPredicate, number>> }> = {};
  let both = 0;
  let same = 0;
  let shadowHigher = 0;
  let shadowLower = 0;

  for (const r of rows) {
    shadowVsExpected[r.expectedBand][r.shadowBand ?? 'error']++;
    if (productionVsExpected) productionVsExpected[r.expectedBand][r.productionBand ?? 'error']++;
    if (shadowVsProduction && r.productionBand !== null) {
      shadowVsProduction[r.productionBand][r.shadowBand ?? 'error']++;
      if (r.shadowBand !== null) {
        both++;
        const d = BAND_RANK[r.shadowBand] - BAND_RANK[r.productionBand];
        if (d === 0) same++;
        else if (d > 0) shadowHigher++;
        else shadowLower++;
      }
    }
    const cat = (perCategory[r.category] ??= { n: 0, shadowOk: 0, productionOk: hasProduction ? 0 : null });
    cat.n++;
    if (r.shadowOk) cat.shadowOk++;
    if (cat.productionOk !== null && r.productionOk) cat.productionOk++;
    const predicates = answers.get(r.id)?.predicates;
    if (predicates) {
      const acc = (predicateSums[r.category] ??= { n: 0, sums: {} });
      acc.n++;
      for (const [name, p] of Object.entries(predicates) as Array<[ShadowPredicate, number]>) {
        acc.sums[name] = (acc.sums[name] ?? 0) + p;
      }
    }
  }

  const predicateMeans: ShadowEvalSummary['predicateMeans'] = {};
  for (const [cat, acc] of Object.entries(predicateSums)) {
    predicateMeans[cat] = Object.fromEntries(
      (Object.entries(acc.sums) as Array<[ShadowPredicate, number]>).map(([k, v]) => [
        k,
        Number((v / acc.n).toFixed(3)),
      ]),
    );
  }

  return {
    rows: rows.length,
    shadow: sideStats(rows, (r) => r.shadowBand),
    production: hasProduction ? sideStats(rows, (r) => r.productionBand) : null,
    shadowVsExpected,
    productionVsExpected,
    shadowVsProduction,
    agreement: hasProduction ? { n: both, same, rate: rate(same, both), shadowHigher, shadowLower } : null,
    perCategory,
    predicateMeans,
    shadowRightProductionWrong: rows.filter((r) => r.shadowOk && r.productionOk === false).map((r) => r.id),
    productionRightShadowWrong: rows.filter((r) => !r.shadowOk && r.productionOk === true).map((r) => r.id),
    bothWrong: rows.filter((r) => !r.shadowOk && r.productionOk === false).map((r) => r.id),
  };
}

function confusionTable(title: string, rowLabel: string, colLabel: string, c: Confusion): string[] {
  return [
    `### ${title}`,
    '',
    `| ${rowLabel} \\ ${colLabel} | none | low | moderate | high | error |`,
    '|---|---:|---:|---:|---:|---:|',
    ...BANDS.map((b) => `| ${b} | ${c[b].none} | ${c[b].low} | ${c[b].moderate} | ${c[b].high} | ${c[b].error} |`),
    '',
  ];
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 110);

function sideLines(name: string, s: SideStats, rows: number): string[] {
  return [
    `- ${name}: band within the acceptable range on ${s.bandOk}/${rows} (${pct(s.bandAccuracy)}); ` +
      `${s.errored} row(s) without an answer.`,
    `  - rows labelled "page: yes" called high: ${s.mustPage.high}/${s.mustPage.n}` +
      (s.mustPage.missed.length ? ` (missed: ${s.mustPage.missed.join(', ')})` : ''),
    `  - rows labelled none or low with "page: no" called high: ${s.mustNotPage.high}/${s.mustNotPage.n}` +
      (s.mustNotPage.ids.length ? ` (${s.mustNotPage.ids.join(', ')})` : ''),
    `  - rows labelled none called moderate or high: ${s.noneRows.flagged}/${s.noneRows.n}`,
  ];
}

export function formatShadowEvalMarkdown(
  summary: ShadowEvalSummary,
  rows: ShadowEvalRow[],
  header: string[] = [],
): string {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: string[] = ['# Shadow risk scorer on the detector goldens', '', ...header, ''];
  out.push('## Headline', '');
  out.push(...sideLines('Shadow scorer', summary.shadow, summary.rows));
  if (summary.production) out.push(...sideLines('Production detector (baseline)', summary.production, summary.rows));
  if (summary.agreement) {
    const a = summary.agreement;
    out.push(
      `- Same band on ${a.same}/${a.n} rows both sides scored (${pct(a.rate)}); ` +
        `shadow higher on ${a.shadowHigher}, lower on ${a.shadowLower}.`,
    );
  }
  out.push('', '## Confusion tables (row counts)', '');
  out.push(...confusionTable('Shadow severity vs expected band', 'expected', 'shadow', summary.shadowVsExpected));
  if (summary.productionVsExpected) {
    out.push(
      ...confusionTable(
        'Production detector vs expected band (committed baseline)',
        'expected',
        'production',
        summary.productionVsExpected,
      ),
    );
  }
  if (summary.shadowVsProduction) {
    out.push(
      ...confusionTable('Shadow severity vs production detector', 'production', 'shadow', summary.shadowVsProduction),
    );
  }

  out.push('## Per category (band within the acceptable range)', '');
  out.push('| category | rows | shadow | production |', '|---|---:|---:|---:|');
  for (const cat of Object.keys(summary.perCategory).sort()) {
    const c = summary.perCategory[cat];
    out.push(`| ${cat} | ${c.n} | ${c.shadowOk} | ${c.productionOk ?? 'n/a'} |`);
  }

  const predicateNames = [...new Set(Object.values(summary.predicateMeans).flatMap((m) => Object.keys(m)))];
  if (predicateNames.length > 0) {
    out.push('', '## Mean predicate probability per category', '');
    out.push(`| category | ${predicateNames.join(' | ')} |`, `|---|${predicateNames.map(() => '---:').join('|')}|`);
    for (const cat of Object.keys(summary.predicateMeans).sort()) {
      const m = summary.predicateMeans[cat] as Record<string, number | undefined>;
      out.push(`| ${cat} | ${predicateNames.map((n) => (m[n] ?? 0).toFixed(2)).join(' | ')} |`);
    }
  }

  const list = (title: string, ids: string[]): void => {
    out.push('', `## ${title} (${ids.length})`, '');
    if (ids.length === 0) {
      out.push('None.');
      return;
    }
    out.push('| id | expected | shadow | P(high) | production | input |', '|---|---|---|---:|---|---|');
    for (const id of ids) {
      const r = byId.get(id);
      if (!r) continue;
      const expected = r.acceptable.length > 1 ? `${r.expectedBand} (${r.acceptable.join('/')})` : r.expectedBand;
      out.push(
        `| ${r.id}${r.knownGap ? ` [${r.knownGap}]` : ''} | ${expected}, page ${r.expectedPage} | ` +
          `${r.shadowBand ?? 'error'} | ${r.shadowPHigh === null ? 'n/a' : r.shadowPHigh.toFixed(2)} | ` +
          `${r.productionBand ?? 'n/a'}${r.productionPaged ? ', paged' : ''} | ${cell(r.input)} |`,
      );
    }
  };
  list('Production right, shadow wrong', summary.productionRightShadowWrong);
  list('Shadow right, production wrong', summary.shadowRightProductionWrong);
  list('Both wrong', summary.bothWrong);
  return out.join('\n') + '\n';
}
