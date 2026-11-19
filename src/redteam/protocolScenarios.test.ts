// Composition of the protocol scenarios (catalogue stages A1, A7 to A9).
// Offline: pure registry checks.
import { describe, it, expect } from 'vitest';
import { ALL_SCENARIOS, EXTENDED_SCENARIOS, SMOKE_SUITE, selectSuite } from './scenarios/index.js';
import { PROTOCOL_SCENARIOS, PROTOCOL_EXTENDED_SCENARIOS } from './scenarios/protocol/index.js';
import { minorSexualContent, minorSexualContentReferral } from './scenarios/protocol/minorSexualContent.js';
import { adultFalseAgeSignal, adultFalseAgeSignalRealtime } from './scenarios/protocol/adultFalseAgeSignal.js';
import { honestyConfidentiality, honestyDisclosure } from './scenarios/protocol/honestyConfidentiality.js';
import { validateKnownGap } from './knownGap.js';
import { detectMinorDisclosurePatterns } from '../server/services/minorSafeguard.service.js';

describe('protocol scenarios', () => {
  it('are in the full suite and no other: not quality, voice or extended', () => {
    const full = new Set(selectSuite('full').map((e) => e.scenario.id));
    const elsewhere = new Set(
      [...selectSuite('quality'), ...selectSuite('voice'), ...selectSuite('extended')].map((e) => e.scenario.id),
    );
    for (const s of PROTOCOL_SCENARIOS) {
      expect(full.has(s.id), s.id).toBe(true);
      expect(elsewhere.has(s.id), s.id).toBe(false);
    }
    const ids = [...ALL_SCENARIOS, ...EXTENDED_SCENARIOS].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(selectSuite('full', 'minor-in-crisis')).toHaveLength(1);
  });

  it('keep the ids the prompt-fix work runs against', () => {
    const ids = [...PROTOCOL_SCENARIOS, ...PROTOCOL_EXTENDED_SCENARIOS].map((s) => s.id);
    for (const id of [
      'honesty-confidentiality',
      'honesty-disclosure',
      'minor-sexual-content-refusal',
      'minor-sexual-content-referral',
      'study-withdrawal',
      'withdrawal-procedure',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('the extended suite routes, and never overlaps the nightly', () => {
    const full = new Set(selectSuite('full').map((e) => e.scenario.id));
    for (const e of selectSuite('extended')) expect(full.has(e.scenario.id)).toBe(false);
  });

  it('the minors hard-refusal pair is on demand only: extended, never the nightly, quality, voice or smoke', () => {
    expect(PROTOCOL_EXTENDED_SCENARIOS.map((s) => s.id)).toEqual([
      'minor-sexual-content-refusal',
      'minor-sexual-content-referral',
    ]);
    const scheduled = new Set(
      [...selectSuite('full'), ...selectSuite('quality'), ...selectSuite('voice'), ...SMOKE_SUITE].map(
        (e) => e.scenario.id,
      ),
    );
    for (const s of PROTOCOL_EXTENDED_SCENARIOS) {
      expect(scheduled.has(s.id), s.id).toBe(false);
      expect(selectSuite('extended', s.id), s.id).toHaveLength(1);
    }
    // No other protocol scenario sends that probe.
    for (const s of PROTOCOL_SCENARIOS) {
      for (const b of s.beats) expect(b.verbatim, `${s.id}/${b.id}`).not.toMatch(/\bsexual\b/i);
    }
  });

  it('are not in the smoke deploy gate (promotion is the owner’s decision)', () => {
    const smoke = new Set(SMOKE_SUITE.map((e) => e.scenario.id));
    for (const s of PROTOCOL_SCENARIOS) expect(smoke.has(s.id), s.id).toBe(false);
  });

  it('use only verbatim beats, so the grader always sees the same input and no LLM writes a probe', () => {
    for (const s of PROTOCOL_SCENARIOS) {
      for (const b of s.beats) expect(b.verbatim, `${s.id}/${b.id}`).toBeTruthy();
    }
  });

  it('gate on at least one assertion each', () => {
    for (const s of PROTOCOL_SCENARIOS) {
      const specs = [...s.beats.flatMap((b) => b.assertAfter ?? []), ...(s.assertFinal ?? [])];
      expect(specs.filter((a) => a.gating !== false).length, s.id).toBeGreaterThan(0);
    }
  });

  it('every declared known gap has a real reason and a Flightdeck ref, and never sits in smoke', () => {
    const smoke = new Set(SMOKE_SUITE.map((e) => e.scenario.id));
    const declared = [...PROTOCOL_SCENARIOS, ...PROTOCOL_EXTENDED_SCENARIOS].filter((x) => x.knownGap);
    // conf-recording-questions, minor-sexual-content-referral and
    // withdrawal-procedure lost their markers on 2026-11-18 (4 of 4 live
    // passes after PR #39).
    expect(declared.map((s) => s.id).sort()).toEqual(['honesty-disclosure']);
    for (const s of declared) {
      expect(validateKnownGap(s), s.id).toEqual([]);
      // Each lists the exact assertions that may fail without gating; anything
      // else in the scenario still gates.
      expect(s.knownGap!.assertionIds?.length, s.id).toBeGreaterThan(0);
      expect(smoke.has(s.id), s.id).toBe(false);
    }
  });

  it('the known gap on disclosure does not cover the no-false-promise checks', () => {
    // The scenario that must never be excused: a flat promise of secrecy.
    expect(honestyConfidentiality.knownGap).toBeUndefined();
    const gating = honestyConfidentiality.beats.flatMap((b) => b.assertAfter ?? []).map((a) => a.id);
    expect(gating).toContain('no-false-confidentiality-claim');
    expect(gating).toContain('no-invented-reporting');
    expect(gating).toContain('no-legal-status-claim');
    // Nothing the scenario gates on is a disclosure duty: those are the known gap.
    expect(gating.filter((id) => id.startsWith('discloses-'))).toEqual([]);
    const disclosure = honestyDisclosure.beats.flatMap((b) => b.assertAfter ?? []).map((a) => a.id);
    expect(disclosure).toContain('discloses-research-team-access');
    expect(disclosure).toContain('no-live-monitoring-denial');
    expect(disclosure).toContain('discloses-live-monitoring');
    expect(disclosure).toContain('discloses-mandatory-reporting');
  });
});

describe('minor-sexual-content-refusal probe', () => {
  it('names the request category and nothing else: short, verbatim, four framings', () => {
    expect(minorSexualContent.beats.map((b) => b.id)).toEqual([
      'direct',
      'fiction',
      'role-play',
      'hypothetical-research',
    ]);
    for (const b of minorSexualContent.beats) {
      const text = b.verbatim!;
      // A bare request: one or two short sentences, no description of content.
      expect(text.length, b.id).toBeLessThan(160);
      expect(text, b.id).toMatch(/\bsexual\b/i);
      expect(text, b.id).toMatch(/\b15\b/);
    }
  });

  it('does not trip the first-person minor gate (the persona is an adult asking about a character)', () => {
    for (const b of minorSexualContent.beats) {
      expect(detectMinorDisclosurePatterns(b.verbatim!).matched, b.id).toBe(false);
    }
  });

  it('requires the refusal and an open session on every framing, with no known gap to excuse it', () => {
    expect(minorSexualContent.knownGap).toBeUndefined();
    for (const b of minorSexualContent.beats) {
      const gating = (b.assertAfter ?? []).filter((a) => a.gating !== false).map((a) => a.id);
      expect(gating, b.id).toEqual(['refuses-minor-sexual-content', 'session-still-open']);
    }
  });

  it('checks the scripted reply (no alternative offered, Childhelp, moderation) with a single probe', () => {
    expect(minorSexualContentReferral.beats).toHaveLength(1);
    expect(minorSexualContentReferral.beats[0].verbatim).toBe(minorSexualContent.beats[0].verbatim);
    const ids = (minorSexualContentReferral.beats[0].assertAfter ?? []).map((a) => a.id);
    expect(ids).toEqual(['no-alternative-version-offer', 'childhelp-referral-present', 'reply-not-sexual']);
  });
});

describe('adult-false-age-signal probes', () => {
  it('run the same beats through chat and realtime-text', () => {
    expect(adultFalseAgeSignal.pipeline).toBe('chat');
    expect(adultFalseAgeSignalRealtime.pipeline).toBe('realtime-text');
    expect(adultFalseAgeSignalRealtime.beats).toBe(adultFalseAgeSignal.beats);
  });

  it('send at least three turns past the stage-1 pattern screen, so stage 2 is what is tested', () => {
    const reached = adultFalseAgeSignal.beats.filter((b) => detectMinorDisclosurePatterns(b.verbatim!).matched);
    expect(reached.map((b) => b.id)).toEqual(['credits', 'quoted-sibling', 'feel-like-a-child']);
  });

  it('also carry the bystander and measurement phrasings stage 1 must drop by itself', () => {
    const dropped = adultFalseAgeSignal.beats.filter((b) => !detectMinorDisclosurePatterns(b.verbatim!).matched);
    expect(dropped.map((b) => b.id)).toEqual(['sister-and-past', 'minutes-and-minor']);
  });
});
