// Redaction output validation (ai-therapist-382). The refusal shapes below are
// recorded model boilerplate: the opening "I’m really" (curly apostrophe) is
// the one the harness logged 142 times as `Unexpected token 'I', "I’m
// really"... is not valid JSON`; the rest are the standard gpt-5 refusal and
// support-reply forms. All participant-like inputs are synthetic.
import { describe, it, expect } from 'vitest';
import {
  PLACEHOLDER_SPAN,
  countPlaceholders,
  looksLikeRefusal,
  mentionsCrisisResource,
  rejectionError,
  validateRedaction,
  wordTokens,
} from './redactionValidation.js';

const CRISIS_INPUT = 'I have been saving my pills and I think tonight is the night. Nobody would even notice.';

export const RECORDED_REFUSALS = [
  'I’m really sorry you’re feeling like this. You don’t have to go through this alone. If you are in immediate danger, call or text 988 (Suicide & Crisis Lifeline) right now.',
  "I'm really sorry you're going through this, but I can't help with that request.",
  'I can’t help with that.',
  "I'm sorry, but I can't assist with that.",
  "I'm unable to process this text.",
  'It sounds like you are in a lot of pain right now. Please reach out to someone you trust or a crisis line.',
];

describe('validateRedaction: accepts real redactions', () => {
  it('accepts an unchanged message (no identifiers)', () => {
    expect(validateRedaction(CRISIS_INPUT, CRISIS_INPUT)).toEqual({ ok: true });
  });

  it('accepts placeholders that replace identifiers', () => {
    const input = 'My name is John Smith and I live at 412 North Elm Street in Provo, my number is 801-555-0199.';
    const output =
      'My name is [REDACTED: NAME] and I live at [REDACTED: ADDRESS] in [REDACTED: LOCATION], my number is [REDACTED: TELEPHONE NUMBER].';
    expect(validateRedaction(input, output)).toEqual({ ok: true });
  });

  it('accepts a quoted answer (the prompt examples wrap output in quotes)', () => {
    expect(validateRedaction('Call me Sam', '"Call me [REDACTED: NAME]"')).toEqual({ ok: true });
  });

  it('accepts the second pass, whose input already carries placeholders', () => {
    const first = 'I told [REDACTED: NAME] about it on [REDACTED: DATE].';
    expect(validateRedaction(first, first)).toEqual({ ok: true });
  });

  it('accepts curly versus straight apostrophes', () => {
    expect(validateRedaction("I can't sleep", 'I can’t sleep')).toEqual({ ok: true });
  });

  it('accepts an assistant turn that itself opens "I am sorry" and names 988', () => {
    const turn = "I'm really sorry you're carrying that. If you're in danger right now, you can call or text 988.";
    expect(validateRedaction(turn, turn)).toEqual({ ok: true });
  });

  it('accepts empty in, empty out', () => {
    expect(validateRedaction('', '')).toEqual({ ok: true });
    expect(validateRedaction('   ', '')).toEqual({ ok: true });
  });

  it('allows a placeholder to stand in for up to PLACEHOLDER_SPAN words', () => {
    const span = Array.from({ length: PLACEHOLDER_SPAN }, (_, k) => `w${k}`).join(' ');
    expect(validateRedaction(`I work at ${span} downtown`, 'I work at [REDACTED: EMPLOYER] downtown')).toEqual({
      ok: true,
    });
  });
});

describe('validateRedaction: rejects what is not a redaction', () => {
  it.each(RECORDED_REFUSALS)('rejects a recorded refusal/reply for crisis input: %s', (refusal) => {
    const v = validateRedaction(CRISIS_INPUT, refusal);
    expect(v.ok).toBe(false);
  });

  it('names refusal as the reason for a refusal opening', () => {
    expect(validateRedaction(CRISIS_INPUT, RECORDED_REFUSALS[0]).reason).toBe('refusal');
  });

  it('rejects an added crisis resource even when the rest is the message', () => {
    const v = validateRedaction(CRISIS_INPUT, `${CRISIS_INPUT} Please call 988.`);
    expect(v).toMatchObject({ ok: false, reason: 'added_crisis_resource' });
  });

  it('rejects a reply that does not open like a refusal (words not in the input)', () => {
    const v = validateRedaction(
      CRISIS_INPUT,
      'It sounds like you are in a lot of pain right now. Please talk to someone.',
    );
    expect(v).toMatchObject({ ok: false, reason: 'words_not_in_input' });
  });

  it('rejects a fragment: words dropped with no placeholder to explain them', () => {
    const v = validateRedaction(CRISIS_INPUT, 'I have been saving my pills.');
    expect(v).toMatchObject({ ok: false, reason: 'words_missing' });
  });

  it('rejects a placeholder that swallows more than PLACEHOLDER_SPAN words', () => {
    const span = Array.from({ length: PLACEHOLDER_SPAN + 3 }, (_, k) => `w${k}`).join(' ');
    const v = validateRedaction(`I work at ${span} downtown`, 'I work at [REDACTED: EMPLOYER] downtown');
    expect(v).toMatchObject({ ok: false, reason: 'words_missing' });
  });

  it('second pass: placeholders already in the input do not excuse newly dropped words', () => {
    const words = Array.from({ length: 20 }, (_, k) => `w${k + 1}`).join(' ');
    const first = `[REDACTED: NAME] [REDACTED: NAME] [REDACTED: NAME] ${words}`;
    const v = validateRedaction(first, '[REDACTED: NAME] [REDACTED: NAME] [REDACTED: NAME] w1 w2');
    expect(v).toMatchObject({ ok: false, reason: 'words_missing' });
  });

  it('rejects empty output for non-empty input', () => {
    expect(validateRedaction(CRISIS_INPUT, '  ')).toMatchObject({ ok: false, reason: 'empty_output' });
  });

  it('rejects prose for empty input', () => {
    expect(validateRedaction('', 'There is no text to redact.')).toMatchObject({
      ok: false,
      reason: 'text_for_empty_input',
    });
  });

  it('rejects a non-string', () => {
    expect(validateRedaction('hi', null)).toMatchObject({ ok: false, reason: 'not_text' });
    expect(validateRedaction('hi', 42)).toMatchObject({ ok: false, reason: 'not_text' });
  });

  it('rejects a whole message replaced by one placeholder', () => {
    expect(validateRedaction(CRISIS_INPUT, '[REDACTED: NAME]').ok).toBe(false);
  });

  it('rejects a refusal for a short greeting', () => {
    expect(validateRedaction('hi', "I'm sorry, I can't help with that.").ok).toBe(false);
  });
});

describe('helpers', () => {
  it('wordTokens drops placeholders and lower-cases', () => {
    expect(wordTokens('Hi [REDACTED: NAME], it’s ME')).toEqual(['hi', 'it', 's', 'me']);
  });

  it('countPlaceholders counts each placeholder', () => {
    expect(countPlaceholders('[REDACTED: NAME] and [REDACTED] and [redacted: date]')).toBe(3);
  });

  it('looksLikeRefusal and mentionsCrisisResource', () => {
    expect(looksLikeRefusal('  "I’m really sorry')).toBe(true);
    expect(looksLikeRefusal('I really like my sister')).toBe(false);
    expect(mentionsCrisisResource('text 988')).toBe(true);
    expect(mentionsCrisisResource('I scored 9880 points')).toBe(false);
  });

  it('rejectionError carries a reason code and counts, never text', () => {
    const msg = rejectionError(validateRedaction(CRISIS_INPUT, 'I have been saving my pills.'));
    expect(msg).toMatch(/^Redaction output rejected: words_missing \(\d+\/\d+ missing, 0 placeholders\)$/);
    expect(msg).not.toContain('pills');
  });
});

describe('threshold boundaries (review of PR #102: each pinned on both sides)', () => {
  const ws = (n: number, p = 'w') => Array.from({ length: n }, (_, k) => `${p}${k + 1}`);

  it('new words: at least 2 are allowed even in a short message, 3 are not', () => {
    expect(validateRedaction('hello there', 'hello there n1 n2').ok).toBe(true);
    expect(validateRedaction('hello there', 'hello there n1 n2 n3')).toMatchObject({ reason: 'words_not_in_input' });
  });

  it('new words: 10% of the output words (floor) in a long message', () => {
    const base = ws(30).join(' ');
    // 33 output words -> floor(3.3) = 3 allowed; 34 -> floor(3.4) = 3
    expect(validateRedaction(base, `${base} ${ws(3, 'n').join(' ')}`).ok).toBe(true);
    expect(validateRedaction(base, `${base} ${ws(4, 'n').join(' ')}`)).toMatchObject({ reason: 'words_not_in_input' });
  });

  it('dropped words without a placeholder: at least 1, else 5% of the input (floor)', () => {
    const five = ws(5);
    expect(validateRedaction(five.join(' '), five.slice(1).join(' ')).ok).toBe(true);
    expect(validateRedaction(five.join(' '), five.slice(2).join(' '))).toMatchObject({ reason: 'words_missing' });
    const forty = ws(40);
    expect(validateRedaction(forty.join(' '), forty.slice(2).join(' ')).ok).toBe(true);
    expect(validateRedaction(forty.join(' '), forty.slice(3).join(' '))).toMatchObject({ reason: 'words_missing' });
  });

  it('a placeholder covers exactly PLACEHOLDER_SPAN words plus the 1-word slack, no more', () => {
    const at = (n: number) => validateRedaction(`a ${ws(n).join(' ')} b`, 'a [REDACTED: X] b');
    expect(at(PLACEHOLDER_SPAN + 1).ok).toBe(true);
    expect(at(PLACEHOLDER_SPAN + 2)).toMatchObject({ reason: 'words_missing' });
  });
});

describe('very short messages (follow-up to ai-therapist-382)', () => {
  // Before these rules the fixed floors (2 new words, 1 dropped word, 10
  // words per placeholder) covered a whole short message, so each "rejects"
  // case below was stored as the redaction.
  it.each([
    ['help', 'You matter.'],
    ['die', 'Stay safe'],
    ['yes', 'Thank you'],
    ['ok', 'Understood.'],
    ['no', 'Okay.'],
    ['...', 'Thank you'],
    ['…?', 'Take care'],
    ['John', 'Hello [REDACTED: NAME]'],
    ['555-123-4567', 'Noted [REDACTED: TELEPHONE NUMBER]'],
  ])('rejects %j -> %j: no word of the output is from the input', (input, output) => {
    expect(validateRedaction(input, output)).toMatchObject({ ok: false, reason: 'words_not_in_input' });
  });

  it.each([
    ['I want to die', '[REDACTED]'],
    ['I want to kill myself tonight', '[REDACTED: OTHER]'],
    ['i cant do this', '[REDACTED]'],
    ["I'm done", '"[REDACTED]"'],
    ['what is the point', '[REDACTED: OTHER].'],
    ['I am [REDACTED: NAME]', '[REDACTED: NAME]'],
    ['My name is John Smith', '[REDACTED: NAME]'],
  ])('rejects %j -> %j: a sentence replaced whole by a placeholder', (input, output) => {
    expect(validateRedaction(input, output)).toMatchObject({ ok: false, reason: 'words_missing' });
  });

  it.each([
    // unchanged, one to three words
    ['help', 'help'],
    ['die', 'die'],
    ['ok', 'OK.'],
    ['yes', '"yes"'],
    ['I want to die', 'I want to die'],
    ['no', 'no'],
    // same letters, other punctuation or spacing
    ['Im', 'I’m'],
    ['im fine', "I'm fine"],
    ['cant', "can't"],
    // nothing but an identifier, replaced whole
    ['John', '[REDACTED: NAME]'],
    ['John Smith', '[REDACTED: NAME]'],
    ['555-123-4567', '[REDACTED: TELEPHONE NUMBER]'],
    ['john.smith@example.com', '[REDACTED: EMAIL ADDRESS]'],
    ['12 Elm Street, Provo, UT 84601', '[REDACTED: ADDRESS]'],
    ['Portland, ME', '[REDACTED: LOCATION]'],
    ['10:45 AM', '[REDACTED: TIME]'],
    ['Jane Doe, DO', '[REDACTED: NAME]'],
    ['Will Smith', '[REDACTED: NAME]'],
    ['March 4', '[REDACTED: DATE]'],
    ['John Smith 555-123-4567', '[REDACTED: NAME] [REDACTED: TELEPHONE NUMBER]'],
    // heavy but legitimate: the sentence words survive
    ['hi im john', 'hi im [REDACTED: NAME]'],
    ["it's John", "it's [REDACTED: NAME]"],
    ['I am John Smith', 'I am [REDACTED: NAME]'],
    ['call me at 555-123-4567', 'call me at [REDACTED: TELEPHONE NUMBER]'],
    [
      'John Smith, 12 Elm St, Provo UT 84601, 555-123-4567, john@example.com',
      '[REDACTED: NAME], [REDACTED: ADDRESS], [REDACTED: TELEPHONE NUMBER], [REDACTED: EMAIL]',
    ],
    [
      'My sister Anna lives in Orem and was born 3/4/1990',
      'My sister [REDACTED: NAME] lives in [REDACTED: LOCATION] and was born [REDACTED: DATE]',
    ],
    // no words at all
    [':(', ':('],
    ['...', '...'],
    ['?', '?'],
    // second pass over a message that is already only a placeholder
    ['[REDACTED: NAME]', '[REDACTED: NAME]'],
    ['I am [REDACTED: NAME]', 'I am [REDACTED: NAME]'],
  ])('accepts %j -> %j', (input, output) => {
    expect(validateRedaction(input, output)).toEqual({ ok: true });
  });

  it('still allows two new words when at least one output word is from the input', () => {
    expect(validateRedaction('hello', 'hello n1 n2').ok).toBe(true);
    expect(validateRedaction('hello', 'n1 n2')).toMatchObject({ reason: 'words_not_in_input' });
  });

  it('the whole-message rule needs a sentence word: an identifier-only message of any length may be replaced', () => {
    expect(validateRedaction('Dr Maria Garcia Lopez, Provo', '[REDACTED: NAME], [REDACTED: LOCATION]').ok).toBe(true);
    expect(validateRedaction('she', '[REDACTED]')).toMatchObject({ reason: 'words_missing' });
  });

  it('the stored detail carries counts only', () => {
    expect(rejectionError(validateRedaction('help', 'You matter.'))).toBe(
      'Redaction output rejected: words_not_in_input (2/2, none from the input)',
    );
    expect(rejectionError(validateRedaction('I want to die', '[REDACTED]'))).toBe(
      'Redaction output rejected: words_missing (all 4 words removed)',
    );
  });
});

describe('URLs count as one word (review of PR #102)', () => {
  it('accepts a long URL with a query string redacted to one placeholder', () => {
    const input =
      'here is my profile https://www.facebook.com/profile.php?id=100012345678&ref=bookmarks&utm_source=share_link_v2 lol';
    expect(validateRedaction(input, 'here is my profile [REDACTED: URL] lol')).toEqual({ ok: true });
  });

  it('accepts a scheme-less URL with a path, and a URL kept verbatim', () => {
    const input = 'see instagram.com/p/C9xYzAbCdEf/?utm_source=ig_web_copy_link&igsh=MzRlODBiNWFlZA== ok';
    expect(validateRedaction(input, 'see [REDACTED: URL] ok')).toEqual({ ok: true });
    expect(validateRedaction(input, input)).toEqual({ ok: true });
  });

  it('tokenises a URL as a single word', () => {
    expect(wordTokens('a https://x.example.com/a/b/c?d=e&f=g b')).toHaveLength(3);
  });
});
