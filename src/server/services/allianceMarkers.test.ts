import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ALLIANCE_MODEL,
  ALLIANCE_RUBRIC,
  ALLIANCE_SUBSCALES,
  LEVEL_LABELS,
  MAX_TRANSCRIPT_CHARS,
  MIN_PARTICIPANT_TURNS,
  MIN_PARTICIPANT_WORDS,
  belowLengthFloor,
  buildAllianceBody,
  parseAllianceResponse,
  renderTranscript,
  transcriptStats,
  type AllianceTurn,
} from './allianceMarkers.js';

const score = (name: string, probs: number[]) => ({
  type: 'score',
  name,
  score: 0,
  confidence: Math.max(...probs),
  probabilities: probs.map((probability, i) => ({ label: LEVEL_LABELS[i], value: i, probability })),
});
const predicate = (name: string, probability: number) => ({ type: 'predicate', name, probability });

/** A well-formed response: every subscale rateable unless overridden. */
function response(over: Partial<Record<string, unknown>> = {}) {
  const answers: Record<string, unknown> = {
    task_rateable: predicate('task_rateable', 0.97),
    task_score: score('task_score', [0, 0, 0.1, 0.6, 0.3]),
    bond_rateable: predicate('bond_rateable', 0.9),
    bond_score: score('bond_score', [0.7, 0.2, 0.1, 0, 0]),
    goal_rateable: predicate('goal_rateable', 0.03),
    goal_score: score('goal_score', [0.2, 0.2, 0.2, 0.2, 0.2]),
    ...over,
  };
  return {
    model: 'gpt-6-luna',
    answers: Object.values(answers),
    usage: { input_tokens: 2100, output_tokens: 0 },
  };
}

describe('alliance judge request', () => {
  const body = buildAllianceBody('Participant: hello\nAssistant: hi');

  it('asks two questions per subscale: can it be rated, then the level', () => {
    expect(body.model).toBe(ALLIANCE_MODEL);
    expect(body.questions.map((q) => `${q.type}:${q.name}`)).toEqual([
      'predicate:task_rateable',
      'score:task_score',
      'predicate:bond_rateable',
      'score:bond_score',
      'predicate:goal_rateable',
      'score:goal_score',
    ]);
  });

  it('gives every score question five described levels labelled 1 to 5', () => {
    for (const q of body.questions) {
      if (q.type !== 'score') continue;
      expect(q.levels.map((l) => l.label)).toEqual(['1', '2', '3', '4', '5']);
      for (const level of q.levels) expect((level.description ?? '').length).toBeGreaterThan(40);
    }
  });

  it('sends the transcript as the one user message and nothing the endpoint rejects', () => {
    expect(Array.isArray(body.input)).toBe(true);
    const input = body.input as Array<{ role: string; content: string }>;
    expect(input.map((m) => m.role)).toEqual(['developer', 'user']);
    expect(input[1].content).toBe('Participant: hello\nAssistant: hi');
    // The Decisions API has no `store` field and 400s on unknown parameters.
    expect(Object.keys(body).sort()).toEqual(['input', 'model', 'questions']);
  });

  it('tells the judge that each subscale is rated apart from the other two', () => {
    for (const subscale of ALLIANCE_SUBSCALES) {
      const q = body.questions.find((x) => x.name === `${subscale}_score`)!;
      expect(q.instructions).toContain(ALLIANCE_RUBRIC[subscale].apartFrom);
    }
  });
});

describe('alliance judge response', () => {
  it('reads level, mean score, confidence and distribution for a rateable subscale', () => {
    const { subscales, tokensIn, tokensOut, model } = parseAllianceResponse(response());
    expect(subscales.task).toEqual({
      rateable: true,
      pRateable: 0.97,
      score: 4.2,
      level: 4,
      confidence: 0.6,
      distribution: [0, 0, 0.1, 0.6, 0.3],
    });
    expect(subscales.bond.level).toBe(1);
    expect(subscales.bond.score).toBe(1.4);
    expect(model).toBe('gpt-6-luna');
    expect(tokensIn).toBe(2100);
    expect(tokensOut).toBe(0);
  });

  it('a subscale the judge cannot rate has no score at all, never a low one', () => {
    const { subscales } = parseAllianceResponse(response());
    expect(subscales.goal).toEqual({
      rateable: false,
      pRateable: 0.03,
      score: null,
      level: null,
      confidence: null,
      distribution: null,
    });
  });

  it('reads the level from the label, whatever `value` the API attaches', () => {
    const shifted = score('task_score', [0, 0, 0, 0, 1]);
    shifted.probabilities.forEach((p, i) => (p.value = i + 10));
    expect(parseAllianceResponse(response({ task_score: shifted })).subscales.task.level).toBe(5);
  });

  it('a tie for the most probable level reports the lower level; the mean score is unaffected', () => {
    const two = parseAllianceResponse(response({ task_score: score('task_score', [0, 0, 0.5, 0.5, 0]) })).subscales
      .task;
    expect(two).toMatchObject({ level: 3, confidence: 0.5, score: 3.5 });
    // Three-way tie, and a tie that is not between neighbours: still the lowest.
    const three = parseAllianceResponse(response({ task_score: score('task_score', [0.1, 0.3, 0.3, 0, 0.3]) }));
    expect(three.subscales.task.level).toBe(2);
    // No tie: the single highest level wins wherever it sits.
    const none = parseAllianceResponse(response({ task_score: score('task_score', [0.2, 0.2, 0.25, 0.35, 0]) }));
    expect(none.subscales.task.level).toBe(4);
  });

  it('accepts answers in any order when they carry names', () => {
    const r = response();
    r.answers.reverse();
    expect(parseAllianceResponse(r).subscales.task.level).toBe(4);
  });

  it.each([
    ['a refused score', { bond_score: { type: 'refusal', name: 'bond_score' } }],
    ['a refused rateable question', { task_rateable: { type: 'refusal', name: 'task_rateable' } }],
    ['a probability above 1', { task_rateable: predicate('task_rateable', 1.2) }],
    ['a missing level', { goal_score: { ...score('goal_score', [0.5, 0.5, 0, 0, 0]), probabilities: [] } }],
    ['levels that do not sum to 1', { task_score: score('task_score', [0.1, 0.1, 0.1, 0.1, 0.1]) }],
    ['a score answered as a predicate', { task_score: predicate('task_score', 0.5) }],
  ])('throws on %s rather than guessing', (_label, over) => {
    expect(() => parseAllianceResponse(response(over))).toThrow();
  });

  it('throws on a malformed score even when that subscale is not rateable', () => {
    expect(() =>
      parseAllianceResponse(response({ goal_score: { type: 'score', name: 'goal_score', probabilities: [] } })),
    ).toThrow();
  });

  it('throws on an empty or missing answer list', () => {
    expect(() => parseAllianceResponse({ answers: [] })).toThrow();
    expect(() => parseAllianceResponse(null)).toThrow();
  });
});

describe('transcript handling', () => {
  const turns: AllianceTurn[] = [
    { role: 'assistant', text: ' Hi there. ' },
    { role: 'participant', text: 'one two three' },
    { role: 'participant', text: '   ' },
    { role: 'assistant', text: 'ok' },
    { role: 'participant', text: 'four five' },
  ];

  it('counts participant turns and words only, ignoring blank turns', () => {
    expect(transcriptStats(turns)).toEqual({ participantTurns: 2, participantWords: 5 });
  });

  it('the length floor needs both enough turns and enough words', () => {
    expect(belowLengthFloor({ participantTurns: MIN_PARTICIPANT_TURNS - 1, participantWords: 500 })).toBe(true);
    expect(belowLengthFloor({ participantTurns: 50, participantWords: MIN_PARTICIPANT_WORDS - 1 })).toBe(true);
    expect(belowLengthFloor({ participantTurns: MIN_PARTICIPANT_TURNS, participantWords: MIN_PARTICIPANT_WORDS })).toBe(
      false,
    );
  });

  it('renders speaker-labelled lines and drops blank turns', () => {
    expect(renderTranscript(turns)).toEqual({
      text: 'Assistant: Hi there.\nParticipant: one two three\nAssistant: ok\nParticipant: four five',
      truncated: false,
    });
  });

  it('keeps the opening and the close of an over-long transcript and says so', () => {
    const long: AllianceTurn[] = Array.from({ length: 400 }, (_, i) => ({
      role: i % 2 ? 'participant' : 'assistant',
      text: `turn ${i} ` + 'x'.repeat(40),
    }));
    const { text, truncated } = renderTranscript(long, 2000);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text.startsWith('Assistant: turn 0 ')).toBe(true);
    expect(text).toContain('middle of the conversation omitted');
    expect(text.trimEnd().endsWith('x')).toBe(true);
    expect(text).toContain('turn 399');
  });

  it('the budget fits a whole long session', () => {
    // A 60-minute voice session is on the order of 9,000 words, about 55,000 characters.
    expect(MAX_TRANSCRIPT_CHARS).toBeGreaterThanOrEqual(100_000);
  });
});

describe('invented golden transcripts (evals/goldens/alliance-markers.jsonl)', () => {
  const cases = readFileSync(new URL('../../../evals/goldens/alliance-markers.jsonl', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { id: string; expected: Record<string, string>; turns: Array<[string, string]> });

  it('has 12 to 16 well-formed cases with unique ids', () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
    expect(cases.length).toBeLessThanOrEqual(16);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) {
      for (const s of ALLIANCE_SUBSCALES) expect(['high', 'mid', 'low', 'not_rateable']).toContain(c.expected[s]);
      for (const [who, text] of c.turns) {
        expect(['p', 'a']).toContain(who);
        expect(text.length).toBeGreaterThan(0);
      }
    }
  });

  it('covers high and low on every subscale, and not-rateable cases above and below the length floor', () => {
    for (const s of ALLIANCE_SUBSCALES) {
      expect(cases.some((c) => c.expected[s] === 'high')).toBe(true);
      expect(cases.some((c) => c.expected[s] === 'low')).toBe(true);
    }
    const stats = (c: (typeof cases)[number]) =>
      transcriptStats(c.turns.map(([who, text]) => ({ role: who === 'p' ? 'participant' : 'assistant', text })));
    const none = cases.filter((c) => ALLIANCE_SUBSCALES.every((s) => c.expected[s] === 'not_rateable'));
    expect(none.some((c) => belowLengthFloor(stats(c)))).toBe(true);
    expect(none.some((c) => !belowLengthFloor(stats(c)))).toBe(true);
    // Every case that expects a score is long enough to reach the judge.
    for (const c of cases.filter((x) => !none.includes(x))) expect(belowLengthFloor(stats(c))).toBe(false);
  });
});
