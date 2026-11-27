import { describe, it, expect } from 'vitest';
import { VOICE_SILENCE_EVENTS, nextVoiceNotice, voiceSilenceNotice } from './voiceSilenceNotice';

const S = 'sess-0123456789ab';

describe('voiceSilenceNotice', () => {
  it('needs a session id', () => {
    for (const event of VOICE_SILENCE_EVENTS) {
      expect(voiceSilenceNotice(event, undefined)).toBeNull();
      expect(voiceSilenceNotice(event, {})).toBeNull();
      expect(voiceSilenceNotice(event, { sessionId: 42 })).toBeNull();
    }
  });

  it('gives every event a message for its session', () => {
    for (const event of VOICE_SILENCE_EVENTS) {
      const n = voiceSilenceNotice(event, { sessionId: S, afterMs: 8000, attempt: 1, prompts: 2 });
      expect(n).toMatchObject({ sessionId: S, event });
      expect(n?.message).toContain('8 s');
    }
  });

  it('marks as persistent only the two states nothing more is being done about', () => {
    const persistent = VOICE_SILENCE_EVENTS.filter(
      (e) => voiceSilenceNotice(e, { sessionId: S, afterMs: 1 })?.persistent,
    );
    expect(persistent).toEqual(['live:opening-unspoken', 'live:steer-unresolved']);
  });

  it('says what the server did: re-sent, could not re-send, prompted, gave up', () => {
    expect(voiceSilenceNotice('live:opening-silent', { sessionId: S, afterMs: 4000, sent: true })?.message).toBe(
      'Voice session has not spoken its opening after 4 s. The opening was re-sent.',
    );
    expect(voiceSilenceNotice('live:opening-silent', { sessionId: S, afterMs: 4000, sent: false })?.message).toBe(
      'Voice session has not spoken its opening after 4 s, and the opening could not be re-sent.',
    );
    expect(voiceSilenceNotice('live:steer-silent', { sessionId: S, afterMs: 6400, attempt: 2 })?.message).toBe(
      'Voice assistant went quiet for 6 s after a safety steer. It was prompted to speak (attempt 2).',
    );
    expect(voiceSilenceNotice('live:steer-unresolved', { sessionId: S, afterMs: 30000, prompts: 2 })?.message).toBe(
      'Voice assistant has said nothing for 30 s after a safety steer (2 prompts to speak sent). The participant is hearing silence.',
    );
    expect(
      voiceSilenceNotice('live:steer-unresolved', { sessionId: S, afterMs: 30000, prompts: 1 })?.message,
    ).toContain('(1 prompt to speak sent)');
  });

  it('says when the assistant was asked to check in on a participant who went quiet', () => {
    expect(voiceSilenceNotice('live:quiet-check-in', { sessionId: S, afterMs: 20000, sent: true })?.message).toBe(
      'Participant has been quiet for 20 s after a safety question. The voice assistant was asked to check in.',
    );
    expect(voiceSilenceNotice('live:quiet-check-in', { sessionId: S, afterMs: 20000, sent: false })?.message).toBe(
      'Participant has been quiet for 20 s after a safety question, and the check-in could not be sent.',
    );
  });

  it('does not print a bad number', () => {
    const n = voiceSilenceNotice('live:steer-silent', { sessionId: S, afterMs: 'soon', attempt: -1 });
    expect(n?.message).toBe('Voice assistant went quiet for a while after a safety steer. It was prompted to speak.');
  });
});

describe('nextVoiceNotice', () => {
  const transient = voiceSilenceNotice('live:steer-silent', { sessionId: 'a', afterMs: 1000 });
  const persistent = voiceSilenceNotice('live:steer-unresolved', { sessionId: 'b', afterMs: 1000 });
  const persistent2 = voiceSilenceNotice('live:opening-unspoken', { sessionId: 'c', afterMs: 1000 });

  it('shows the first notice, and lets a newer one replace a transient one', () => {
    expect(nextVoiceNotice(null, transient)).toBe(transient);
    expect(nextVoiceNotice(transient, persistent)).toBe(persistent);
    expect(nextVoiceNotice(transient, transient)).toBe(transient);
  });

  it('never lets a transient notice hide a persistent one', () => {
    expect(nextVoiceNotice(persistent, transient)).toBe(persistent);
    expect(nextVoiceNotice(persistent, persistent2)).toBe(persistent2);
  });

  it('ignores an unusable broadcast', () => {
    expect(nextVoiceNotice(persistent, null)).toBe(persistent);
    expect(nextVoiceNotice(null, null)).toBeNull();
  });
});
