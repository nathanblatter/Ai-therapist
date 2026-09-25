import { describe, it, expect } from 'vitest';

// The refusal-loop detector (ai-therapist-255). Pure logic: what counts as a
// refusal, when the streak escalates, and what a bad stored config falls back
// to. The delivery side lives in grokVoiceManager.service.test.ts.

import {
  GROK_DEFAULT_REFUSAL_GUARD,
  GrokRefusalDetector,
  buildGrokRefusalRecoveryLine,
  isNearIdentical,
  normalizeRefusalText,
  resolveGrokRefusalGuard,
} from './grokRefusalGuard.js';

/** The exact string xAI returned five times in the stage session. */
const CANNED = "I can't help with that request.";

describe('normalizeRefusalText', () => {
  it('folds case, curly apostrophes and punctuation onto one comparison key', () => {
    expect(normalizeRefusalText(CANNED)).toBe('i cant help with that request');
    expect(normalizeRefusalText('I CAN’T help with that request!!')).toBe('i cant help with that request');
    expect(normalizeRefusalText('  I can not  help.  ')).toBe('i can not help');
  });

  it('returns an empty key for text with nothing in it', () => {
    expect(normalizeRefusalText('  ...  ')).toBe('');
  });
});

describe('isNearIdentical', () => {
  it('matches identical keys and long prefixes, not short shared openers', () => {
    expect(isNearIdentical('i cant help with that request', 'i cant help with that request')).toBe(true);
    expect(isNearIdentical('i cant help with that request', 'i cant help with that request right now')).toBe(true);
    expect(isNearIdentical('i hear you', 'i hear you say that work has been hard')).toBe(false);
    expect(isNearIdentical('', 'i cant help with that')).toBe(false);
  });
});

describe('GrokRefusalDetector', () => {
  it('flags the canned moderation line as a refusal', () => {
    const d = new GrokRefusalDetector();
    expect(d.isRefusal(CANNED)).toBe(true);
    expect(d.isRefusal("I'm not able to help with that.")).toBe(true);
  });

  it('does not flag a long reply that happens to contain a boundary sentence', () => {
    const d = new GrokRefusalDetector();
    const clinical =
      "I can't help with that specific medical question, and I want to say why: I am not a clinician and " +
      'diagnosing anything is outside what I can do safely. What I can do is stay with how this has been ' +
      'landing for you. You mentioned the headaches have been worse in the evenings. How has that been?';
    expect(clinical.length).toBeGreaterThan(GROK_DEFAULT_REFUSAL_GUARD.maxChars);
    expect(d.isRefusal(clinical)).toBe(false);
    expect(d.observe(clinical)).toBe('none');
  });

  it('escalates steer at the first threshold and recovery at the second', () => {
    const d = new GrokRefusalDetector();
    expect(d.observe(CANNED)).toBe('none');
    expect(d.streak).toBe(1);
    expect(d.observe(CANNED)).toBe('steer');
    expect(d.observe(CANNED)).toBe('none');
    expect(d.observe(CANNED)).toBe('recover');
    expect(d.streak).toBe(4);
  });

  it('keeps recovering while the refusals keep coming', () => {
    const d = new GrokRefusalDetector();
    for (let i = 0; i < 3; i++) d.observe(CANNED);
    expect(d.observe(CANNED)).toBe('recover');
    expect(d.observe(CANNED)).toBe('recover');
  });

  it('resets the streak on a real reply, so one boundary is not a loop', () => {
    const d = new GrokRefusalDetector();
    d.observe(CANNED);
    expect(d.observe('That sounds exhausting. What has today been like?')).toBe('none');
    expect(d.streak).toBe(0);
    expect(d.observe(CANNED)).toBe('none');
    expect(d.observe(CANNED)).toBe('steer');
  });

  it('catches a repeated short line that matches no configured pattern', () => {
    const d = new GrokRefusalDetector();
    const unknown = 'That is not something I am going to get into here.';
    expect(d.observe(unknown)).toBe('none');
    expect(d.observe(unknown)).toBe('none');   // streak 1: the repeat itself
    expect(d.observe(unknown)).toBe('steer');  // streak 2
  });

  it('does nothing at all when the guard is disabled', () => {
    const d = new GrokRefusalDetector(resolveGrokRefusalGuard({ enabled: false }));
    for (let i = 0; i < 8; i++) expect(d.observe(CANNED)).toBe('none');
    expect(d.streak).toBe(0);
  });

  it('honours configured thresholds and patterns', () => {
    const d = new GrokRefusalDetector(resolveGrokRefusalGuard({
      patterns: ['no puedo ayudarte con eso'], steerAfter: 1, recoverAfter: 2,
    }));
    expect(d.observe(CANNED)).toBe('none');          // English default list replaced
    expect(d.observe('No puedo ayudarte con eso.')).toBe('steer');
    expect(d.observe('No puedo ayudarte con eso.')).toBe('recover');
  });

  it('reset() clears the streak and the repeat memory', () => {
    const d = new GrokRefusalDetector();
    d.observe(CANNED);
    d.observe(CANNED);
    d.reset();
    expect(d.streak).toBe(0);
    expect(d.observe(CANNED)).toBe('none');
  });
});

describe('resolveGrokRefusalGuard', () => {
  it('defaults an absent or unusable config', () => {
    expect(resolveGrokRefusalGuard(undefined)).toEqual(GROK_DEFAULT_REFUSAL_GUARD);
    expect(resolveGrokRefusalGuard('nonsense')).toEqual(GROK_DEFAULT_REFUSAL_GUARD);
    expect(resolveGrokRefusalGuard({ patterns: [], maxChars: 'x', steerAfter: null })).toEqual(GROK_DEFAULT_REFUSAL_GUARD);
  });

  it('normalizes stored patterns so admins can type them naturally', () => {
    expect(resolveGrokRefusalGuard({ patterns: ["I CAN'T help with that request", '  ', 7] }).patterns)
      .toEqual(['i cant help with that request']);
  });

  it('clamps thresholds and keeps recovery strictly after the steer', () => {
    expect(resolveGrokRefusalGuard({ steerAfter: 0, recoverAfter: 0 })).toMatchObject({ steerAfter: 1, recoverAfter: 2 });
    expect(resolveGrokRefusalGuard({ steerAfter: 3, recoverAfter: 3 })).toMatchObject({ steerAfter: 3, recoverAfter: 4 });
    expect(resolveGrokRefusalGuard({ steerAfter: 999, maxChars: 5 })).toMatchObject({ steerAfter: 20, maxChars: 20 });
  });
});

describe('buildGrokRefusalRecoveryLine', () => {
  it('uses the configured crisis phrase and falls back to 988', () => {
    expect(buildGrokRefusalRecoveryLine('call the campus line at 555-0100')).toContain('call the campus line at 555-0100');
    expect(buildGrokRefusalRecoveryLine(null)).toContain('988');
  });

  it('tells the participant it is not their fault and how to leave', () => {
    const line = buildGrokRefusalRecoveryLine(null);
    expect(line).toContain('not with anything you said');
    expect(line).toContain('end the session');
    // Project convention: no emojis in anything sent to a participant.
    expect(line).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
