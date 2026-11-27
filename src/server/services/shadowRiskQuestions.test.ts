// The shadow risk scorer's wire shape: the request it builds and how it reads
// the answer, including the rule that a refused or broken answer is never a
// clean one.
import { describe, it, expect } from 'vitest';
import {
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

function response(
  severity: Answer,
  predicates: Partial<Record<string, number | 'refuse'>> = {},
): { model: string; answers: Answer[]; usage: Record<string, number> } {
  return {
    model: SHADOW_MODEL,
    answers: [
      severity,
      ...SHADOW_PREDICATE_NAMES.map((name): Answer => {
        const v = predicates[name] ?? 0.01;
        return v === 'refuse' ? { type: 'refusal', name } : { type: 'predicate', name, probability: v };
      }),
    ],
    usage: { input_tokens: 3200, output_tokens: 0 },
  };
}

describe('buildShadowBody', () => {
  it('asks one severity score on the four production bands and one predicate per distinction', () => {
    const body = buildShadowBody('I want to end my life.', []);
    expect(body.model).toBe('gpt-6-luna');
    expect(body).not.toHaveProperty('store');
    const [severity, ...predicates] = body.questions as unknown as Array<Record<string, unknown>>;
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
    ]);
    // Well inside the API's 400-question limit.
    expect(body.questions.length).toBe(9);
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
    expect(Object.keys(a.predicates)).toHaveLength(8);
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
