// Offline checks for the three label sets added for the Decisions API
// evaluation (docs/decisions-crisis-classifiers-2026-11-26.md) and for the
// evaluation's own counting. No network, no DB.
import { describe, expect, it } from 'vitest';
import { DETECTOR_LANGUAGE_FILE, RISK_SUBJECT_FILE, SAFETY_ANSWER_FILE, loadDetectorGoldens } from './load.js';
import { derivedSubject, summarize, type EvalAnswer, type EvalRow } from './decisionsCrisisEval.js';
import { asksSafetyQuestion } from '../../server/services/crisisDetection.service.js';

const detector = loadDetectorGoldens();
const answers = loadDetectorGoldens(SAFETY_ANSWER_FILE);
const subjects = loadDetectorGoldens(RISK_SUBJECT_FILE);
const languages = loadDetectorGoldens(DETECTOR_LANGUAGE_FILE);

describe('the label sets', () => {
  it('are valid detector rows with ids of their own', () => {
    expect([...answers.errors, ...subjects.errors, ...languages.errors]).toEqual([]);
    const ids = [...detector.rows, ...answers.rows, ...subjects.rows, ...languages.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('safety answers: at least 30, each labelled, each the reply to a question the detector recognises', () => {
    expect(answers.rows.length).toBeGreaterThanOrEqual(30);
    for (const row of answers.rows) {
      expect(row.expected.answer, row.id).toBeDefined();
      const question = row.history[row.history.length - 1];
      expect(question?.role, row.id).toBe('assistant');
      expect(asksSafetyQuestion(question.text), row.id).toBe(true);
    }
    for (const answer of ['yes', 'no', 'unclear']) {
      expect(answers.rows.filter((r) => r.expected.answer === answer).length, answer).toBeGreaterThanOrEqual(10);
    }
  });

  it('a "yes" is never labelled below moderate and a "no" is always labelled none', () => {
    for (const row of answers.rows) {
      if (row.expected.answer === 'yes') expect(['moderate', 'high'], row.id).toContain(row.expected.band);
      if (row.expected.answer === 'no') expect(row.expected.band, row.id).toBe('none');
    }
  });

  it('risk subjects: at least 30, each labelled, every subject represented', () => {
    expect(subjects.rows.length).toBeGreaterThanOrEqual(30);
    for (const row of subjects.rows) expect(row.expected.subject, row.id).toBeDefined();
    for (const subject of ['own', 'third_party', 'harm_to_others', 'none']) {
      expect(subjects.rows.filter((r) => r.expected.subject === subject).length, subject).toBeGreaterThanOrEqual(8);
    }
  });

  it('language rows: every row names its language, with English controls', () => {
    for (const row of languages.rows) expect(row.language, row.id).toBeDefined();
    expect(languages.rows.filter((r) => r.language === 'en').length).toBeGreaterThanOrEqual(3);
    expect(languages.rows.filter((r) => r.language === 'es-en').length).toBeGreaterThanOrEqual(8);
  });
});

describe('derivedSubject', () => {
  it('reads a subject off a detector row from its category and band, and none for the low band', () => {
    expect(derivedSubject({ category: 'explicit-intent', expected: { band: 'high', page: 'yes' } })).toBe('own');
    expect(derivedSubject({ category: 'bystander-report', expected: { band: 'high', page: 'yes' } })).toBe(
      'third_party',
    );
    expect(derivedSubject({ category: 'bystander-report', expected: { band: 'none', page: 'no' } })).toBe('none');
    expect(derivedSubject({ category: 'harm-to-others', expected: { band: 'low', page: 'no' } })).toBe(
      'harm_to_others',
    );
    expect(derivedSubject({ category: 'distress-without-ideation', expected: { band: 'low', page: 'no' } })).toBeNull();
  });

  it("a row's own subject label wins", () => {
    expect(
      derivedSubject({ category: 'harm-to-others', expected: { band: 'high', page: 'yes', subject: 'own' } }),
    ).toBe('own');
  });
});

describe('summarize', () => {
  const answer = (value: string | null, extra: Partial<EvalAnswer> = {}): EvalAnswer => ({
    value,
    probabilities: value ? { [value]: 0.9 } : null,
    refused: false,
    error: null,
    latencyMs: 100,
    tokensIn: 500,
    ...extra,
  });
  const row = (id: string, expected: string | null, given: EvalAnswer[]): EvalRow => ({
    task: 'subject',
    file: 'risk-subject.jsonl',
    id,
    input: 'text',
    category: 'explicit-intent',
    language: 'en',
    expected,
    expectedBand: 'high',
    answers: given,
  });

  it('counts a refusal and an error as no answer, never as agreement', () => {
    const s = summarize([
      row('a', 'own', [answer('own'), answer('own')]),
      row('b', 'own', [answer(null, { refused: true }), answer(null, { refused: true })]),
      row('c', 'none', [answer(null, { error: 'http_503' })]),
      row('d', 'third_party', [answer('own'), answer('third_party')]),
      row('e', null, [answer('own')]),
    ]);
    expect(s).toMatchObject({ rows: 5, labelled: 4, correct: 1, refusedCalls: 2, refusedIds: ['b'], erroredCalls: 1 });
    expect(s.unstable).toEqual(['d']);
    expect(s.confusion.own).toEqual({ own: 1, 'none given': 1 });
    expect(s.confusion.none).toEqual({ 'none given': 1 });
    expect(s.wrong.map((w) => w.id)).toEqual(['b', 'c', 'd']);
  });
});
