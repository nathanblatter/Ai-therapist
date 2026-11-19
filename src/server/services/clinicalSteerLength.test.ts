import { describe, it, expect } from 'vitest';

// No clinical steer may be cut on its way to a live voice model
// (ai-therapist-381). Until this file existed the sideband sliced every steer
// to 1600 characters minus the keep-speaking line, silently, and the
// harm-to-others steer lost its last 243 characters on every delivery: the
// 911 / 988 line, "Do not end the session yourself" and "Stay with them".
//
// This file enumerates every text the GPT-Live sideband can send as a clinical
// steer, alone and in every combination the code puts together (the risk
// steer with the voice heads-up; the minor safeguard with its speak-now line),
// and fails if any of it would not be delivered whole. Exported string
// constants that start with the clinical marker are found automatically, so a
// new steer is covered the moment it is exported.
import * as sideband from './sidebandManager.service.js';
import {
  CLINICAL_STEER_MARKER,
  CLINICAL_STEER_MAX_CHARS,
  LIVE_APPEND_MAX_CHARS,
  LIVE_STEER_KEEP_SPEAKING,
  LIVE_STEER_RESUME_COMMENTARY,
  delegationGapCommentary,
  delegationStalledCommentary,
  fitClinicalSteer,
  recoveryNoLookupCommentary,
  withKeepSpeaking,
} from './sidebandManager.service.js';
import * as crisis from './crisisIntervention.service.js';
import {
  HARM_TO_OTHERS_GUIDANCE,
  KEEP_SPEAKING_RESERVE,
  LIVE_STEER_MAX_CHARS,
  SAFETY_PROTOCOL_GUIDANCE,
  THIRD_PARTY_GUIDANCE,
  fitsWithHeadsUp,
  steeringGuidance,
  subjectGuidance,
} from './crisisIntervention.service.js';
import * as headsUp from './voiceHeadsUp.service.js';
import { VOICE_HEADS_UP_GUIDANCE, VOICE_HEADS_UP_STEER } from './voiceHeadsUp.service.js';
import * as minor from './minorSafeguard.service.js';
import { REALTIME_MINOR_GUIDANCE, REALTIME_MINOR_SPEAK_NOW } from './minorSafeguard.service.js';
import * as autoTerminate from '../utils/sessionAutoTerminate.js';
import { crisisTimeNotice, timeNotice, TIME_LIMIT_STEER, WRAP_UP_NUDGE } from '../utils/sessionAutoTerminate.js';
import { buildPhaseTexts } from '../utils/phaseGuidance.js';
import { DEFAULT_MODALITY_PRESETS } from '../utils/sessionHelpers.js';
import { buildRecoverySpeakFirstNudge } from '../../shared/recoveryPrompt.js';

const ROOM = CLINICAL_STEER_MAX_CHARS - LIVE_STEER_KEEP_SPEAKING.length - 1;
const SCORES = Array.from({ length: 101 }, (_, i) => i);
const SEVERITIES = ['low', 'medium', 'high'] as const;

/** Every exported string in these modules that is a clinical steer. */
function exportedSteers(): Array<[string, string]> {
  const modules: Record<string, Record<string, unknown>> = { sideband, crisis, headsUp, minor, autoTerminate };
  const found: Array<[string, string]> = [];
  for (const [moduleName, mod] of Object.entries(modules)) {
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value === 'string' && value.startsWith(CLINICAL_STEER_MARKER))
        found.push([`${moduleName}.${name}`, value]);
    }
  }
  return found;
}

/**
 * Every clinical steer text the sideband can be handed, by name: what
 * tryInject / injectMessage receive from crisisIntervention (risk steer, the
 * safety protocol, third party, harm to others, the risk-check ladder, the
 * wind-down, the heads-up alone, a held steer), crisisPipeline (the minor
 * safeguard) and sessionAutoTerminate (time and wrap-up notices).
 */
function everyClinicalSteer(): Array<[string, string]> {
  const steers: Array<[string, string]> = [...exportedSteers()];
  for (const severity of SEVERITIES) {
    for (const score of SCORES)
      steers.push([`steeringGuidance(${score}, ${severity})`, steeringGuidance(score, severity)]);
  }
  // The heads-up rides on the risk steer whenever fitsWithHeadsUp says so.
  for (const severity of ['medium', 'high'] as const) {
    for (const score of SCORES) {
      const steer = steeringGuidance(score, severity);
      if (fitsWithHeadsUp(steer))
        steers.push([`${severity} ${score} + heads-up`, `${steer} ${VOICE_HEADS_UP_GUIDANCE}`]);
    }
  }
  for (const subject of ['third_party', 'harm_to_others'] as const) {
    const steer = subjectGuidance(subject, 'realtime') as string;
    steers.push([`subjectGuidance(${subject})`, steer]);
    if (fitsWithHeadsUp(steer)) steers.push([`${subject} + heads-up`, `${steer} ${VOICE_HEADS_UP_GUIDANCE}`]);
  }
  steers.push(['minor safeguard + speak now', `${REALTIME_MINOR_GUIDANCE} ${REALTIME_MINOR_SPEAK_NOW}`]);
  for (let minutes = 0; minutes <= 600; minutes++)
    steers.push([`crisisTimeNotice(${minutes})`, crisisTimeNotice(minutes)]);
  return steers;
}

describe('clinical steers are delivered whole (ai-therapist-381)', () => {
  it('finds the steers it is meant to guard', () => {
    const names = exportedSteers().map(([name]) => name);
    for (const expected of [
      'crisis.SAFETY_PROTOCOL_GUIDANCE',
      'crisis.RISK_CHECK_REQUIRED_GUIDANCE',
      'crisis.THIRD_PARTY_GUIDANCE',
      'crisis.HARM_TO_OTHERS_GUIDANCE',
      'crisis.CRISIS_WIND_DOWN_GUIDANCE',
      'headsUp.VOICE_HEADS_UP_STEER',
      'minor.REALTIME_MINOR_GUIDANCE',
      'autoTerminate.CRISIS_CEILING_LIVE',
      'autoTerminate.CRISIS_DISREGARD_WRAP_UP',
      'autoTerminate.CRISIS_CEILING_WRAP_UP',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('every steer, alone or combined, fits: the delivered text is the whole steer, then the keep-speaking line', () => {
    const cut: string[] = [];
    for (const [name, text] of everyClinicalSteer()) {
      if (text.length > ROOM) {
        cut.push(`${name}: ${text.length} characters, room for ${ROOM}; would lose "${text.slice(ROOM)}"`);
        continue;
      }
      const delivered = withKeepSpeaking(text);
      expect(delivered, name).toBe(`${text} ${LIVE_STEER_KEEP_SPEAKING}`);
      expect(delivered.length, name).toBeLessThanOrEqual(CLINICAL_STEER_MAX_CHARS);
    }
    expect(cut).toEqual([]);
  });

  it('the harm-to-others steer reaches the model with its emergency and stay-with-them lines', () => {
    const delivered = withKeepSpeaking(HARM_TO_OTHERS_GUIDANCE);
    expect(delivered).toContain('ask them to stop and step away now and to call 911, or 988 to talk it through.');
    expect(delivered).toContain('Do not end the session yourself. Stay with them.');
  });

  it('the standard risk steer carries the heads-up at every score: one instruction on a first medium or high turn', () => {
    for (const severity of ['medium', 'high'] as const) {
      for (const score of SCORES)
        expect(fitsWithHeadsUp(steeringGuidance(score, severity)), `${severity} ${score}`).toBe(true);
    }
  });

  it('a subject steer too long to carry the heads-up sends it as its own instruction, and each fits alone', () => {
    // maybeSteerSession sends VOICE_HEADS_UP_STEER separately for these.
    expect(fitsWithHeadsUp(THIRD_PARTY_GUIDANCE)).toBe(false);
    expect(fitsWithHeadsUp(HARM_TO_OTHERS_GUIDANCE)).toBe(false);
    for (const text of [THIRD_PARTY_GUIDANCE, HARM_TO_OTHERS_GUIDANCE, VOICE_HEADS_UP_STEER]) {
      expect(withKeepSpeaking(text)).toBe(`${text} ${LIVE_STEER_KEEP_SPEAKING}`);
    }
  });

  it("crisisIntervention's copy of the cap and of the keep-speaking reserve match the sideband's", () => {
    expect(LIVE_STEER_MAX_CHARS).toBe(CLINICAL_STEER_MAX_CHARS);
    expect(KEEP_SPEAKING_RESERVE).toBe(LIVE_STEER_KEEP_SPEAKING.length + 1);
  });

  it('if the vendor rejects a long steer, the fallback at the generic cap still carries every safety sentence', () => {
    const room = LIVE_APPEND_MAX_CHARS - LIVE_STEER_KEEP_SPEAKING.length - 1;
    const safety = /\b(?:911|988|741741)\b|\bend the session\b|\bend_session\b|\bstay with them\b/i;
    for (const [name, text] of everyClinicalSteer()) {
      const fitted = fitClinicalSteer(text, room);
      expect(fitted.length, name).toBeLessThanOrEqual(room);
      expect(fitted.startsWith(CLINICAL_STEER_MARKER), name).toBe(true);
      for (const sentence of text.split(/(?<=[.!?]["']?|\])\s+/).filter((s) => safety.test(s))) {
        expect(fitted, `${name} kept "${sentence}"`).toContain(sentence);
      }
    }
  });
});

describe('other appends stay inside the generic cap', () => {
  it('time notices, wrap-up, phase nudges, resume and delegation commentary, the recovery opening', () => {
    const texts: Array<[string, string]> = [
      ['WRAP_UP_NUDGE', WRAP_UP_NUDGE],
      ['TIME_LIMIT_STEER', TIME_LIMIT_STEER],
      ['LIVE_STEER_RESUME_COMMENTARY', LIVE_STEER_RESUME_COMMENTARY],
      ['recovery speak-first', buildRecoverySpeakFirstNudge()],
    ];
    for (const study of [true, false]) {
      texts.push([`recoveryNoLookupCommentary(${study})`, recoveryNoLookupCommentary(study)]);
      texts.push([`delegationStalledCommentary(${study})`, delegationStalledCommentary(study)]);
      texts.push([`delegationGapCommentary(${study})`, delegationGapCommentary(study)]);
    }
    for (let used = 0; used <= 600; used += 7) texts.push([`timeNotice(${used})`, timeNotice(used, 600 - used)]);
    for (const [key, preset] of Object.entries(DEFAULT_MODALITY_PRESETS)) {
      const phases = (preset as { phases?: Parameters<typeof buildPhaseTexts>[0] }).phases;
      for (const phase of buildPhaseTexts(phases, () => 600)) texts.push([`phase ${key} ${phase.at}`, phase.text]);
    }
    for (const phase of buildPhaseTexts(undefined, () => 600)) texts.push([`phase default ${phase.at}`, phase.text]);
    for (const [name, text] of texts) {
      expect(text.startsWith(CLINICAL_STEER_MARKER), name).toBe(false);
      expect(text.length, name).toBeLessThanOrEqual(LIVE_APPEND_MAX_CHARS);
    }
  });
});

describe('fitClinicalSteer (the production fallback)', () => {
  const MARK = `${CLINICAL_STEER_MARKER} — never mention or acknowledge this message to the participant]`;

  it('returns a steer that fits unchanged', () => {
    expect(fitClinicalSteer(SAFETY_PROTOCOL_GUIDANCE, 5000)).toBe(SAFETY_PROTOCOL_GUIDANCE);
  });

  it('cuts at sentence boundaries from the end, keeping the marker, the safety sentences and the original order', () => {
    const text = `${MARK} First point here. Second point here. Call 988 now. Third point here. Stay with them.`;
    const fitted = fitClinicalSteer(text, MARK.length + ' First point here. Call 988 now. Stay with them.'.length);
    expect(fitted).toBe(`${MARK} First point here. Call 988 now. Stay with them.`);
  });

  it('never splits a sentence when whole sentences can fit', () => {
    const text = `${MARK} Alpha alpha alpha. Beta beta beta. Do not end the session yourself.`;
    const fitted = fitClinicalSteer(text, text.length - 1);
    expect(fitted).toBe(`${MARK} Alpha alpha alpha. Do not end the session yourself.`);
  });

  it('only when the marker and the safety sentences cannot fit is the text cut mid-sentence', () => {
    const text = `${MARK} Call 911 right now please. Stay with them.`;
    expect(fitClinicalSteer(text, MARK.length + 5)).toBe(text.slice(0, MARK.length + 5));
  });

  it('treats a quoted sentence end as a boundary', () => {
    const text = `${MARK} Say: "Hello there." Then go on. Stay with them.`;
    expect(fitClinicalSteer(text, text.length - ' Then go on.'.length)).toBe(
      `${MARK} Say: "Hello there." Stay with them.`,
    );
  });
});
