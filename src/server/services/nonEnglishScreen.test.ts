// The deterministic non-English screen (ai-therapist-329): what wakes the
// assessor, what does not, and that it can never throw.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { detectNonEnglish } from './nonEnglishScreen.js';
import { detectCrisisKeywords } from './crisisDetection.service.js';
import { DETECTOR_LANGUAGE_FILE, GOLDENS_DIR, loadDetectorGoldens } from '../../redteam/goldens/load.js';

describe('detectNonEnglish', () => {
  it('a letter outside ASCII is a match (accents, and any other script)', () => {
    expect(detectNonEnglish('Añoranza, that is the word')).toEqual({ nonEnglish: true, signals: ['non_ascii_letter'] });
    expect(detectNonEnglish('死にたい').nonEnglish).toBe(true);
    expect(detectNonEnglish('я не хочу жить').nonEnglish).toBe(true);
    // The same letter typed as a base letter plus a combining accent.
    expect(detectNonEnglish('Ojalá').signals).toContain('non_ascii_letter');
  });

  // Review of PR #157: an accent in an English loanword or a common name said
  // nothing about language and cost an assessor read of an ordinary turn.
  it.each([
    'Zoë called',
    'I met José at the café to fix my résumé',
    'my fiancée made jalapeño poppers',
    'that is so cliché, I was naïve',
    'take 5 µg twice a day, 1º thing in the morning',
  ])('an accent only in an English loanword, a common name or a symbol is not a match: %s', (text) => {
    expect(detectNonEnglish(text).nonEnglish).toBe(false);
  });

  it('an accented word that is not on that short list still is, even beside one that is', () => {
    expect(detectNonEnglish('José me dijo adiós').nonEnglish).toBe(true);
    expect(detectNonEnglish('at the café I felt vacío').signals).toContain('non_ascii_letter');
  });

  it.each(['no le veo salida', 'me tome todo el frasco', 'pense en colgarme', 'I just want to acabar con todo'])(
    'Spanish typed without accents that the review found unrecognised is a match: %s',
    (text) => {
      expect(detectNonEnglish(text).nonEnglish).toBe(true);
    },
  );

  it('typographic quotes, dashes, digits and symbols are not letters', () => {
    expect(detectNonEnglish('I’m fine — really… 100% × 2 → ok').nonEnglish).toBe(false);
  });

  it('one crisis word is a match, with or without its accent, in any verb form', () => {
    for (const text of [
      'quiero matarme',
      'me quiero morir',
      'pienso en suicidarme',
      'tengo pensamientos suicidas',
      'me volvi a cortar',
      'eu quero morrer',
      'je veux mourir',
      'ich will sterben',
    ]) {
      expect(detectNonEnglish(text).signals, text).toContain('crisis_word');
    }
  });

  it("English's own forms of the shared stem are not crisis words", () => {
    for (const text of ['suicide', 'suicidal thoughts', 'two suicides', 'suicidality']) {
      expect(detectNonEnglish(text).nonEnglish, text).toBe(false);
    }
  });

  it('one word English does not have is a match, even inside an English sentence', () => {
    expect(detectNonEnglish('the weather is nice out but tengo un plan').signals).toEqual(['function_words']);
    expect(detectNonEnglish('Ich will nicht mehr leben.').nonEnglish).toBe(true);
    expect(detectNonEnglish('todos estarian mejor sin mi').nonEnglish).toBe(true);
  });

  it('short words English shares count only in threes', () => {
    expect(detectNonEnglish('We drove through Los Angeles and Las Vegas over break.').nonEnglish).toBe(false);
    expect(detectNonEnglish('see ya, yo').nonEnglish).toBe(false);
    expect(detectNonEnglish('no se, y ya').signals).toEqual(['function_words']);
  });

  it('ordinary English is not a match', () => {
    for (const text of [
      'I want to kill myself.',
      "I don't know. Maybe. I'm by myself tonight.",
      'kms',
      'idk tbh this sem has been rough, my ESA helps lol',
      'I had soy milk all week, Ella says hi',
      'How much caffeine is too much?',
    ]) {
      expect(detectNonEnglish(text), text).toEqual({ nonEnglish: false, signals: [] });
    }
  });

  it('never throws; nothing is English', () => {
    expect(detectNonEnglish('')).toEqual({ nonEnglish: false, signals: [] });
    expect(detectNonEnglish(null).nonEnglish).toBe(false);
    expect(detectNonEnglish(undefined).nonEnglish).toBe(false);
    expect(detectNonEnglish('   \n').nonEnglish).toBe(false);
    expect(() => detectNonEnglish('\ud800 broken surrogate')).not.toThrow();
  });
});

describe('the language goldens (evals/goldens/detector-language.jsonl)', () => {
  const { rows, errors } = loadDetectorGoldens(DETECTOR_LANGUAGE_FILE);

  it('are valid rows, at least 30 of them not English', () => {
    expect(errors).toEqual([]);
    expect(rows.filter((r) => r.language && r.language !== 'en').length).toBeGreaterThanOrEqual(30);
  });

  it('every non-English row that carries risk reaches the assessor: a keyword or the language screen', () => {
    const risky = rows.filter((r) => r.language !== 'en' && r.expected.band !== 'none');
    expect(risky.length).toBeGreaterThanOrEqual(25);
    const unseen = risky.filter(
      (r) => detectCrisisKeywords(r.input).keywordScore === 0 && !detectNonEnglish(r.input).nonEnglish,
    );
    expect(unseen.map((r) => r.id)).toEqual([]);
  });

  it('the English keyword screen alone sees almost none of them (the gap this closes)', () => {
    const risky = rows.filter((r) => r.language !== 'en' && r.expected.band !== 'none');
    const byKeyword = risky.filter((r) => detectCrisisKeywords(r.input).keywordScore > 0);
    // One row states the risk in English inside a Spanish sentence.
    expect(byKeyword.map((r) => r.id)).toEqual(['det-lang-28']);
  });

  it('English controls wake only for an accented letter', () => {
    const woken = rows.filter((r) => r.language === 'en' && detectNonEnglish(r.input).nonEnglish);
    for (const r of woken) expect(detectNonEnglish(r.input).signals, r.id).toEqual(['non_ascii_letter']);
  });
});

describe('the detector goldens (evals/goldens/detector.jsonl)', () => {
  it('none of their text is woken: the language wake cannot change how any of the 273 rows is scored', () => {
    const { rows } = loadDetectorGoldens();
    expect(rows.length).toBeGreaterThanOrEqual(273);
    const texts = rows.flatMap((r) => [
      r.input,
      ...r.history.filter((t) => t.role === 'user').map((t) => t.text),
      ...(r.checkin ? [r.checkin.topic ?? '', r.checkin.goal ?? ''] : []),
    ]);
    expect(texts.filter((t) => detectNonEnglish(t).nonEnglish)).toEqual([]);
  });
});

// 300 sentences written by another agent that was shown neither this screen
// nor its word lists (three batches; how the screen did on each batch while
// it was still blind is in docs/decisions-crisis-classifiers-2026-11-26.md).
// They are a regression fixture now, not a blind test.
describe('the holdout sentences (evals/goldens/language-holdout.jsonl)', () => {
  const holdout = fs
    .readFileSync(path.join(GOLDENS_DIR, 'language-holdout.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { id: string; language: string; kind: string; text: string });
  const seen = (text: string): boolean =>
    detectCrisisKeywords(text).keywordScore > 0 || detectNonEnglish(text).nonEnglish;

  it('has the three batches', () => {
    expect(holdout).toHaveLength(300);
    expect(holdout.filter((r) => r.kind === 'crisis' && r.language !== 'en')).toHaveLength(133);
  });

  it('every Spanish, Portuguese or code-switched crisis sentence reaches the assessor', () => {
    const crisis = holdout.filter((r) => r.kind === 'crisis');
    expect(crisis.filter((r) => !seen(r.text)).map((r) => `${r.id}: ${r.text}`)).toEqual([]);
  });

  it('the English keyword screen alone would have sent fewer than one in five of them', () => {
    const crisis = holdout.filter((r) => r.kind === 'crisis');
    const byKeyword = crisis.filter((r) => detectCrisisKeywords(r.text).keywordScore > 0);
    expect(byKeyword.length / crisis.length).toBeLessThan(0.2);
  });

  it('wakes few English sentences, and only ones that borrow a word or a name', () => {
    const english = holdout.filter((r) => r.language === 'en');
    const woken = english.filter((r) => detectNonEnglish(r.text).nonEnglish);
    expect(english).toHaveLength(95);
    expect(woken.length).toBeLessThanOrEqual(8);
  });
});
