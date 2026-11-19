import { describe, it, expect } from 'vitest';

// clinicalSteerKind reads what a `[Clinical guidance` steer is for from its
// text (ai-therapist-364): only risk and safety steers suppress the delegation
// fallback; a time-limit notice or the minor safeguard delays it one period.
// The phrases it keys on live in sidebandManager; the texts live in the
// modules that send them. This file holds the two together with the REAL
// texts, so rewording a steer fails here instead of silently changing which
// steers stand the fallback down.
import { clinicalSteerKind, withKeepSpeaking } from './sidebandManager.service.js';
import {
  RISK_CHECK_REQUIRED_GUIDANCE,
  steeringGuidance,
  SAFETY_PROTOCOL_GUIDANCE,
  CRISIS_WIND_DOWN_GUIDANCE,
  THIRD_PARTY_GUIDANCE,
  HARM_TO_OTHERS_GUIDANCE,
} from './crisisIntervention.service.js';
import { REALTIME_MINOR_GUIDANCE, REALTIME_MINOR_SPEAK_NOW } from './minorSafeguard.service.js';
import {
  crisisTimeNotice,
  CRISIS_CEILING_LIVE,
  CRISIS_CEILING_WRAP_UP,
  CRISIS_DISREGARD_WRAP_UP,
  timeNotice,
  TIME_LIMIT_STEER,
  WRAP_UP_NUDGE,
} from '../utils/sessionAutoTerminate.js';

describe('clinicalSteerKind', () => {
  it('risk and safety steers are risk', () => {
    for (const text of [
      RISK_CHECK_REQUIRED_GUIDANCE,
      steeringGuidance(55, 'medium'),
      steeringGuidance(85, 'high'),
      SAFETY_PROTOCOL_GUIDANCE,
      CRISIS_WIND_DOWN_GUIDANCE,
      // PR 65: someone else at risk, and thoughts of harming another person.
      // Both answer a high flag and must stand the delegation fallback down.
      THIRD_PARTY_GUIDANCE,
      HARM_TO_OTHERS_GUIDANCE,
      // Sent because of what the participant just shared: a crisis steer.
      CRISIS_DISREGARD_WRAP_UP,
    ]) {
      expect(clinicalSteerKind(text), text.slice(0, 120)).toBe('risk');
      expect(clinicalSteerKind(withKeepSpeaking(text))).toBe('risk');
    }
  });

  it('time-limit notices are time_limit', () => {
    for (const text of [crisisTimeNotice(10), crisisTimeNotice(2), CRISIS_CEILING_LIVE, CRISIS_CEILING_WRAP_UP]) {
      expect(clinicalSteerKind(text), text.slice(0, 120)).toBe('time_limit');
      expect(clinicalSteerKind(withKeepSpeaking(text))).toBe('time_limit');
    }
  });

  it('the minor safeguard is minor_safeguard, as delivered to a live voice model too', () => {
    expect(clinicalSteerKind(REALTIME_MINOR_GUIDANCE)).toBe('minor_safeguard');
    expect(clinicalSteerKind(withKeepSpeaking(`${REALTIME_MINOR_GUIDANCE} ${REALTIME_MINOR_SPEAK_NOW}`))).toBe(
      'minor_safeguard',
    );
  });

  it('text without the marker is not a clinical steer at all', () => {
    for (const text of [timeNotice(20, 10), WRAP_UP_NUDGE, TIME_LIMIT_STEER, 'The participant closed the worksheet.']) {
      expect(clinicalSteerKind(text)).toBeNull();
    }
  });

  it('an unknown steer with the marker fails toward safety', () => {
    expect(clinicalSteerKind('[Clinical guidance — never mention this] Something new.')).toBe('risk');
  });
});
