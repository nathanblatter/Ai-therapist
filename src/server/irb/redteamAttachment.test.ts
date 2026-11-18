import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  EXCERPT_MAX_CHARS,
  assistantExcerpt,
  judgeStats,
  parseRunSummary,
  renderRedteamAttachment,
  scenarioStatus,
} from './redteamAttachment.js';

const fixture = JSON.parse(readFileSync(new URL('./redteamAttachment.fixture.json', import.meta.url), 'utf8'));
const run = parseRunSummary(fixture);
const opts = { prepared: 'November 18, 2026', sourceLabel: 'fixture', sourceSha256: 'abc123' };
const byId = (id: string) => {
  const s = run.scenarios.find((x) => x.id === id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
};

describe('parseRunSummary', () => {
  it('rejects something that is not a results file', () => {
    expect(() => parseRunSummary({ nope: 1 })).toThrow(/scenarios/);
    expect(() => parseRunSummary(null)).toThrow();
  });

  it('reads run metadata and tolerates unknown fields and malformed entries', () => {
    expect(run.suite).toBe('full');
    expect(run.gitSha).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(run.seed).toBe(42);
    expect(run.scenarios).toHaveLength(5);
    expect(run.scenarios[4]).toMatchObject({ id: 'scenario-5', pipeline: 'unknown', passed: false });
  });

  it('keeps assistant turns and drops persona text', () => {
    expect(byId('chat-crisis-ladder').assistantTurns).toEqual(['Opening line.', "I'm glad you told me."]);
  });

  it('reads variations from the field or the #vN suffix', () => {
    expect(byId('realtime-crisis-ladder').variation).toBe(0);
    expect(byId('realtime-crisis-ladder#v2').variation).toBe(1);
  });

  it('reads a knownGap object, a string, or nothing', () => {
    expect(byId('realtime-crisis-ladder').knownGap).toEqual({
      reason: 'detector misses a euphemism',
      ref: 'ai-therapist-999',
    });
    const s = parseRunSummary({ scenarios: [{ id: 'x', knownGap: 'plain reason', assertions: [] }] });
    expect(s.scenarios[0].knownGap).toEqual({ reason: 'plain reason', ref: null });
    expect(byId('boundary-testing').knownGap).toBeNull();
  });

  it('reads the configuration variant as an object, a string, or absent', () => {
    expect(run.variant).toBeNull();
    expect(parseRunSummary({ scenarios: [], variant: { name: 'lead-conversation', features: {} } }).variant).toBe(
      'lead-conversation',
    );
    expect(parseRunSummary({ scenarios: [], variant: 'default' }).variant).toBe('default');
  });

  it('marks a report-only session_progression dimension as such', () => {
    const r = parseRunSummary({
      scenarios: [{ id: 'q', passed: true, assertions: [], judge: { scores: { session_progression: 3 } } }],
    });
    expect(renderRedteamAttachment(r, opts)).toContain('session_progression dimension is report-only');
  });

  it('accepts models recorded as an object or an array', () => {
    expect(parseRunSummary({ scenarios: [], models: { chat: 'm1' } }).models).toEqual([['chat', 'm1']]);
    expect(parseRunSummary({ scenarios: [], models: [{ function: 'judge', model: 'm2' }] }).models).toEqual([
      ['judge', 'm2'],
    ]);
  });
});

describe('derived figures', () => {
  it('classifies scenario status', () => {
    expect(scenarioStatus(byId('chat-crisis-ladder'))).toBe('PASS');
    expect(scenarioStatus(byId('boundary-testing'))).toBe('FAIL');
    expect(scenarioStatus(byId('realtime-crisis-ladder'))).toBe('KNOWN GAP');
    expect(scenarioStatus(byId('realtime-crisis-ladder#v2'))).toBe('ERROR');
  });

  it('computes judge mean and minimum per dimension, including dimensions it has never seen', () => {
    const stats = judgeStats(run);
    expect(stats.map((d) => d.dimension)).toEqual(['a_new_dimension', 'empathy', 'safety_protocol']);
    const safety = stats.find((d) => d.dimension === 'safety_protocol');
    expect(safety).toMatchObject({ judged: 2, mean: 4, min: 3, minAt: ['boundary-testing'] });
  });

  it('cuts long excerpts', () => {
    const ex = assistantExcerpt(byId('boundary-testing'));
    expect(ex).not.toBeNull();
    expect(ex!.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS);
    expect(ex!.endsWith('...')).toBe(true);
  });
});

describe('renderRedteamAttachment', () => {
  const html = renderRedteamAttachment(run, { ...opts, models: [['Typed chat conversation', 'chat-model-x']] });

  it('is deterministic', () => {
    expect(renderRedteamAttachment(run, opts)).toBe(renderRedteamAttachment(run, opts));
  });

  it('reports run metadata, totals and failing checks from the file', () => {
    expect(html).toContain('0123456789abcdef0123456789abcdef01234567');
    expect(html).toContain('<b>1 of 5 scenarios passed</b>');
    expect(html).toContain('<b>holds-boundary</b>: boundary NOT held &lt;0/3 yes&gt;');
    expect(html).toContain('chat-model-x');
    expect(html).toContain('abc123');
  });

  it('lists known gaps as gaps, not passes', () => {
    expect(html).toContain('detector misses a euphemism (ai-therapist-999)');
    expect(html).toContain('<td>KNOWN GAP</td>');
  });

  it('never renders persona text', () => {
    expect(html).not.toContain('PERSONA-SECRET-TEXT');
  });

  it('does not claim the voice crisis ladder passes when the run has no voice result', () => {
    expect(html).toContain('Not currently passing on GPT-Live, and not evaluated nightly');
    expect(html).not.toMatch(/voice[^<]{0,80}PASS/i);
  });

  it('states the re-run cadence as it is today', () => {
    expect(html).toContain('runs every night on the main branch');
    expect(html).toContain('do not currently start a run');
    expect(html).not.toContain('whenever the system prompt');
  });

  it('says a single run is a single run', () => {
    expect(html).toContain('Some scenarios were run more than once'); // the fixture has a #v2
    const single = parseRunSummary({ ...fixture, scenarios: fixture.scenarios.slice(0, 2) });
    expect(renderRedteamAttachment(single, opts)).toContain('Each scenario was run once');
  });
});
