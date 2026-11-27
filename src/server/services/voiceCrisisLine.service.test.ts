import { beforeEach, describe, expect, it } from 'vitest';
import { _resetRecentTurnsForTests, rememberTurn } from '../utils/recentTurns.js';
import {
  VOICE_CRISIS_LINE_GUIDANCE,
  VOICE_CRISIS_LINE_MAX_REQUESTS,
  _resetVoiceCrisisLineForTests,
  clearVoiceCrisisLine,
  markVoiceCrisisLineRequested,
  namesCrisisLine,
  noteVoiceCrisisLineSpoken,
  VOICE_CRISIS_LINE_SAME_TURN_MS,
  voiceCrisisLineDue,
  voiceCrisisLineJustRequested,
} from './voiceCrisisLine.service.js';
import { fitsWithHeadsUp, steeringGuidance } from './crisisIntervention.service.js';

const S = 'sess-crisis-line-1';

beforeEach(() => {
  _resetVoiceCrisisLineForTests();
  _resetRecentTurnsForTests();
});

describe('VOICE_CRISIS_LINE_GUIDANCE', () => {
  it('names 988, asks for it once, and tells the model not to repeat it', () => {
    expect(VOICE_CRISIS_LINE_GUIDANCE).toContain('call or text 988');
    expect(VOICE_CRISIS_LINE_GUIDANCE).toMatch(/once only in this conversation/);
    expect(VOICE_CRISIS_LINE_GUIDANCE).toMatch(/Do not repeat it in later replies/);
  });
});

describe('namesCrisisLine', () => {
  it('reads the number the ways a voice transcript writes it', () => {
    expect(namesCrisisLine('You can call or text 988 any time.')).toBe(true);
    expect(namesCrisisLine('you can call 9-8-8')).toBe(true);
    expect(namesCrisisLine('call or text 9 8 8, day or night')).toBe(true);
    expect(namesCrisisLine('Call or text nine eight eight.')).toBe(true);
    expect(namesCrisisLine('Nine-eight-eight is there any time')).toBe(true);
  });

  it('is not set off by other numbers or by nothing', () => {
    expect(namesCrisisLine("I'm here with you. Are you having thoughts of suicide?")).toBe(false);
    expect(namesCrisisLine('That was in 1988.')).toBe(false);
    expect(namesCrisisLine('about 9880 steps')).toBe(false);
    expect(namesCrisisLine('')).toBe(false);
    expect(namesCrisisLine(null)).toBe(false);
  });
});

describe('voiceCrisisLineDue', () => {
  it('is due on the first medium steer of a session', () => {
    expect(voiceCrisisLineDue(S)).toBe(true);
  });

  it('is not due again once the assistant has said the number after the request', () => {
    markVoiceCrisisLineRequested(S, 1_000);
    rememberTurn(S, 'assistant', 'That sounds heavy. You can call or text 988 any time.', { at: 5_000 });
    expect(voiceCrisisLineDue(S, 200_000)).toBe(false);
  });

  it('is due once more when the reply after the request did not name it', () => {
    markVoiceCrisisLineRequested(S, 1_000);
    rememberTurn(S, 'assistant', 'That sounds heavy. Are you having thoughts of suicide?', { at: 5_000 });
    expect(voiceCrisisLineDue(S, 200_000)).toBe(true);
  });

  it('does not count the number said before the request (the opening disclosure names it)', () => {
    rememberTurn(S, 'assistant', "I'm an AI. In a crisis, call or text 988.", { at: 500 });
    markVoiceCrisisLineRequested(S, 1_000);
    expect(voiceCrisisLineDue(S, 200_000)).toBe(true);
  });

  it('is never requested more than the cap, said or not', () => {
    for (let i = 0; i < VOICE_CRISIS_LINE_MAX_REQUESTS; i++) markVoiceCrisisLineRequested(S, 1_000 + i);
    expect(voiceCrisisLineDue(S, 900_000)).toBe(false);
  });

  it('keeps sessions apart, and a cleared session starts again', () => {
    markVoiceCrisisLineRequested(S, 1_000);
    rememberTurn(S, 'assistant', 'You can call or text 988.', { at: 2_000 });
    expect(voiceCrisisLineDue('another-session')).toBe(true);
    clearVoiceCrisisLine(S);
    expect(voiceCrisisLineDue(S)).toBe(true);
  });
});

describe('voiceCrisisLineJustRequested', () => {
  it('is true only moments after a request for that session', () => {
    expect(voiceCrisisLineJustRequested(S, 1_000)).toBe(false);
    markVoiceCrisisLineRequested(S, 1_000);
    expect(voiceCrisisLineJustRequested(S, 1_050)).toBe(true);
    expect(voiceCrisisLineJustRequested('another-session', 1_050)).toBe(false);
    expect(voiceCrisisLineJustRequested(S, 1_000 + VOICE_CRISIS_LINE_SAME_TURN_MS + 1)).toBe(false);
  });
});

// Review of PR #150: "was it said" used to be read only from the recent-turns
// window, which holds the last few turns. In a long session the turn that
// named the line falls out of it and the line was asked for a second time.
describe('noteVoiceCrisisLineSpoken', () => {
  it('remembers that the line was said for the rest of the session, however many turns follow', () => {
    markVoiceCrisisLineRequested(S, 1_000);
    noteVoiceCrisisLineSpoken(S, 'That sounds heavy. You can call or text 988, any time.');
    // The turn itself is long gone from the recent-turns window.
    for (let i = 0; i < 40; i++) rememberTurn(S, i % 2 ? 'assistant' : 'user', `turn ${i}`, { at: 10_000 + i });
    expect(voiceCrisisLineDue(S, 400_000)).toBe(false);
  });

  it('does not count the line said before any request, or a turn that does not name it', () => {
    noteVoiceCrisisLineSpoken(S, 'If you are in crisis you can call 988.');
    expect(voiceCrisisLineDue(S, 500)).toBe(true);
    markVoiceCrisisLineRequested(S, 1_000);
    noteVoiceCrisisLineSpoken(S, 'That sounds heavy. Are you having thoughts of suicide?');
    expect(voiceCrisisLineDue(S, 200_000)).toBe(true);
  });
});

// The medium steer with the 988 sentence and the voice heads-up is sent as
// one message with 2 characters to spare. If any of the three grows, this
// fails here instead of the steer being split or re-sent at run time.
describe('length', () => {
  it('the medium steer with the crisis-line sentence still fits together with the heads-up, at every score', () => {
    for (let score = 0; score <= 100; score++) {
      expect(fitsWithHeadsUp(`${steeringGuidance(score, 'medium')} ${VOICE_CRISIS_LINE_GUIDANCE}`)).toBe(true);
    }
  });
});
