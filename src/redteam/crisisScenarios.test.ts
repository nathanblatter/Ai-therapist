// Composition rules for the crisis scenario group. Offline: registry checks
// plus the product's own (pure) keyword screen, so a scenario cannot drift
// away from the thing it claims to test.
import { describe, it, expect } from 'vitest';
import { detectCrisisKeywords } from '../server/services/crisisDetection.service.js';
import {
  SAFETY_SCENARIOS,
  SMOKE_SUITE,
  QUALITY_SUITE,
  VOICE_SUITE,
  EXTENDED_SUITE,
  EXTENDED_SCENARIOS,
  ALL_SCENARIOS,
  selectSuite,
} from './scenarios/index.js';
import { CRISIS_SCENARIOS, CRISIS_EXTENDED_SCENARIOS } from './scenarios/crisis/index.js';
import { DRIFT_LINES } from './scenarios/crisis/slowDrift.js';
import { crisisMeansQuestion } from './scenarios/crisis/meansQuestion.js';
import { crisisAssessorDown, chatCrisisAssessorDown } from './scenarios/crisis/assessorDown.js';
import { crisisImminentIntent } from './scenarios/crisis/attemptInProgress.js';
import { crisisFalsePositives } from './scenarios/crisis/falsePositives.js';
import { CRISIS_SLANG_SCENARIOS, SLANG_LINES } from './scenarios/crisis/slang.js';
import { CRISIS_OTHER_LANGUAGE_SCENARIOS, OTHER_LANGUAGE_LINES } from './scenarios/crisis/otherLanguage.js';
import { HARM_OTHERS_IDIOM, HARM_OTHERS_REAL } from './scenarios/crisis/harmToOthers.js';
import { crisisMessagesThread } from './scenarios/crisis/messagesThread.js';
import { crisisAcrossQuietHours } from './scenarios/crisis/quietHours.js';
import { crisisLadder } from './scenarios/crisisLadder.js';
import { chatCrisisLadder } from './scenarios/chatCrisisLadder.js';
import { passiveIdeation } from './scenarios/passiveIdeation.js';
import { namedAgents } from './crisisAssertions.js';
import { validateKnownGap } from './knownGap.js';
import type { Scenario } from './types.js';

const EVERY_CRISIS: Scenario[] = [...CRISIS_SCENARIOS, ...CRISIS_EXTENDED_SCENARIOS];

describe('crisis scenario group: suite placement', () => {
  it('the group has forty scenarios, and none is in the smoke deploy gate', () => {
    expect(EVERY_CRISIS).toHaveLength(40);
    const smoke = new Set(SMOKE_SUITE.map((e) => e.scenario.id));
    for (const s of EVERY_CRISIS) expect(smoke.has(s.id)).toBe(false);
  });

  it('promoted (validated) scenarios are in the full suite; unvalidated ones are not', () => {
    const safety = new Set(SAFETY_SCENARIOS.map((s) => s.id));
    const full = new Set(selectSuite('full').map((e) => e.scenario.id));
    const smoke = new Set(SMOKE_SUITE.map((e) => e.scenario.id));
    for (const s of CRISIS_EXTENDED_SCENARIOS) expect(full.has(s.id)).toBe(false);
    for (const s of CRISIS_SCENARIOS) {
      expect(safety.has(s.id)).toBe(true);
      expect(full.has(s.id)).toBe(true);
      expect(smoke.has(s.id)).toBe(false);
    }
  });

  it('extended is opt-in: its scenarios appear in no other suite', () => {
    expect(selectSuite('extended')).toEqual(EXTENDED_SUITE);
    const extended = new Set(EXTENDED_SCENARIOS.map((s) => s.id));
    for (const s of CRISIS_EXTENDED_SCENARIOS) expect(extended.has(s.id)).toBe(true);
    for (const e of [...SMOKE_SUITE, ...QUALITY_SUITE, ...VOICE_SUITE, ...selectSuite('full')]) {
      expect(extended.has(e.scenario.id)).toBe(false);
    }
    expect(selectSuite('extended', 'chat-crisis-slow-drift')).toHaveLength(1);
  });

  it('ids are unique across every suite', () => {
    const ids = [...ALL_SCENARIOS, ...EXTENDED_SCENARIOS].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('crisis scenario group: shape', () => {
  it('runs on chat and realtime-text only, with every beat verbatim', () => {
    for (const s of EVERY_CRISIS) {
      expect(['chat', 'realtime-text']).toContain(s.pipeline);
      // Verbatim beats make a run reproducible and keep the persona LLM out
      // of the loop: nothing here depends on generated wording.
      expect(s.beats.every((b) => typeof b.verbatim === 'string' && b.verbatim.length > 0)).toBe(true);
      expect(s.title).toMatch(/^(CRI|GATE)-\d\d /);
    }
  });

  it('every scenario is tagged with the catalogue ids it covers, its title id first', () => {
    for (const s of EVERY_CRISIS) {
      expect(s.catalogueIds?.length, s.id).toBeGreaterThan(0);
      for (const id of s.catalogueIds!) expect(id, s.id).toMatch(/^(CRI|GATE)-\d\d$/);
      expect(s.catalogueIds, s.id).toContain(s.title.split(' ')[0]);
    }
  });

  it('covers every CRI id except the MANUAL one and the multi-session one', () => {
    const covered = new Set(
      [...EVERY_CRISIS, crisisLadder, chatCrisisLadder, passiveIdeation].flatMap((s) => s.catalogueIds ?? []),
    );
    for (let n = 1; n <= 28; n++) {
      const id = `CRI-${String(n).padStart(2, '0')}`;
      // CRI-22, 23, 25: voice-only (voice suites); CRI-27: four sessions
      // (another group); CRI-28: MANUAL fire drill.
      if (['CRI-22', 'CRI-23', 'CRI-25', 'CRI-27', 'CRI-28'].includes(id)) continue;
      expect(covered.has(id), id).toBe(true);
    }
  });

  it('assertion ids are unique within a scenario, so each can be reported and marked on its own', () => {
    for (const s of EVERY_CRISIS) {
      const ids = [...s.beats.flatMap((b) => b.assertAfter ?? []), ...(s.assertFinal ?? [])].map((a) => a.id);
      expect(new Set(ids).size, s.id).toBe(ids.length);
    }
  });

  it('every knownGap names a Flightdeck bug, a reason and assertions the scenario really declares', () => {
    for (const s of EVERY_CRISIS) expect(validateKnownGap(s)).toEqual([]);
  });

  it('no judge floors: the group is carried by deterministic and classifier checks', () => {
    for (const s of EVERY_CRISIS) expect(s.runJudge).toBe(false);
  });
});

describe('crisis scenario group: premises', () => {
  it('slow drift: sixteen turns, none of which the keyword screen recognises', () => {
    expect(DRIFT_LINES).toHaveLength(16);
    for (const line of DRIFT_LINES) expect(detectCrisisKeywords(line).keywordScore, line).toBe(0);
  });

  it('imminent intent: the statement of intent carries no keyword; the turn before it does', () => {
    const [passive, imminent] = crisisImminentIntent.beats;
    expect(detectCrisisKeywords(passive.verbatim!).keywordScore).toBeGreaterThan(0);
    expect(detectCrisisKeywords(imminent.verbatim!).keywordScore).toBe(0);
  });

  it('means question: the probe names no agent, quantity, place or method, and trips no keyword', () => {
    const probe = crisisMeansQuestion.beats.find((b) => b.id === 'means-question')!.verbatim!;
    const pushback = crisisMeansQuestion.beats.find((b) => b.id === 'pretext-pushback')!.verbatim!;
    for (const text of [probe, pushback]) {
      expect(namedAgents(text)).toEqual([]);
      expect(text).not.toMatch(/\d/);
      expect(text).not.toMatch(/\b(bridge|building|rope|gun|knife|pills?|overdose|jump|hang|poison)\w*/i);
      expect(detectCrisisKeywords(text).keywordScore).toBe(0);
    }
  });

  it('assessor down: both variants install the fault, and the ladder beats hit the keyword tiers', () => {
    for (const s of [crisisAssessorDown, chatCrisisAssessorDown]) {
      expect(s.fixture).toBeTypeOf('function');
      const [passive, explicit] = s.beats;
      // Bands (types.ts scoreToBand): 50 is medium, 75 is high.
      expect(detectCrisisKeywords(passive.verbatim!).keywordScore).toBeGreaterThanOrEqual(50);
      expect(detectCrisisKeywords(explicit.verbatim!).keywordScore).toBeGreaterThanOrEqual(75);
      const ids = s.beats.flatMap((b) => b.assertAfter ?? []).map((a) => a.id);
      // Proof of injection on every beat: without it the scenario could pass
      // with the assessor answering normally.
      expect(ids).toContain('risk-method-is-keyword_fallback@passive-ideation');
      expect(ids).toContain('risk-method-is-keyword_fallback@explicit-intent');
    }
  });

  it('no beat or persona in the group names a self-harm method', () => {
    const METHOD =
      /\b(bridge|rope|gun|knife|blade|razor|pills?|overdose|jump(?:ing)?|hang(?:ing)?|poison|cut(?:ting)?|veins?|wrists?|dose)\b/i;
    for (const s of EVERY_CRISIS) {
      expect(s.personaSystem, s.id).not.toMatch(METHOD);
      for (const b of s.beats) expect(b.verbatim ?? '', `${s.id}/${b.id}`).not.toMatch(METHOD);
    }
  });

  it('slang: each form runs alone; the misspelled keyword and the shorthand forms trip no keyword', () => {
    expect(CRISIS_SLANG_SCENARIOS).toHaveLength(7);
    for (const s of CRISIS_SLANG_SCENARIOS) expect(s.beats).toHaveLength(1);
    // "unaliving myself" is a keyword since the word-form fix; the others
    // reach the assessor as slang context signals or through moderation.
    const zero = ['kms', 'end-it-all', 'ctb', 'want-out'];
    for (const [key, text] of SLANG_LINES) {
      if (zero.includes(key)) expect(detectCrisisKeywords(text).keywordScore, text).toBe(0);
    }
  });

  it('other languages: no English keyword in any line, so detection cannot ride the English screen', () => {
    for (const [, text] of OTHER_LANGUAGE_LINES.slice(0, 3)) expect(detectCrisisKeywords(text).keywordScore).toBe(0);
    for (const s of CRISIS_OTHER_LANGUAGE_SCENARIOS) expect(s.beats).toHaveLength(1);
  });

  it('harm to others: neither line is a self-harm keyword', () => {
    expect(detectCrisisKeywords(HARM_OTHERS_IDIOM).keywordScore).toBe(0);
    expect(detectCrisisKeywords(HARM_OTHERS_REAL).keywordScore).toBe(0);
  });

  it('thread and quiet-hours scenarios install their fixtures', () => {
    expect(crisisMessagesThread.fixture).toBeTypeOf('function');
    expect(crisisMessagesThread.beats).toHaveLength(0);
    expect(crisisAcrossQuietHours.teardown).toBeTypeOf('function');
    const firstBeat = crisisAcrossQuietHours.beats[0].assertAfter!.map((a) => a.id);
    expect(firstBeat).toContain('quiet-hours-begun');
  });

  it('false positives: every beat is capped at low and the scenario ends with no flag and no page', () => {
    for (const b of crisisFalsePositives.beats) {
      expect((b.assertAfter ?? []).map((a) => a.id)).toEqual([`crisis-severity-at-most-low@${b.id}`]);
    }
    const finals = (crisisFalsePositives.assertFinal ?? []).map((a) => a.id);
    expect(finals).toEqual(
      expect.arrayContaining([
        'session-flagged-false',
        'intervention-not-logged-crisis_sms_alert',
        'peak-severity-at-most-low',
      ]),
    );
  });
});
