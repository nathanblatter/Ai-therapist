import { describe, it, expect } from 'vitest';
import {
  buildRecoverySpeakFirstNudge,
  recoveryCrisisLinePhrase,
  RECOVERY_INTERIM_SPOKEN_LINE,
} from './recoveryPrompt.js';

// Wording around a vendor cut of a voice session (ai-therapist-293). The two
// properties held here are the two the owner allowed the recovery wording to
// change for: the crisis line is named aloud, and nothing claims the call
// "dropped" (the study answers "no" to deception, Q-SYS2).
const DECEPTIVE = /connection (just )?dropped|technical (drop|problem|issue|thing|glitch)|lost (the )?connection/i;
// Words that describe the disclosure. The vendor's filter stops generated
// speech that names self-harm, so the lines the model is asked to SAY must not.
const SELF_HARM_WORDS = /suicid|self-harm|kill|hurt yourself|end(ing)? your life|die\b|lifeline/i;

function spokenPart(nudge: string): string {
  const m = /"([^"]+)"/.exec(nudge);
  if (!m) throw new Error('the nudge has no quoted line to say');
  return m[1];
}

describe('recoveryCrisisLinePhrase', () => {
  it('uses the configured contact', () => {
    expect(recoveryCrisisLinePhrase({ phone: '988', text: 'HOME to 741741', enabled: true })).toBe(
      'call or text 988 at any time, or text HOME to 741741',
    );
    expect(recoveryCrisisLinePhrase({ phone: '555-0100', text: 'HELP to 12345' })).toBe(
      'call or text 555-0100 at any time, or text HELP to 12345',
    );
  });

  it('never builds a line without a number: defaults stand in for a blank, missing or disabled contact', () => {
    const fallback = 'call or text 988 at any time, or text HOME to 741741';
    expect(recoveryCrisisLinePhrase(undefined)).toBe(fallback);
    expect(recoveryCrisisLinePhrase(null)).toBe(fallback);
    expect(recoveryCrisisLinePhrase({})).toBe(fallback);
    expect(recoveryCrisisLinePhrase({ phone: '  ', text: '' })).toBe(fallback);
    expect(recoveryCrisisLinePhrase({ phone: '555-0100', text: 'HELP to 12345', enabled: false })).toBe(fallback);
  });
});

describe('buildRecoverySpeakFirstNudge', () => {
  const nudge = buildRecoverySpeakFirstNudge({ phone: '988', text: 'HOME to 741741', enabled: true });

  it('tells the model to speak first, immediately', () => {
    expect(nudge).toMatch(/Speak first, immediately, before the participant says anything/);
  });

  it('has the model say the crisis line aloud in its first utterance', () => {
    const said = spokenPart(nudge);
    expect(said).toContain('988');
    expect(said).toContain('741741');
  });

  it('says what happened without calling it a dropped connection or a technical problem', () => {
    const said = spokenPart(nudge);
    expect(said).toMatch(/The call got cut off/);
    expect(said).toMatch(/not your fault/);
    expect(said).not.toMatch(DECEPTIVE);
    // ...and forbids the model from saying so in its own words.
    expect(nudge).toMatch(/Do not call it a dropped connection or a technical problem/);
  });

  it('asks for nothing that names the disclosure (the words most likely to be cut again)', () => {
    expect(spokenPart(nudge)).not.toMatch(SELF_HARM_WORDS);
    expect(nudge).toMatch(/do not repeat or ask about what was said before/);
  });

  it('stays inside the 1600-character cap on an instructions append', () => {
    expect(nudge.length).toBeLessThan(1600);
  });

  it('falls back to the national lines when no contact is configured', () => {
    const said = spokenPart(buildRecoverySpeakFirstNudge(undefined));
    expect(said).toContain('988');
    expect(said).toContain('HOME to 741741');
  });
});

describe('RECOVERY_INTERIM_SPOKEN_LINE', () => {
  it('is short, true, and leads with what happened', () => {
    expect(RECOVERY_INTERIM_SPOKEN_LINE.startsWith('The call was cut off.')).toBe(true);
    expect(RECOVERY_INTERIM_SPOKEN_LINE).toMatch(/not your fault/);
    expect(RECOVERY_INTERIM_SPOKEN_LINE).not.toMatch(DECEPTIVE);
    // A few seconds of speech at most: it is stopped when the new call connects.
    expect(RECOVERY_INTERIM_SPOKEN_LINE.split(/\s+/).length).toBeLessThanOrEqual(14);
  });
});
