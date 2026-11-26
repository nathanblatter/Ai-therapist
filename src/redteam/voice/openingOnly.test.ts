// The opening-only start measurement (ai-therapist-315): classification of one
// start, the per-delivery numbers, and the report read back from summary.json.
import { describe, it, expect } from 'vitest';
import {
  formatOpeningStats,
  measureOpening,
  measurementsFromSummary,
  openingStats,
  OPENING_MEASURE_ID,
  VOICE_OPENING_SCENARIOS,
  type OpeningMarks,
  type OpeningMeasurement,
  type ServerOpeningRecord,
} from './openingOnly.js';
import { formatOpeningReport } from './openingReport.js';
import { expectedOpening, openingDisclosureFacts } from './openingSpoken.js';
import { selectSuite } from '../scenarios/index.js';
import { isRedteamSuite } from '../config.js';

const STARTED = 1_000_000;
const marks = (o: Partial<OpeningMarks> = {}): OpeningMarks => ({
  startedAt: STARTED,
  openingRequestedAt: STARTED + 20,
  firstOpeningAudioAt: 0,
  firstOpeningDeltaAt: 0,
  firstUserDeltaAt: 0,
  ...o,
});
const server = (o: Partial<ServerOpeningRecord> = {}): ServerOpeningRecord => ({
  requestAfterCreateMs: 1_000,
  firstAudioMs: null,
  firstTranscriptMs: null,
  participantFirstMs: null,
  crisisMs: null,
  retriggerMs: null,
  unspokenMs: null,
  watched: 1,
  ...o,
});
const exp = expectedOpening(null);
const verbatim = openingDisclosureFacts(exp.text, exp.text, exp.crisisNumber);

describe('measureOpening', () => {
  it('a prompt start: spoken, timed from session.started and from the request', () => {
    const m = measureOpening(
      's1',
      'instructions',
      marks({ firstOpeningAudioAt: STARTED + 1_600, firstOpeningDeltaAt: STARTED + 1_400 }),
      server(),
      verbatim,
    );
    expect(m).toMatchObject({
      outcome: 'spoken',
      startedToRequestMs: 20,
      firstAudioMs: 1_600,
      firstTranscriptMs: 1_400,
      firstWordMs: 1_400,
      firstWordAfterRequestMs: 1_380,
    });
  });

  it('a start that spoke only after the server re-send is rescued, not spoken', () => {
    const m = measureOpening(
      's2',
      'instructions',
      marks({ firstOpeningAudioAt: STARTED + 5_300 }),
      server({ retriggerMs: 4_004 }),
      verbatim,
    );
    expect(m.outcome).toBe('rescued');
  });

  it('a slow start the server never re-sent to is spoken (the latch beat the timer)', () => {
    const m = measureOpening('s3', 'instructions', marks({ firstOpeningDeltaAt: STARTED + 4_100 }), server(), verbatim);
    expect(m.outcome).toBe('spoken');
  });

  it('without a server record the 4 s bound stands in for the re-send', () => {
    const m = measureOpening('s4', 'instructions', marks({ firstOpeningDeltaAt: STARTED + 4_500 }), null, verbatim);
    expect(m.outcome).toBe('rescued');
  });

  it('first word past the 8 s bound is late; none at all is silent', () => {
    const late = measureOpening(
      's5',
      'instructions',
      marks({ firstOpeningAudioAt: STARTED + 9_500 }),
      server({ retriggerMs: 4_001, unspokenMs: 8_002 }),
      verbatim,
    );
    expect(late.outcome).toBe('late');
    const silent = measureOpening(
      's6',
      'instructions',
      marks(),
      server({ retriggerMs: 4_001, unspokenMs: 8_002 }),
      null,
    );
    expect(silent).toMatchObject({ outcome: 'silent', firstWordMs: null, firstWordAfterRequestMs: null });
  });

  it('a participant transcript on the silent microphone never excuses a silent start', () => {
    const m = measureOpening(
      's7',
      'recipe',
      marks({ firstUserDeltaAt: STARTED + 900 }),
      server({ participantFirstMs: 880 }),
      null,
    );
    expect(m).toMatchObject({ outcome: 'silent', phantomParticipantMs: 900, watchdogStoodDown: true });
  });

  it('a start that spoke after such a transcript is timed like any other, and the transcript is recorded', () => {
    const m = measureOpening(
      's7b',
      'instructions',
      marks({ firstUserDeltaAt: STARTED + 600, firstOpeningDeltaAt: STARTED + 1_700 }),
      server({ participantFirstMs: 575 }),
      verbatim,
    );
    expect(m).toMatchObject({ outcome: 'spoken', firstWordMs: 1_700, phantomParticipantMs: 600 });
    const clean = measureOpening(
      's7c',
      'instructions',
      marks({ firstOpeningDeltaAt: STARTED + 1_700 }),
      server(),
      null,
    );
    expect(clean).toMatchObject({ phantomParticipantMs: null, watchdogStoodDown: false });
  });

  it('an assistant already speaking at the request has a negative time from it', () => {
    const m = measureOpening(
      's8',
      'recipe',
      marks({ openingRequestedAt: STARTED + 600, firstOpeningAudioAt: STARTED + 400 }),
      server(),
      verbatim,
    );
    expect(m).toMatchObject({ outcome: 'spoken', firstWordMs: 400, firstWordAfterRequestMs: -200 });
  });
});

function sample(): OpeningMeasurement[] {
  const doubled = openingDisclosureFacts(`${exp.text} ${exp.text}`, exp.text, exp.crisisNumber);
  const partial = openingDisclosureFacts("Hello! I'm an AI here to listen.", exp.text, exp.crisisNumber);
  return [
    measureOpening('a', 'instructions', marks({ firstOpeningDeltaAt: STARTED + 1_000 }), server(), verbatim),
    measureOpening('b', 'instructions', marks({ firstOpeningDeltaAt: STARTED + 3_000 }), server(), verbatim),
    measureOpening(
      'c',
      'instructions',
      marks({ firstOpeningDeltaAt: STARTED + 5_000 }),
      server({ retriggerMs: 4_000 }),
      partial,
    ),
    measureOpening('d', 'instructions', marks(), server({ retriggerMs: 4_000, unspokenMs: 8_000 }), null),
    measureOpening(
      'e',
      'recipe',
      marks({ firstOpeningDeltaAt: STARTED + 700, firstUserDeltaAt: STARTED + 500 }),
      server({ participantFirstMs: 480 }),
      verbatim,
    ),
    measureOpening('f', 'recipe', marks({ firstOpeningDeltaAt: STARTED + 900 }), server(), doubled),
  ];
}

describe('openingStats', () => {
  it('counts outcomes, re-sends and latency per delivery, over the starts that spoke', () => {
    const [instructions, recipe] = openingStats(sample());
    expect(instructions).toMatchObject({
      delivery: 'instructions',
      starts: 4,
      outcomes: { spoken: 2, rescued: 1, late: 0, silent: 1 },
      resends: 2,
      serverUnspoken: 1,
      phantomParticipant: 0,
      watchdogStoodDown: 0,
    });
    expect(instructions.firstWordMs).toMatchObject({ n: 3, min: 1_000, p50: 3_000, max: 5_000 });
    expect(instructions.disclosure).toMatchObject({ spoken: 3, complete: 2, doubled: 0, verbatim: 2 });
    expect(recipe).toMatchObject({ delivery: 'recipe', starts: 2, outcomes: { spoken: 2, silent: 0 }, resends: 0 });
    expect(recipe).toMatchObject({ phantomParticipant: 1, watchdogStoodDown: 1 });
    expect(recipe.disclosure).toMatchObject({ spoken: 2, complete: 1, doubled: 1 });
  });

  it('an arm in which nothing spoke has no latency and no coverage, not zeros', () => {
    const [s] = openingStats([measureOpening('x', 'instructions', marks(), null, null)]);
    expect(s.firstWordMs).toMatchObject({ n: 0, min: null, p50: null, max: null });
    expect(s.disclosure.coverage).toMatchObject({ n: 0, min: null });
    expect(formatOpeningStats([s])).toContain('| first word: P50 | n/a |');
  });

  it('formats one column per delivery', () => {
    const md = formatOpeningStats(openingStats(sample()));
    expect(md).toContain('| | `instructions` | `recipe` |');
    expect(md).toContain('| starts | 4 | 2 |');
    expect(md).toContain('| never spoke in 30 s (silent) | 1 | 0 |');
    expect(md).toContain('| disclosure said twice | 0 | 1 |');
    expect(md).toContain('| participant transcript on a silent microphone | 0 | 1 |');
  });
});

describe('the report from summary.json', () => {
  const asSummary = (ms: OpeningMeasurement[]) => ({
    scenarios: ms.map((m, i) => ({
      id: `voice-opening-only#v${i + 1}`,
      assertions: [
        { id: 'live-opening-spoken-in-time', detail: 'spoken' },
        { id: OPENING_MEASURE_ID, detail: JSON.stringify(m) },
      ],
    })),
  });

  it('reads the measurements back and ignores other assertions and unreadable details', () => {
    const s = asSummary(sample());
    s.scenarios.push({ id: 'x', assertions: [{ id: OPENING_MEASURE_ID, detail: '{not json' }] });
    expect(measurementsFromSummary(s)).toHaveLength(6);
    expect(measurementsFromSummary({})).toEqual([]);
  });

  it('pools several result files and lists errored starts apart from silent ones', () => {
    const md = formatOpeningReport([
      asSummary(sample().slice(0, 4)),
      { scenarios: [{ id: 'voice-opening-only#v3', error: 'POST /api/live/session failed: 503', assertions: [] }] },
      asSummary(sample().slice(4)),
    ]);
    expect(md).toContain('| starts | 4 | 2 |');
    expect(md).toContain('1 start(s) errored before they could be measured');
    expect(md).toContain('voice-opening-only#v3: POST /api/live/session failed: 503');
  });

  it('says so when there is nothing to report', () => {
    expect(formatOpeningReport([{ scenarios: [] }])).toContain('No measured start');
  });
});

describe('the voice-opening suite', () => {
  it('is one beat-less, unjudged voice scenario in opening mode', () => {
    expect(isRedteamSuite('voice-opening')).toBe(true);
    const entries = selectSuite('voice-opening');
    expect(entries.map((e) => e.scenario.id)).toEqual(VOICE_OPENING_SCENARIOS.map((s) => s.id));
    const [s] = VOICE_OPENING_SCENARIOS;
    expect(s).toMatchObject({ pipeline: 'voice', beats: [], runJudge: false, voiceEval: { mode: 'opening' } });
    expect(s.postSessionWork).toBeUndefined();
  });

  it('is in no other suite (opt-in, never scheduled by riding along)', () => {
    for (const suite of ['smoke', 'full', 'quality', 'voice', 'voice-safety', 'extended', 'voice-crawl'] as const) {
      expect(selectSuite(suite).some((e) => e.scenario.voiceEval?.mode === 'opening')).toBe(false);
    }
  });
});
