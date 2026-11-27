// The shadow risk scorer's wire shape: the request it builds and how it reads
// the answer, including the rule that a refused or broken answer is never a
// clean one.
import { describe, it, expect } from 'vitest';
import {
  SHADOW_QUESTION_SET_VERSION,
  buildShadowBody,
  buildShadowInput,
  parseShadowResponse,
  ShadowAnswerError,
  SHADOW_MODEL,
  SHADOW_PREDICATE_NAMES,
  SHADOW_TRANSCRIPT_CHARS,
} from './shadowRiskQuestions.js';

type Answer = Record<string, unknown>;

function severityAnswer(p: { none: number; low: number; medium: number; high: number }): Answer {
  return {
    type: 'score',
    name: 'severity',
    score: 0,
    confidence: 0.9,
    probabilities: (['none', 'low', 'medium', 'high'] as const).map((label, value) => ({
      label,
      value,
      probability: p[label],
    })),
  };
}

function choiceAnswer(name: string, probabilities: Record<string, number>): Answer {
  const [choice, confidence] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
  return {
    type: 'choice',
    name,
    choice,
    confidence,
    probabilities: Object.entries(probabilities).map(([value, probability]) => ({ value, probability })),
  };
}
const NOBODY = { own: 0.01, third_party: 0.01, harm_to_others: 0.01, none: 0.97 };

/** A full answer set. `choices` replaces (or, with 'refuse', refuses) a choice
 *  question; `safety_answer` is only present when given. */
function response(
  severity: Answer,
  predicates: Partial<Record<string, number | 'refuse'>> = {},
  choices: Partial<Record<'risk_subject' | 'safety_answer', Record<string, number> | 'refuse'>> = {},
): { model: string; answers: Answer[]; usage: Record<string, number> } {
  const choice = (name: 'risk_subject' | 'safety_answer', fallback?: Record<string, number>): Answer[] => {
    const v = choices[name] ?? fallback;
    return v === undefined ? [] : [v === 'refuse' ? { type: 'refusal', name } : choiceAnswer(name, v)];
  };
  return {
    model: SHADOW_MODEL,
    answers: [
      severity,
      ...SHADOW_PREDICATE_NAMES.map((name): Answer => {
        const v = predicates[name] ?? 0.01;
        return v === 'refuse' ? { type: 'refusal', name } : { type: 'predicate', name, probability: v };
      }),
      ...choice('risk_subject', NOBODY),
      ...choice('safety_answer'),
    ],
    usage: { input_tokens: 3200, output_tokens: 0 },
  };
}

describe('buildShadowBody', () => {
  it('asks one severity score on the four production bands and one predicate per distinction', () => {
    const body = buildShadowBody('I want to end my life.', []);
    expect(body.model).toBe('gpt-6-luna');
    expect(body).not.toHaveProperty('store');
    const questions = body.questions as unknown as Array<Record<string, unknown>>;
    const [severity, ...predicates] = questions.filter((q) => q.type !== 'choice');
    expect(severity.type).toBe('score');
    expect((severity.levels as Array<{ label: string }>).map((l) => l.label)).toEqual([
      'none',
      'low',
      'medium',
      'high',
    ]);
    expect(predicates.map((q) => q.type)).toEqual(SHADOW_PREDICATE_NAMES.map(() => 'predicate'));
    expect(predicates.map((q) => q.name)).toEqual([
      'own_suicidal_intent',
      'passive_ideation',
      'plan_or_means',
      'self_harm_without_intent',
      'means_inquiry',
      'harm_to_others',
      'third_party_crisis',
      'figure_of_speech',
      'non_english',
    ]);
    // Well inside the API's 400-question limit.
    expect(body.questions.length).toBe(11);
  });

  it('asks whose risk it is as a choice of four, last', () => {
    const questions = buildShadowBody('hi', []).questions as unknown as Array<Record<string, unknown>>;
    const subject = questions[questions.length - 1];
    expect(subject).toMatchObject({ type: 'choice', name: 'risk_subject' });
    expect((subject.choices as Array<{ value: string }>).map((c) => c.value)).toEqual([
      'own',
      'third_party',
      'harm_to_others',
      'none',
    ]);
  });

  it('asks what the reply says only of a turn that follows a safety question', () => {
    const names = (body: { questions: unknown[] }): string[] =>
      (body.questions as Array<{ name: string }>).map((q) => q.name);
    expect(names(buildShadowBody('yeah', []))).not.toContain('safety_answer');
    expect(names(buildShadowBody('yeah', [], { followsSafetyQuestion: false }))).not.toContain('safety_answer');
    const asked = buildShadowBody('yeah', [], { followsSafetyQuestion: true });
    expect(asked.questions.length).toBe(12);
    const last = (asked.questions as unknown as Array<Record<string, unknown>>)[11];
    expect(last).toMatchObject({ type: 'choice', name: 'safety_answer' });
    expect((last.choices as Array<{ value: string }>).map((c) => c.value)).toEqual(['yes', 'no', 'unclear']);
  });

  it('the question set is version 2', () => {
    expect(SHADOW_QUESTION_SET_VERSION).toBe(2);
  });

  it('sends the transcript the assessor would be shown, then the latest message', () => {
    const input = buildShadowInput('I have what I need.', [
      { role: 'user', content: "Some days I don't want to be here." },
      { role: 'assistant', content: 'I hear you.' },
      { role: 'system', content: 'not a turn' },
      { role: 'user', content: null, content_redacted: 'redacted fallback' },
    ]);
    expect(input).toBe(
      "Recent transcript:\nParticipant: Some days I don't want to be here.\nAssistant: I hear you.\n" +
        'Participant: redacted fallback\n\nLatest participant message:\n"I have what I need."',
    );
    expect(buildShadowInput('hi')).toContain('Recent transcript:\n(none)');
  });

  it('keeps only the tail of a long transcript, like the assessor', () => {
    const history = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: `${i} ${'x'.repeat(400)}` }));
    const input = buildShadowInput('latest', history);
    expect(input.length).toBeLessThan(SHADOW_TRANSCRIPT_CHARS + 100);
    expect(input).toContain('49 xxx');
    expect(input).not.toContain('Participant: 0 xxx');
  });
});

describe('parseShadowResponse', () => {
  it('reads the most likely band, every probability and the token counts', () => {
    const a = parseShadowResponse(
      response(severityAnswer({ none: 0.02, low: 0.03, medium: 0.15, high: 0.8 }), { own_suicidal_intent: 0.97 }),
    );
    expect(a.severity).toBe('high');
    expect(a.severityProbabilities).toEqual({ none: 0.02, low: 0.03, medium: 0.15, high: 0.8 });
    expect(a.predicates.own_suicidal_intent).toBe(0.97);
    expect(Object.keys(a.predicates)).toHaveLength(9);
    expect(a.choices.risk_subject).toEqual({ choice: 'none', probabilities: NOBODY });
    expect(a.choices).not.toHaveProperty('safety_answer');
    expect(a.refused).toEqual([]);
    expect(a.tokensIn).toBe(3200);
  });

  it('breaks a tie toward the higher band', () => {
    const a = parseShadowResponse(response(severityAnswer({ none: 0.1, low: 0.1, medium: 0.4, high: 0.4 })));
    expect(a.severity).toBe('high');
  });

  it('finds answers by name, whatever their order', () => {
    const r = response(severityAnswer({ none: 0.9, low: 0.05, medium: 0.03, high: 0.02 }), { harm_to_others: 0.7 });
    r.answers.reverse();
    const a = parseShadowResponse(r);
    expect(a.severity).toBe('none');
    expect(a.predicates.harm_to_others).toBe(0.7);
  });

  it('a refused predicate is reported, not read as zero; the other answers are kept', () => {
    const a = parseShadowResponse(
      response(severityAnswer({ none: 0, low: 0, medium: 0.1, high: 0.9 }), { self_harm_without_intent: 'refuse' }),
    );
    expect(a.refused).toEqual(['self_harm_without_intent']);
    expect(a.predicates).not.toHaveProperty('self_harm_without_intent');
    expect(a.severity).toBe('high');
  });

  it('a refused severity leaves the severity unknown (null), never none', () => {
    const a = parseShadowResponse(response({ type: 'refusal', name: 'severity' }));
    expect(a.refused).toEqual(['severity']);
    expect(a.severity).toBeNull();
    expect(a.severityProbabilities).toBeNull();
  });

  it.each([
    ['no answers', { answers: [] }],
    ['not an object', null],
    [
      'a missing question',
      { answers: response(severityAnswer({ none: 1, low: 0, medium: 0, high: 0 })).answers.slice(0, 5) },
    ],
    [
      'a probability above 1',
      response(severityAnswer({ none: 1, low: 0, medium: 0, high: 0 }), { passive_ideation: 1.2 }),
    ],
    ['a negative probability', response(severityAnswer({ none: 1, low: 0, medium: 0, high: -0.2 }))],
    // Four zeros would otherwise read as "high" (ties go up).
    ['severity probabilities that are all zero', response(severityAnswer({ none: 0, low: 0, medium: 0, high: 0 }))],
    [
      'severity probabilities that do not sum to 1',
      response(severityAnswer({ none: 0.9, low: 0.9, medium: 0.9, high: 0.9 })),
    ],
    ['a severity that is not a score', response({ type: 'predicate', name: 'severity', probability: 0.5 })],
    [
      'no answer to whose risk it is',
      { answers: response(severityAnswer({ none: 1, low: 0, medium: 0, high: 0 })).answers.slice(0, 10) },
    ],
    [
      'a choice with a value missing',
      response(severityAnswer({ none: 1, low: 0, medium: 0, high: 0 }), {}, { risk_subject: { own: 0.5, none: 0.5 } }),
    ],
    [
      'choice probabilities that are all zero',
      response(
        severityAnswer({ none: 1, low: 0, medium: 0, high: 0 }),
        {},
        { risk_subject: { own: 0, third_party: 0, harm_to_others: 0, none: 0 } },
      ),
    ],
    [
      'a choice probability above 1',
      response(
        severityAnswer({ none: 1, low: 0, medium: 0, high: 0 }),
        {},
        { risk_subject: { own: 1.4, third_party: 0, harm_to_others: 0, none: 0 } },
      ),
    ],
    [
      'a severity with a band missing',
      response({
        type: 'score',
        name: 'severity',
        probabilities: [{ label: 'none', value: 0, probability: 1 }],
      }),
    ],
  ])('throws on %s instead of returning a clean answer', (_what, raw) => {
    expect(() => parseShadowResponse(raw)).toThrow(ShadowAnswerError);
  });

  it('error messages are built from fixed words only (safe to store)', () => {
    const raw = response(severityAnswer({ none: 1, low: 0, medium: 0, high: 0 }));
    (raw.answers[1] as Answer).probability = 'the participant said something private';
    try {
      parseShadowResponse(raw);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('private');
    }
  });
});

describe('the choice questions (question set v2)', () => {
  const CALM = severityAnswer({ none: 0.9, low: 0.05, medium: 0.03, high: 0.02 });

  it('reads whose risk it is, with a probability for every value', () => {
    const a = parseShadowResponse(
      response(CALM, {}, { risk_subject: { own: 0.02, third_party: 0.9, harm_to_others: 0.03, none: 0.05 } }),
    );
    expect(a.choices.risk_subject?.choice).toBe('third_party');
    expect(a.choices.risk_subject?.probabilities.third_party).toBe(0.9);
    expect(a.refused).toEqual([]);
  });

  it('reads the reply to a safety question when it was asked', () => {
    const raw = response(CALM, {}, { safety_answer: { yes: 0.1, no: 0.05, unclear: 0.85 } });
    const a = parseShadowResponse(raw, { followsSafetyQuestion: true });
    expect(a.choices.safety_answer).toEqual({
      choice: 'unclear',
      probabilities: { yes: 0.1, no: 0.05, unclear: 0.85 },
    });
  });

  it('a safety answer that was asked for and is missing is a broken answer, not "no"', () => {
    expect(() => parseShadowResponse(response(CALM), { followsSafetyQuestion: true })).toThrow(ShadowAnswerError);
  });

  it('a safety answer nobody asked for is ignored', () => {
    const raw = response(CALM, {}, { safety_answer: { yes: 0.9, no: 0.05, unclear: 0.05 } });
    expect(parseShadowResponse(raw).choices).not.toHaveProperty('safety_answer');
  });

  it('a refused choice is reported and left out; it is never read as "none" or "no"', () => {
    const raw = response(CALM, {}, { risk_subject: 'refuse', safety_answer: 'refuse' });
    const a = parseShadowResponse(raw, { followsSafetyQuestion: true });
    expect(a.refused).toEqual(['risk_subject', 'safety_answer']);
    expect(a.choices).toEqual({});
    expect(a.severity).toBe('none');
  });

  it('a choice answered with the wrong type throws', () => {
    const raw = response(CALM);
    raw.answers[raw.answers.length - 1] = { type: 'predicate', name: 'risk_subject', probability: 0.5 };
    expect(() => parseShadowResponse(raw)).toThrow(ShadowAnswerError);
  });
});
