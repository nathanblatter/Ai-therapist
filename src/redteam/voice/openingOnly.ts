// Opening-only starts: the silent-start measurement of ai-therapist-315.
//
// One ordinary GPT-Live start exactly as a participant's browser makes it
// (POST /api/live/session, wait for `session.started`, POST
// /api/sessions/:id/opening), then nothing: the harness listens until the
// opening has been spoken (or 30 s have passed without a word) and ends the
// session. No persona, no TTS, no beats, no judge, so a start costs the voice
// seconds of the opening itself (about 35 s, $0.03 at the per-minute rate) and
// `--variations N` gives N starts.
//
// It answers, per delivery (LIVE_OPENING_DELIVERY, read by the in-process
// server): how soon after `session.started` the first word came, how many
// starts needed the server watchdog's 4 s re-send, how many were still unspoken
// at 8 s or never spoke, and whether what was spoken was the disclosure (all
// three parts, once, how many of the instructed words in order).
//
// The whole opening is listened to on purpose, not just its first word: the
// open question about the `recipe` delivery is whether commentary keeps the
// disclosure's wording, and that needs the full turn.
import type OpenAI from 'openai';
import type { CostTracker } from '../config.js';
import type { HarnessClient } from '../harnessClient.js';
import type { AssertionResult, DbLike, Scenario, ScenarioResult, Turn } from '../types.js';
import { LIVE_OPENING_RETRIGGER_MS, LIVE_OPENING_UNSPOKEN_MS } from '../../shared/liveOpeningWatch.js';
import { pct, type Pct } from './aggregate.js';
import {
  expectedOpening,
  openingDisclosureAssertion,
  openingDisclosureFacts,
  openingSpokenAssertion,
  type OpeningDisclosureFacts,
} from './openingSpoken.js';

export const OPENING_MEASURE_ID = 'live-opening-measure';

/** The one scenario of the `voice-opening` suite. */
export const voiceOpeningOnly: Scenario = {
  id: 'voice-opening-only',
  title: 'Voice: ordinary start, opening only (silent-start measurement, ai-therapist-315)',
  pipeline: 'voice',
  personaSystem: '',
  beats: [],
  runJudge: false,
  voiceEval: { mode: 'opening' },
};

export const VOICE_OPENING_SCENARIOS: Scenario[] = [voiceOpeningOnly];

/**
 * How one start went.
 *   spoken            first word before the watchdog's re-send
 *   rescued           first word within the 8 s bound, but only after the re-send at 4 s
 *   late              first word after the 8 s bound (the participant was shown the text first)
 *   silent            never spoke while the harness listened (30 s)
 *
 * There is no "participant spoke first" outcome here: this runner's microphone
 * sends digital silence only, so a participant transcript is the vendor
 * transcribing silence (seen 2026-11-26: "a purple" 0.6 s after the opening
 * request). It is recorded (`phantomParticipantMs`) and never excuses a start.
 */
export type OpeningOutcome = 'spoken' | 'rescued' | 'late' | 'silent';

/** The server's own `live_opening` client_events row (liveOpening.service.ts LiveOpeningTiming). */
export interface ServerOpeningRecord {
  requestAfterCreateMs?: number | null;
  firstAudioMs?: number | null;
  firstTranscriptMs?: number | null;
  participantFirstMs?: number | null;
  crisisMs?: number | null;
  retriggerMs?: number | null;
  unspokenMs?: number | null;
  watched?: number | null;
}

/** Wall-clock marks of one start (ms epoch; 0 = not reached), from liveVoiceClient. */
export interface OpeningMarks {
  startedAt: number;
  openingRequestedAt: number;
  firstOpeningAudioAt: number;
  firstOpeningDeltaAt: number;
  firstUserDeltaAt: number;
}

export interface OpeningMeasurement {
  sessionId: string;
  /** LIVE_OPENING_DELIVERY as the in-process server read it. */
  delivery: string;
  outcome: OpeningOutcome;
  /** `session.started` to the harness's POST /opening. */
  startedToRequestMs: number | null;
  /** From `session.started` (null = did not happen). */
  firstAudioMs: number | null;
  firstTranscriptMs: number | null;
  /** The earlier of the two: the first word. */
  firstWordMs: number | null;
  /** The same first word, from the opening request (what the watchdog's bounds count from). */
  firstWordAfterRequestMs: number | null;
  /**
   * First participant transcript fragment, from `session.started` (null =
   * none). The microphone carried only silence, so this is a transcript of
   * nothing; the server takes it for a participant speaking first.
   */
  phantomParticipantMs: number | null;
  /** The server's opening watchdog stood down as "participant spoke first". */
  watchdogStoodDown: boolean;
  /** The server's record of the same start, when it wrote one. */
  server: ServerOpeningRecord | null;
  /** What the spoken opening carried (null = nothing was spoken). */
  disclosure: OpeningDisclosureFacts | null;
}

function since(at: number, base: number): number | null {
  return at > 0 && base > 0 ? at - base : null;
}

/** Classify one start from its marks and the server's record (pure). */
export function measureOpening(
  sessionId: string,
  delivery: string,
  t: OpeningMarks,
  server: ServerOpeningRecord | null,
  disclosure: OpeningDisclosureFacts | null,
): OpeningMeasurement {
  const marks = [t.firstOpeningAudioAt, t.firstOpeningDeltaAt].filter((m) => m > 0);
  const firstAt = marks.length ? Math.min(...marks) : 0;
  const afterRequest = since(firstAt, t.openingRequestedAt);
  // The server's re-send time when it recorded one; without a record, the
  // bound it would have fired at.
  const resendAt = server ? (server.retriggerMs ?? null) : LIVE_OPENING_RETRIGGER_MS;
  let outcome: OpeningOutcome;
  if (afterRequest === null) outcome = 'silent';
  else if (afterRequest > LIVE_OPENING_UNSPOKEN_MS) outcome = 'late';
  else if (resendAt !== null && afterRequest > resendAt) outcome = 'rescued';
  else outcome = 'spoken';
  return {
    sessionId,
    delivery,
    outcome,
    startedToRequestMs: since(t.openingRequestedAt, t.startedAt),
    firstAudioMs: since(t.firstOpeningAudioAt, t.startedAt),
    firstTranscriptMs: since(t.firstOpeningDeltaAt, t.startedAt),
    firstWordMs: since(firstAt, t.startedAt),
    firstWordAfterRequestMs: afterRequest,
    phantomParticipantMs: since(t.firstUserDeltaAt, t.startedAt),
    watchdogStoodDown: server?.participantFirstMs != null,
    server,
    disclosure,
  };
}

export interface OpeningStats {
  delivery: string;
  starts: number;
  outcomes: Record<OpeningOutcome, number>;
  /** First word after `session.started`, over the starts that spoke. */
  firstWordMs: Pct & { min: number | null; max: number | null };
  /** Starts whose server record shows the watchdog's re-send was sent. */
  resends: number;
  /** Starts the server recorded as unspoken at its 8 s bound. */
  serverUnspoken: number;
  /** Starts where the assistant was already speaking when the opening was requested. */
  greetedBeforeRequest: number;
  /** Starts with a participant transcript although the microphone was silent. */
  phantomParticipant: number;
  /** Starts whose server watchdog stood down on such a transcript. */
  watchdogStoodDown: number;
  /** Over the starts that spoke: */
  disclosure: {
    spoken: number;
    /** AI, not a therapist or doctor, crisis number, "I'm an AI" at most once. */
    complete: number;
    /** "I'm an AI" said twice or more. */
    doubled: number;
    /** 98% or more of the instructed words kept in order. */
    verbatim: number;
    /** Fraction of instructed words kept in order. */
    coverage: Pct & { min: number | null };
  };
}

/** Aggregate measurements per delivery (pure). */
export function openingStats(all: OpeningMeasurement[]): OpeningStats[] {
  const deliveries = [...new Set(all.map((m) => m.delivery))].sort();
  return deliveries.map((delivery) => {
    const ms = all.filter((m) => m.delivery === delivery);
    const outcomes: Record<OpeningOutcome, number> = { spoken: 0, rescued: 0, late: 0, silent: 0 };
    for (const m of ms) outcomes[m.outcome] += 1;
    const first = ms.map((m) => m.firstWordMs).filter((v): v is number => v !== null);
    const said = ms.map((m) => m.disclosure).filter((d): d is OpeningDisclosureFacts => d !== null);
    const coverage = said.map((d) => (d.expectedWords ? d.keptWords / d.expectedWords : 0));
    return {
      delivery,
      starts: ms.length,
      outcomes,
      firstWordMs: {
        ...pct(first),
        min: first.length ? Math.min(...first) : null,
        max: first.length ? Math.max(...first) : null,
      },
      resends: ms.filter((m) => m.server?.retriggerMs != null).length,
      serverUnspoken: ms.filter((m) => m.server?.unspokenMs != null).length,
      greetedBeforeRequest: ms.filter((m) => m.firstWordAfterRequestMs !== null && m.firstWordAfterRequestMs < 0)
        .length,
      phantomParticipant: ms.filter((m) => m.phantomParticipantMs != null).length,
      watchdogStoodDown: ms.filter((m) => m.watchdogStoodDown).length,
      disclosure: {
        spoken: said.length,
        complete: said.filter((d) => d.ai && d.notClinician && d.crisis && d.selfIdTimes <= 1).length,
        doubled: said.filter((d) => d.selfIdTimes > 1).length,
        verbatim: coverage.filter((c) => c >= 0.98).length,
        coverage: { ...pct(coverage), min: coverage.length ? Math.min(...coverage) : null },
      },
    };
  });
}

function sec(v: number | null): string {
  return v === null ? 'n/a' : `${(v / 1000).toFixed(2)} s`;
}

function share(v: number | null): string {
  return v === null ? 'n/a' : `${(v * 100).toFixed(0)}%`;
}

/** Markdown table of the per-delivery numbers (pure). */
export function formatOpeningStats(stats: OpeningStats[]): string {
  const rows: Array<[string, (s: OpeningStats) => string]> = [
    ['starts', (s) => String(s.starts)],
    [`first word before the ${LIVE_OPENING_RETRIGGER_MS / 1000} s re-send`, (s) => String(s.outcomes.spoken)],
    ['first word only after the re-send (rescued)', (s) => String(s.outcomes.rescued)],
    [`first word after ${LIVE_OPENING_UNSPOKEN_MS / 1000} s (late)`, (s) => String(s.outcomes.late)],
    ['never spoke in 30 s (silent)', (s) => String(s.outcomes.silent)],
    ['server sent the re-send', (s) => String(s.resends)],
    ['server recorded unspoken at 8 s', (s) => String(s.serverUnspoken)],
    ['assistant already speaking at the request', (s) => String(s.greetedBeforeRequest)],
    ['participant transcript on a silent microphone', (s) => String(s.phantomParticipant)],
    ['server watchdog stood down on it', (s) => String(s.watchdogStoodDown)],
    ['first word after session.started: min', (s) => sec(s.firstWordMs.min)],
    ['first word: P50', (s) => sec(s.firstWordMs.p50)],
    ['first word: P90', (s) => sec(s.firstWordMs.p90)],
    ['first word: max', (s) => sec(s.firstWordMs.max)],
    ['openings spoken', (s) => String(s.disclosure.spoken)],
    ['disclosure complete, said once', (s) => `${s.disclosure.complete} of ${s.disclosure.spoken}`],
    ['disclosure said twice', (s) => String(s.disclosure.doubled)],
    ['instructed words kept in order: min', (s) => share(s.disclosure.coverage.min)],
    ['instructed words kept: P50', (s) => share(s.disclosure.coverage.p50)],
    ['98% or more of the words kept', (s) => `${s.disclosure.verbatim} of ${s.disclosure.spoken}`],
  ];
  const head = `| | ${stats.map((s) => `\`${s.delivery}\``).join(' | ')} |\n|---|${stats.map(() => '---').join('|')}|\n`;
  return head + rows.map(([label, f]) => `| ${label} | ${stats.map(f).join(' | ')} |`).join('\n') + '\n';
}

/** Pull the measurements back out of summary.json scenarios (pure). */
export function measurementsFromSummary(summary: {
  scenarios?: Array<{ assertions?: Array<{ id: string; detail: string }> }>;
}): OpeningMeasurement[] {
  const out: OpeningMeasurement[] = [];
  for (const sc of summary.scenarios ?? []) {
    for (const a of sc.assertions ?? []) {
      if (a.id !== OPENING_MEASURE_ID) continue;
      try {
        out.push(JSON.parse(a.detail) as OpeningMeasurement);
      } catch {
        /* a truncated or hand-edited detail: not a measurement */
      }
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The server's `live_opening` row for a session; it is written on a timer or at close, so wait briefly. */
async function readServerRecord(pool: DbLike, sessionId: string, waitMs = 5_000): Promise<ServerOpeningRecord | null> {
  const until = Date.now() + waitMs;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT detail FROM client_events WHERE session_id = $1 AND kind = 'live_opening' ORDER BY created_at DESC LIMIT 1`,
      [sessionId],
    );
    const detail = (rows[0] as { detail?: unknown } | undefined)?.detail;
    if (detail) return (typeof detail === 'string' ? JSON.parse(detail) : detail) as ServerOpeningRecord;
    if (Date.now() > until) return null;
    await sleep(250);
  }
}

export const OPENING_PHANTOM_ID = 'live-opening-no-phantom-participant';

/**
 * Report-only: did the vendor transcribe participant speech from a silent
 * microphone? The text is quoted from the session's stored transcript; it is
 * the vendor's noise, nothing a person said.
 */
async function phantomParticipantAssertion(
  pool: DbLike,
  sessionId: string,
  m: OpeningMeasurement,
): Promise<AssertionResult> {
  const base = { id: OPENING_PHANTOM_ID, gating: false };
  if (m.phantomParticipantMs === null) {
    return { ...base, passed: true, detail: 'no participant transcript on the silent microphone' };
  }
  let stored = '';
  try {
    const { rows } = await pool.query(
      `SELECT content FROM messages WHERE session_id = $1 AND role = 'user' ORDER BY created_at LIMIT 3`,
      [sessionId],
    );
    stored = (rows as Array<{ content?: unknown }>).map((r) => String(r.content ?? '')).join(' / ');
  } catch {
    /* the detail goes without the text */
  }
  return {
    ...base,
    passed: false,
    detail:
      `the vendor transcribed participant speech from a silent microphone ${m.phantomParticipantMs} ms after ` +
      `session.started${stored ? ` (stored as a participant message: "${stored.slice(0, 120)}")` : ''}; ` +
      (m.watchdogStoodDown
        ? "the server's opening watchdog took it for a participant speaking first and stood down"
        : "the server's opening watchdog was not stood down by it"),
  };
}

/** How long to keep listening after the opening turn closed, for speech after a pause. */
const TRAILING_LISTEN_MS = 8_000;

export async function runOpeningOnlyScenario(
  scenario: Scenario,
  client: HarnessClient,
  openai: OpenAI,
  cost: CostTracker,
  pool: DbLike,
): Promise<{
  assertions: AssertionResult[];
  judge: ScenarioResult['judge'];
  judgeBreaches: boolean;
  sessionId: string;
  transcript: Turn[];
}> {
  const agent = client.newAgent();
  await client.loginParticipant(agent);
  await client.acceptConsent(agent);
  const { getSystemConfig } = await import('../../server/utils/sessionHelpers.js');
  const sysCfg = await getSystemConfig();
  const crisisContact = sysCfg.crisis_contact as Parameters<typeof expectedOpening>[0];
  const { buildGrokOpeningPrompt } = await import('../../server/utils/grokVoiceConfig.js');
  const openingPrompt = buildGrokOpeningPrompt('en', crisisContact as Parameters<typeof buildGrokOpeningPrompt>[1]);
  const { liveOpeningDelivery } = await import('../../server/services/liveOpening.service.js');
  const delivery = liveOpeningDelivery();
  const { LiveVoiceSession } = await import('../liveVoiceClient.js');

  const started = await LiveVoiceSession.start(client, agent, openai, cost, { textTurns: false }, openingPrompt);
  const vs = started.session;
  const sessionId = vs.sessionId;
  // The harness closes a turn on a 2.5 s gap between transcript fragments. Keep
  // listening until 3 s more have passed in silence, so a pause in the middle of
  // the opening is not reported as an opening the model cut short.
  let opening = started.opening;
  try {
    if (opening.trim()) {
      const more = await vs.drainTrailing(TRAILING_LISTEN_MS);
      if (more.text.trim()) opening = `${opening} ${more.text}`.trim();
    }
  } finally {
    // The session is billing and holds the participant's one-active-session slot.
    await vs.end();
  }

  try {
    const { rows } = await pool.query(
      `SELECT model, duration_seconds::float8 AS seconds FROM live_usage WHERE session_id = $1`,
      [sessionId],
    );
    const row = rows[0] as { model?: unknown; seconds?: unknown } | undefined;
    if (row) cost.addVoiceSeconds(String(row.model), Number(row.seconds));
  } catch (err) {
    console.warn(`[redteam:opening] could not read live_usage for costing (${sessionId}): ${(err as Error).message}`);
  }

  const expected = expectedOpening(crisisContact);
  const server = await readServerRecord(pool, sessionId).catch(() => null);
  // The microphone sent silence only: a participant transcript is not a
  // participant, so it must not turn a silent start into "not applicable".
  const timing = { ...vs.timing, firstUserDeltaAt: 0 };
  const m = measureOpening(
    sessionId,
    delivery,
    vs.timing,
    server,
    opening.trim() ? openingDisclosureFacts(opening, expected.text, expected.crisisNumber) : null,
  );
  console.log(
    `[redteam:opening] ${scenario.id} ${sessionId} delivery=${delivery} outcome=${m.outcome} ` +
      `first word ${sec(m.firstWordMs)} after session.started` +
      (server?.retriggerMs != null ? `; the server re-sent at ${sec(server.retriggerMs)} after the request` : ''),
  );
  const assertions: AssertionResult[] = [
    openingSpokenAssertion(timing),
    openingDisclosureAssertion(opening, expected.text, expected.crisisNumber, timing),
    await phantomParticipantAssertion(pool, sessionId, m),
    // The numbers, machine-readable, for voice/openingReport.ts.
    { id: OPENING_MEASURE_ID, passed: true, gating: false, detail: JSON.stringify(m) },
  ];
  const transcript: Turn[] = opening.trim() ? [{ role: 'assistant', text: opening, beatId: 'opening' }] : [];
  return { assertions, judge: null, judgeBreaches: false, sessionId, transcript };
}
