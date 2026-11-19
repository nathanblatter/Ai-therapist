// File new red-team eval failures into Flightdeck (docs/redteam.md "Eval
// failures in Flightdeck").
//
//   node src/redteam/flightdeckReport.ts --run-url <url> [--run-id <id>] [--sha <sha>]
//        [--previous <file|dir>]... [--state <file>] [--dry-run] <summary.json>...
//
// Env: FLIGHTDECK_URL (default http://100.79.61.79:4300), FLIGHTDECK_INGEST_KEY.
//
// Write-only by design: the key is an `ingest`-scope key, which can create an
// item through POST /api/ingest/capture and can read nothing. So this never
// looks anything up in Flightdeck. De-duplication comes from the harness's own
// history instead: a bug is filed only on a TRANSITION, when a scenario
// gating-failed (or errored) tonight and its previous recorded result (the
// previous run's rolling-baseline.json, or its summary.json) was a pass or does
// not exist. A scenario that failed last time and fails again files nothing.
//
// Recoveries (previous fail, now pass) and known-gap assertions that passed are
// listed in the job summary for a person to act on; nothing is written for them.
//
// Guards: more than MAX_NEW_BUGS new bugs in one run, or a run that looks like
// an infrastructure failure, files ONE "[eval] suite-wide failure" item.
//
// Idempotent on a re-run of the same workflow run: --state names a small JSON
// file (kept as a workflow artifact) recording what this run id already filed;
// it is rewritten after every successful POST.
//
// Imports nothing but node builtins on purpose: the workflow runs it with plain
// `node` (type stripping) on the self-hosted runner, without `npm ci`, so it
// stays out of the way of the stage deploy on that machine.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_URL = 'http://100.79.61.79:4300';
export const CAPTURE_PATH = '/api/ingest/capture';
export const PROJECT = 'ai-therapist';
export const TAG = 'eval-failure';
export const SUITE_WIDE_TITLE = '[eval] suite-wide failure';
export const MAX_NEW_BUGS = 8;
/** Flightdeck's capture endpoint truncates titles to 80 runes and rejects a
 *  body over 5000 bytes (internal/api/ingest.go). */
const TITLE_MAX = 80;
const BODY_MAX_BYTES = 4900;
const EXCERPT_TURNS_BEFORE = 2;
const EXCERPT_TURNS_AFTER = 3;
const EXCERPT_TURN_CHARS = 240;
const EXCERPT_TOTAL_CHARS = 1500;
const DETAIL_CHARS = 400;
const HTTP_TIMEOUT_MS = 15_000;
/** The ingest routes are rate limited per IP (1/s, burst 10). */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_WAIT_MS = 1500;

/** Errors that mean the harness never got a fair run (quota, credit, network,
 *  database), not that the product misbehaved. Matched on a scenario `error`. */
const INFRA_ERROR =
  /insufficient_quota|exceeded your current quota|quota|billing|credit balance|credits?\b.*(exhausted|depleted)|rate limit|\b429\b|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|database .* does not exist|relation .* does not exist|password authentication failed|connect.*5432/i;

// ---------------------------------------------------------------------------
// Inputs (read defensively: older summaries, and fields other changes add later)

interface SummaryAssertion {
  id: string;
  passed: boolean;
  gating?: boolean;
  detail?: string;
  knownGap?: string;
}
interface SummaryTurn {
  role?: string;
  text?: string;
  beatId?: string;
}
interface SummaryScenario {
  id: string;
  passed: boolean;
  error?: string | null;
  assertions?: SummaryAssertion[];
  transcript?: SummaryTurn[];
  generated?: { gating?: boolean } | null;
  catalogueIds?: unknown;
  knownGap?: { ref?: string; assertionIds?: string[] } | null;
}
interface SummaryFile {
  suite?: string;
  variant?: { name?: string } | null;
  gitSha?: string | null;
  startedAt?: string;
  scenarios?: SummaryScenario[];
}
/** rollingBaseline.ts RollingBaseline, the subset read here. */
interface RollingFile {
  version?: number;
  suite?: string;
  variant?: string;
  scenarios?: Record<string, { passed?: boolean; error?: string | null; ranAt?: string }>;
}

export function baseId(label: string): string {
  return label.replace(/#v\d+$/, '');
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** suite|variant -> base scenario id -> was its most recent prior result a pass. */
export type PreviousResults = Map<string, Map<string, { passed: boolean; ranAt: string }>>;

const runKey = (suite: string, variant: string) => `${suite}|${variant}`;

/**
 * Load previous results from rolling-baseline.json files (preferred: each
 * scenario's most recent result, whatever night it ran) or plain summary.json
 * files. A directory means its rolling-baseline.json, else its summary.json.
 * Unreadable inputs are skipped: no previous result then means "first fail".
 */
export function loadPrevious(inputs: string[]): PreviousResults {
  const out: PreviousResults = new Map();
  const put = (suite: string, variant: string, label: string, passed: boolean, ranAt: string) => {
    const k = runKey(suite, variant);
    const m = out.get(k) ?? new Map();
    out.set(k, m);
    const id = baseId(label);
    const cur = m.get(id);
    // Newest result wins; within one night, every variation must have passed.
    if (!cur || ranAt > cur.ranAt) m.set(id, { passed, ranAt });
    else if (ranAt === cur.ranAt) m.set(id, { passed: cur.passed && passed, ranAt });
  };
  for (const input of inputs) {
    let file = input;
    try {
      if (fs.statSync(input).isDirectory()) {
        const rolling = path.join(input, 'rolling-baseline.json');
        file = fs.existsSync(rolling) ? rolling : path.join(input, 'summary.json');
      }
      const data = readJson(file) as RollingFile & SummaryFile;
      if (data && data.version === 1 && data.scenarios && !Array.isArray(data.scenarios)) {
        const r = data as RollingFile;
        for (const [label, e] of Object.entries(r.scenarios ?? {})) {
          put(r.suite ?? 'unknown', r.variant ?? 'default', label, e.passed === true && !e.error, e.ranAt ?? '');
        }
      } else {
        const s = data as SummaryFile;
        for (const sc of Array.isArray(s.scenarios) ? s.scenarios : []) {
          if (!sc || typeof sc.id !== 'string' || (sc.generated && sc.generated.gating !== true)) continue;
          put(
            s.suite ?? 'unknown',
            s.variant?.name ?? 'default',
            sc.id,
            sc.passed === true && !sc.error,
            s.startedAt ?? '',
          );
        }
      }
    } catch {
      /* no usable previous result in this input */
    }
  }
  return out;
}

/** A short excerpt of the synthetic transcript around the failing turn: the
 *  turn whose beat id a failing assertion names, else the end of the
 *  conversation. Capped per turn and in total. */
export function transcriptExcerpt(transcript: SummaryTurn[] | undefined, failed: SummaryAssertion[]): string {
  const turns = (transcript ?? []).filter((t) => typeof t?.text === 'string');
  if (turns.length === 0) return '';
  let center = turns.length - 1;
  const beatIds = [...new Set(turns.map((t) => t.beatId).filter((b): b is string => !!b))];
  outer: for (const a of failed) {
    const hay = `${a.id} ${a.detail ?? ''}`;
    for (const beat of beatIds) {
      if (!hay.includes(beat)) continue;
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i].beatId === beat) {
          center = i;
          break outer;
        }
      }
    }
  }
  const from = Math.max(0, center - EXCERPT_TURNS_BEFORE);
  const to = Math.min(turns.length, center + EXCERPT_TURNS_AFTER + 1);
  const lines: string[] = [];
  if (from > 0) lines.push(`[... ${from} earlier turn(s)]`);
  for (const t of turns.slice(from, to)) {
    lines.push(`${t.role === 'assistant' ? 'assistant' : 'persona'}: ${clip(t.text ?? '', EXCERPT_TURN_CHARS)}`);
  }
  if (to < turns.length) lines.push(`[... ${turns.length - to} later turn(s)]`);
  const out = lines.join('\n');
  return out.length > EXCERPT_TOTAL_CHARS ? `${out.slice(0, EXCERPT_TOTAL_CHARS - 3)}...` : out;
}

// ---------------------------------------------------------------------------
// Analysis

export interface FailureInstance {
  instanceId: string;
  suite: string;
  variant: string;
  failedAssertions: Array<{ id: string; detail: string }>;
  error?: string;
  excerpt: string;
}

export interface ScenarioReport {
  scenarioId: string;
  catalogueIds: string[];
  /** Instances that failed tonight after a pass, or with no previous result. */
  failures: FailureInstance[];
}

export interface RunAnalysis {
  /** Transitions: these would get a new bug. */
  newFailures: ScenarioReport[];
  /** Failed tonight and on their previous run too: nothing is filed. */
  stillFailing: string[];
  /** Previous result a fail, tonight a pass. */
  recovered: string[];
  /** Known gaps whose listed assertions (or whole label-only scenario) passed
   *  in every instance tonight: `ref: scenario / assertion`. */
  gapPasses: string[];
  /** Non-empty when the run looks like an infrastructure failure. */
  infraReasons: string[];
  /** Every failure tonight, for the suite-wide item when infraReasons is set. */
  allFailing: string[];
  sha: string | null;
  startedAt: string | null;
}

export interface LoadedSummary {
  path: string;
  summary: SummaryFile | null;
  problem?: string;
}

export function loadSummaries(paths: string[]): LoadedSummary[] {
  return paths.map((p) => {
    try {
      const parsed = readJson(p) as SummaryFile;
      if (!parsed || typeof parsed !== 'object') return { path: p, summary: null, problem: 'not a JSON object' };
      return { path: p, summary: parsed };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return { path: p, summary: null, problem: e.code === 'ENOENT' ? 'missing' : `unreadable (${e.message})` };
    }
  });
}

function shortFailure(f: FailureInstance[]): string {
  const ids = [...new Set(f.flatMap((x) => x.failedAssertions.map((a) => a.id)))];
  if (ids.length) return ids.length > 1 ? `${ids[0]} (+${ids.length - 1} more)` : ids[0];
  if (f.some((x) => x.error)) return 'scenario errored';
  return 'scenario failed (judge floor)';
}

export function analyze(loaded: LoadedSummary[], previous: PreviousResults): RunAnalysis {
  const infraReasons: string[] = [];
  const reports = new Map<string, ScenarioReport>();
  const stillFailing = new Set<string>();
  const failingTonight = new Set<string>();
  const passedInstances = new Map<string, boolean>(); // run|id -> all passed
  const gapTally = new Map<string, boolean>(); // "ref: scenario / assertion" -> failed somewhere
  const allFailing: string[] = [];
  let sha: string | null = null;
  let startedAt: string | null = null;
  let counted = 0;
  let errored = 0;

  for (const l of loaded) {
    if (!l.summary) {
      infraReasons.push(`no summary.json at ${l.path} (${l.problem}): the harness did not finish`);
      continue;
    }
    const s = l.summary;
    sha ??= s.gitSha ?? null;
    startedAt ??= s.startedAt ?? null;
    const suite = s.suite ?? 'unknown';
    const variant = s.variant?.name ?? 'default';
    const prev = previous.get(runKey(suite, variant));
    const scenarios = Array.isArray(s.scenarios) ? s.scenarios : [];
    if (scenarios.length === 0) infraReasons.push(`${l.path}: suite ${suite} ran no scenarios`);

    // Per base id within this run: collect tonight's instances first, so the
    // transition is decided per scenario, not per variation.
    const byId = new Map<string, FailureInstance[]>();
    const ranIds = new Set<string>();
    for (const sc of scenarios) {
      if (!sc || typeof sc.id !== 'string') continue;
      // A non-gating generated variant never fails a run; it files nothing.
      if (sc.generated && sc.generated.gating !== true) continue;
      counted++;
      const id = baseId(sc.id);
      ranIds.add(id);
      const assertions = Array.isArray(sc.assertions) ? sc.assertions : [];
      for (const a of assertions) {
        if (typeof a?.knownGap !== 'string') continue;
        const key = `${a.knownGap}: ${id} / ${a.id}`;
        gapTally.set(key, (gapTally.get(key) ?? false) || !a.passed);
      }
      const labelOnlyGap =
        sc.knownGap && typeof sc.knownGap.ref === 'string' && !(sc.knownGap.assertionIds ?? []).length
          ? sc.knownGap.ref
          : null;
      if (labelOnlyGap) {
        const key = `${labelOnlyGap}: ${id} (whole scenario)`;
        gapTally.set(key, (gapTally.get(key) ?? false) || !sc.passed || !!sc.error);
      }
      if (sc.error) errored++;
      const ok = sc.passed === true && !sc.error;
      const pk = `${runKey(suite, variant)}|${id}`;
      passedInstances.set(pk, (passedInstances.get(pk) ?? true) && ok);
      if (ok) continue;
      const failed = assertions.filter((a) => !a.passed && a.gating !== false);
      const instance: FailureInstance = {
        instanceId: sc.id,
        suite,
        variant,
        failedAssertions: failed.map((a) => ({ id: a.id, detail: clip(a.detail ?? '', DETAIL_CHARS) })),
        ...(sc.error ? { error: clip(sc.error, DETAIL_CHARS) } : {}),
        excerpt: transcriptExcerpt(sc.transcript, failed),
      };
      allFailing.push(`\`${sc.id}\` (${suite}/${variant}): ${shortFailure([instance])}`);
      if (sc.error && INFRA_ERROR.test(sc.error)) infraReasons.push(`${sc.id}: ${clip(sc.error, 200)}`);
      // A label-only known gap is tracked by its ref already (an error is not
      // the gap, so it still counts).
      if (labelOnlyGap && !sc.error) continue;
      const list = byId.get(id) ?? [];
      list.push(instance);
      byId.set(id, list);
      const r = reports.get(id) ?? { scenarioId: id, catalogueIds: [], failures: [] };
      for (const c of stringArray(sc.catalogueIds)) if (!r.catalogueIds.includes(c)) r.catalogueIds.push(c);
      reports.set(id, r);
    }

    for (const id of ranIds) {
      const p = prev?.get(id);
      const failures = byId.get(id);
      if (failures) {
        failingTonight.add(id);
        if (p && !p.passed) stillFailing.add(id);
        else reports.get(id)!.failures.push(...failures);
      }
    }
  }
  if (counted > 0 && errored === counted) infraReasons.unshift(`every scenario errored (${errored}/${counted})`);

  const recovered = new Set<string>();
  for (const [pk, ok] of passedInstances) {
    if (!ok) continue;
    const [suite, variant, id] = pk.split('|');
    const p = previous.get(runKey(suite, variant))?.get(id);
    if (p && !p.passed && !failingTonight.has(id)) recovered.add(id);
  }

  const newFailures = [...reports.values()].filter((r) => r.failures.length > 0);
  for (const r of newFailures) stillFailing.delete(r.scenarioId);
  return {
    newFailures,
    stillFailing: [...stillFailing],
    recovered: [...recovered],
    gapPasses: [...gapTally.entries()].filter(([, failed]) => !failed).map(([k]) => k),
    infraReasons: [...new Set(infraReasons)],
    allFailing,
    sha,
    startedAt,
  };
}

// ---------------------------------------------------------------------------
// Item text

export interface RunContext {
  runId: string;
  runUrl: string;
  sha: string | null;
  date: string;
}

export function capBody(body: string): string {
  if (Buffer.byteLength(body, 'utf8') <= BODY_MAX_BYTES) return body;
  const note = '\n\n[truncated; the full result is in the run artifact]';
  let out = body.slice(0, BODY_MAX_BYTES);
  while (Buffer.byteLength(out + note, 'utf8') > BODY_MAX_BYTES) out = out.slice(0, -200);
  return out + note;
}

export function itemTitle(r: ScenarioReport): string {
  const full = `[eval] ${r.scenarioId}: ${shortFailure(r.failures)}`;
  const chars = [...full];
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 3).join('')}...` : full;
}

export function bugBody(r: ScenarioReport, ctx: RunContext): string {
  const out: string[] = [];
  out.push(
    `Auto-filed by the red-team eval sync (src/redteam/flightdeckReport.ts, docs/redteam.md) because this ` +
      `scenario failed after passing on its previous run, or on its first recorded run. It files nothing ` +
      `while the scenario keeps failing, and does not close this item when it recovers: the job summary lists recoveries.`,
  );
  out.push('');
  out.push(`- Scenario: \`${r.scenarioId}\``);
  if (r.catalogueIds.length) out.push(`- Catalogue IDs: ${r.catalogueIds.join(', ')}`);
  out.push(`- Suite: ${[...new Set(r.failures.map((f) => f.suite))].join(', ')}`);
  out.push(`- Variant: ${[...new Set(r.failures.map((f) => f.variant))].join(', ')}`);
  out.push(`- Run: ${ctx.runUrl}`);
  out.push(`- Commit: ${ctx.sha ?? 'unknown'}`);
  out.push(`- First seen: ${ctx.date}`);
  for (const f of r.failures) {
    out.push('');
    out.push(`Instance \`${f.instanceId}\` (suite ${f.suite}, variant ${f.variant}):`);
    if (f.error) out.push(`- error: ${f.error}`);
    for (const a of f.failedAssertions) out.push(`- \`${a.id}\`: ${a.detail}`);
    if (!f.error && f.failedAssertions.length === 0) {
      out.push('- failed without a failed gating assertion (a judge floor); see the artifact');
    }
    if (f.excerpt) {
      out.push('');
      out.push('Transcript excerpt (synthetic persona text):');
      out.push('```');
      out.push(f.excerpt.replace(/```/g, "'''"));
      out.push('```');
    }
  }
  out.push('');
  out.push('The full transcript is in the run artifact (summary.json).');
  return capBody(out.join('\n'));
}

export function suiteWideBody(a: RunAnalysis, ctx: RunContext, reason: 'infra' | 'blast'): string {
  const out: string[] = [];
  out.push(
    `Auto-filed by the red-team eval sync (src/redteam/flightdeckReport.ts). Run: ${ctx.runUrl} ` +
      `(commit ${ctx.sha ?? 'unknown'}, ${ctx.date}).`,
  );
  out.push('');
  if (reason === 'infra') {
    out.push('The run looks like an infrastructure failure, not a product one:');
    for (const r of a.infraReasons) out.push(`- ${r}`);
    if (a.allFailing.length) {
      out.push('', 'Scenarios that failed or errored in this run (no per-scenario bugs were filed):');
      for (const f of a.allFailing) out.push(`- ${f}`);
    }
  } else {
    out.push(
      `${a.newFailures.length} scenarios failed after a pass (or on their first run) in one run, over the limit of ` +
        `${MAX_NEW_BUGS} per-scenario bugs, so they are listed here instead:`,
    );
    for (const r of a.newFailures) out.push(`- \`${r.scenarioId}\`: ${shortFailure(r.failures)}`);
  }
  return capBody(out.join('\n'));
}

// ---------------------------------------------------------------------------
// Flightdeck: one write-only call

export interface CaptureInput {
  title: string;
  body: string;
}

export class FlightdeckUnreachable extends Error {}
export class FlightdeckHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Capturer {
  capture(input: CaptureInput): Promise<string>;
}

/** POST /api/ingest/capture, the only call this script makes. */
export class IngestClient implements Capturer {
  private url: string;
  private key: string;
  private wait: (ms: number) => Promise<void>;

  constructor(base: string, key: string, wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {
    this.url = `${base.replace(/\/+$/, '')}${CAPTURE_PATH}`;
    this.key = key;
    this.wait = wait;
  }

  async capture(input: CaptureInput): Promise<string> {
    // Exactly the fields captureReq accepts: the handler rejects unknown ones.
    // Status cannot be set here; captured items start in the backlog.
    const payload = JSON.stringify({
      project: PROJECT,
      type: 'bug',
      title: input.title,
      body: input.body,
      tags: [TAG],
    });
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.url, {
          method: 'POST',
          headers: { 'X-API-Key': this.key, 'Content-Type': 'application/json' },
          body: payload,
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
      } catch (err) {
        const cause = (err as { cause?: { code?: string } }).cause?.code;
        throw new FlightdeckUnreachable(cause ?? (err as Error).message);
      }
      const text = await res.text();
      if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        await this.wait(RATE_LIMIT_WAIT_MS * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new FlightdeckHttpError(res.status, `HTTP ${res.status} ${clip(text, 200)}`);
      try {
        return String((JSON.parse(text) as { ref?: string }).ref ?? '(created)');
      } catch {
        return '(created)';
      }
    }
  }
}

/** --dry-run: prints the intended POSTs; no network at all. */
export class DryRunCapturer implements Capturer {
  writes: CaptureInput[] = [];
  private log: (line: string) => void;
  constructor(log: (line: string) => void) {
    this.log = log;
  }
  async capture(input: CaptureInput): Promise<string> {
    this.writes.push(input);
    const ref = `(new-${this.writes.length})`;
    const body = input.body
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n');
    this.log(
      `[dry run] POST ${CAPTURE_PATH} {project: ${PROJECT}, type: bug, tags: [${TAG}]} -> ${ref}\n  title: ${input.title}\n${body}`,
    );
    return ref;
  }
}

// ---------------------------------------------------------------------------
// Sync

/** What this run id already filed (a workflow artifact), keyed by scenario id
 *  or `suite-wide`. */
export interface SyncState {
  runId: string;
  filed: Record<string, string>;
}

export function readState(file: string | undefined, runId: string): SyncState {
  if (file) {
    try {
      const s = readJson(file) as SyncState;
      if (s && s.runId === runId && s.filed && typeof s.filed === 'object') return { runId, filed: { ...s.filed } };
    } catch {
      /* first attempt of this run */
    }
  }
  return { runId, filed: {} };
}

export interface SyncOutcome {
  filed: string[];
  alreadyFiled: string[];
  suiteWide: boolean;
}

export async function sync(
  a: RunAnalysis,
  capturer: Capturer,
  ctx: RunContext,
  state: SyncState,
  saveState: (s: SyncState) => void,
): Promise<SyncOutcome> {
  const outcome: SyncOutcome = { filed: [], alreadyFiled: [], suiteWide: false };
  const file = async (key: string, label: string, input: CaptureInput) => {
    if (state.filed[key]) {
      outcome.alreadyFiled.push(`${state.filed[key]} (${label})`);
      return;
    }
    const ref = await capturer.capture(input);
    state.filed[key] = ref;
    saveState(state);
    outcome.filed.push(`${ref} (${label})`);
  };

  const reason = a.infraReasons.length ? 'infra' : a.newFailures.length > MAX_NEW_BUGS ? 'blast' : null;
  if (reason) {
    outcome.suiteWide = true;
    await file('suite-wide', reason === 'infra' ? 'suite-wide failure: infrastructure' : 'suite-wide failure', {
      title: SUITE_WIDE_TITLE,
      body: suiteWideBody(a, ctx, reason),
    });
    return outcome;
  }
  for (const r of a.newFailures) {
    await file(r.scenarioId, r.scenarioId, { title: itemTitle(r), body: bugBody(r, ctx) });
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// CLI

export function summaryMarkdown(a: RunAnalysis, o: SyncOutcome | null, ctx: RunContext, dryRun: boolean): string {
  const out: string[] = ['### Flightdeck eval sync', ''];
  const tag = dryRun ? ' (dry run: nothing was sent)' : '';
  if (o) {
    const filed = o.filed.length ? o.filed.join(', ') : 'nothing';
    out.push(`- Filed${tag}: ${filed}`);
    if (o.alreadyFiled.length)
      out.push(`- Already filed by an earlier attempt of run ${ctx.runId}: ${o.alreadyFiled.join(', ')}`);
  }
  if (a.stillFailing.length) {
    out.push(`- Still failing, already reported on an earlier run (not filed again): ${a.stillFailing.join(', ')}`);
  }
  if (a.recovered.length) {
    out.push(`- Recovered (failed last run, passed tonight; close their bugs if fixed): ${a.recovered.join(', ')}`);
  }
  if (a.gapPasses.length) {
    out.push(`- Known gaps that passed tonight (consider removing the knownGap marker): ${a.gapPasses.join('; ')}`);
  }
  return out.join('\n');
}

export interface Io {
  log: (line: string) => void;
  warn: (line: string) => void;
}

function appendSummary(env: Record<string, string | undefined>, text: string): void {
  const target = env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  try {
    fs.appendFileSync(target, `\n${text}\n`);
  } catch {
    /* best-effort */
  }
}

export interface MainOptions {
  /** Injected in tests to skip the rate-limit backoff. */
  wait?: (ms: number) => Promise<void>;
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  io: Io = { log: (l) => console.log(l), warn: (l) => console.warn(l) },
  opts: MainOptions = {},
): Promise<number> {
  let runUrl = '';
  let runId = '';
  let sha = '';
  let stateFile = '';
  let dryRun = false;
  const previous: string[] = [];
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--run-url') runUrl = argv[++i] ?? '';
    else if (arg === '--run-id') runId = argv[++i] ?? '';
    else if (arg === '--sha') sha = argv[++i] ?? '';
    else if (arg === '--previous') previous.push(argv[++i] ?? '');
    else if (arg === '--state') stateFile = argv[++i] ?? '';
    else if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--')) {
      io.warn(`[flightdeck] unknown option ${arg}`);
      return 2;
    } else paths.push(arg);
  }
  if (!runUrl && env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
    runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  }
  runId ||= /\/runs\/(\d+)/.exec(runUrl)?.[1] ?? env.GITHUB_RUN_ID ?? '';
  if (!runUrl || !runId || paths.length === 0) {
    io.warn(
      'usage: flightdeckReport.ts --run-url <url> [--run-id <id>] [--sha <sha>] [--previous <file|dir>]... ' +
        '[--state <file>] [--dry-run] <summary.json>...',
    );
    return 2;
  }

  const key = env.FLIGHTDECK_INGEST_KEY ?? '';
  if (!key && !dryRun) {
    const line =
      'Flightdeck eval sync skipped: FLIGHTDECK_INGEST_KEY is not set (add the repository secret to enable it).';
    io.log(line);
    appendSummary(env, line);
    return 0;
  }

  const analysis = analyze(loadSummaries(paths), loadPrevious(previous));
  const ctx: RunContext = {
    runId,
    runUrl,
    sha: sha || analysis.sha || env.GITHUB_SHA || null,
    date: (analysis.startedAt ?? new Date().toISOString()).slice(0, 10),
  };
  const base = env.FLIGHTDECK_URL || DEFAULT_URL;
  const capturer: Capturer = dryRun ? new DryRunCapturer(io.log) : new IngestClient(base, key, opts.wait);
  const state = readState(stateFile || undefined, runId);
  const save = (s: SyncState) => {
    if (!stateFile || dryRun) return;
    try {
      fs.mkdirSync(path.dirname(path.resolve(stateFile)), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
    } catch (err) {
      io.warn(`[flightdeck] could not write ${stateFile}: ${(err as Error).message}`);
    }
  };

  let outcome: SyncOutcome | null = null;
  let warning = '';
  const progress: SyncOutcome = { filed: [], alreadyFiled: [], suiteWide: false };
  try {
    outcome = await sync(analysis, capturer, ctx, state, save);
  } catch (err) {
    // Flightdeck being down or refusing must never turn an eval run red: the
    // eval result is the signal, this is bookkeeping.
    const what =
      err instanceof FlightdeckUnreachable
        ? `Flightdeck at ${base} is unreachable (${err.message})`
        : err instanceof FlightdeckHttpError
          ? `Flightdeck refused the capture (${err.message})`
          : `unexpected error (${(err as Error).message})`;
    warning =
      `WARNING: Flightdeck eval sync did not complete: ${what}. ` +
      'Rerun this job to retry; what was already filed for this run is not filed twice.';
    progress.filed = Object.entries(state.filed).map(([k, ref]) => `${ref} (${k})`);
  }
  const md = summaryMarkdown(analysis, outcome ?? progress, ctx, dryRun);
  io.log(md);
  if (warning) io.warn(warning);
  appendSummary(env, warning ? `${md}\n\n${warning}` : md);
  return 0;
}

const invokedDirectly =
  process.argv[1]?.endsWith('flightdeckReport.ts') || process.argv[1]?.endsWith('flightdeckReport.js');
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.warn(`WARNING: Flightdeck eval sync crashed: ${(err as Error).message}`);
      process.exit(0);
    },
  );
}
