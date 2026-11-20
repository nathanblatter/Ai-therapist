// The voice eval's "opening spoken in time" assertion (ai-therapist-315).
import { describe, it, expect } from 'vitest';
import { openingSpokenAssertion, OPENING_SPOKEN_ID } from './openingSpoken.js';
import { LIVE_OPENING_UNSPOKEN_MS } from '../../shared/liveOpeningWatch.js';

const REQ = 1_000_000;
const timing = (o: Partial<Parameters<typeof openingSpokenAssertion>[0]> = {}) => ({
  openingRequestedAt: REQ,
  firstOpeningAudioAt: 0,
  firstOpeningDeltaAt: 0,
  firstUserDeltaAt: 0,
  ...o,
});

describe('openingSpokenAssertion', () => {
  it('passes a prompt start and reports both timings', () => {
    const r = openingSpokenAssertion(timing({ firstOpeningAudioAt: REQ + 900, firstOpeningDeltaAt: REQ + 1_400 }));
    expect(r).toMatchObject({ id: OPENING_SPOKEN_ID, passed: true, gating: true });
    expect(r.detail).toContain('first assistant audio 900 ms, first transcript 1400 ms');
  });

  it('fails, gating, when the opening is never spoken', () => {
    const r = openingSpokenAssertion(timing());
    expect(r).toMatchObject({ passed: false, gating: true });
    expect(r.detail).toMatch(/never spoken/);
  });

  it('fails past the bound and passes at it', () => {
    expect(openingSpokenAssertion(timing({ firstOpeningAudioAt: REQ + LIVE_OPENING_UNSPOKEN_MS })).passed).toBe(true);
    expect(openingSpokenAssertion(timing({ firstOpeningAudioAt: REQ + LIVE_OPENING_UNSPOKEN_MS + 1 })).passed).toBe(
      false,
    );
  });

  it('says when it took the re-send', () => {
    expect(openingSpokenAssertion(timing({ firstOpeningDeltaAt: REQ + 5_000 })).detail).toMatch(/re-send/);
  });

  it('times from the earlier of audio and transcript', () => {
    expect(
      openingSpokenAssertion(timing({ firstOpeningAudioAt: REQ + 20_000, firstOpeningDeltaAt: REQ + 2_000 })).passed,
    ).toBe(true);
  });

  it('is not applicable (non-gating pass) when the participant spoke first', () => {
    const r = openingSpokenAssertion(timing({ firstUserDeltaAt: REQ + 500 }));
    expect(r).toMatchObject({ passed: true, gating: false });
    expect(r.detail).toMatch(/not applicable/);
  });

  it('fails when the opening was never requested', () => {
    expect(openingSpokenAssertion(timing({ openingRequestedAt: 0 })).passed).toBe(false);
  });
});
