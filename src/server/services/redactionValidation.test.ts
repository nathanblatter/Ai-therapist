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
