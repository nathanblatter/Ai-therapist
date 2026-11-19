// Generated adversarial variants (ai-therapist-109): offline tests with a
// mocked generator model. No network, no database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CostTracker } from './config.js';
import {
  buildGeneratedVariants,
  clampVariantCount,
  generateVariant,
  GENERATOR_PROMPT_VERSION,
  GUARD_PROMPT_VERSION,
  isGeneratedId,
  materializeVariant,
  MAX_GENERATED_VARIANTS,
  MUTATION_OPERATORS,
  OPERATOR_IDS,
  planVariants,
  structuralGuard,
  variantId,
  type GenerateOptions,
  type GeneratorClient,
} from './generatedVariants.js';
import { FULL_SUITE, SAFETY_SCENARIOS, SMOKE_SUITE, type SuiteEntry } from './scenarios/index.js';
import { buildJUnit, buildSummaryJson, printConsole, type RunSummary } from './report.js';
import { diffRuns, normalizeSummary } from './diff.js';
import type { ScenarioResult } from './types.js';

const SAFETY_IDS = new Set(SAFETY_SCENARIOS.map((s) => s.id));
const entryFor = (id: string): SuiteEntry => FULL_SUITE.find((e) => e.scenario.id === id)!;
const eatingDisorder = entryFor('eating-disorder');

interface GenRequest {
  model: string;
  temperature: number;
  seed: number;
  messages: Array<{ role: string; content: string }>;
}

/** Mock generator: rewrites each beat as "<operator> rewrite of <id>" (plus a
 *  persist follow-up when asked) and answers the theme guard with `guard`. */
function mockClient(
  guard: Record<string, unknown> = { onTheme: true, sameRiskLevel: true, addsOperationalDetail: false, reason: 'ok' },
  // Digits stripped: a beat id like `turn-01` would otherwise put a figure the
  // parent never used into the rewrite and trip the structural guard, which
  // made the call-count tests depend on which parents the seeded shuffle picks.
  rewrite: (id: string) => string = (id) => `a reworded message for ${id.replace(/\d/g, '')}`,
) {
  const create = vi.fn(async (body: GenRequest) => {
    const system = body.messages[0].content;
    if (system.startsWith(`[${GUARD_PROMPT_VERSION}]`)) {
      return {
        choices: [{ message: { content: JSON.stringify(guard) } }],
        usage: { prompt_tokens: 900, completion_tokens: 60 },
      };
    }
    expect(system.startsWith(`[${GENERATOR_PROMPT_VERSION}]`)).toBe(true);
    const user = body.messages[1].content;
    const brief = JSON.parse(user.slice(user.indexOf('\n[') + 1)) as Array<{ id: string; asserted?: boolean }>;
    const beats = brief.map((b) => ({
      id: b.id,
      text: rewrite(b.id),
      ...(b.asserted ? { persist: `you did not answer, I am asking again about ${b.id}` } : {}),
    }));
    return {
      choices: [{ message: { content: JSON.stringify({ beats }) } }],
      usage: { prompt_tokens: 1200, completion_tokens: 400 },
    };
  });
  return { client: { chat: { completions: { create } } } as unknown as GeneratorClient, create };
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redteam-gen-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function opts(client: GeneratorClient | null, over: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    client,
    dryRun: false,
    generatorModel: 'gpt-4o-mini',
    guardModel: 'gpt-4o-mini',
    cacheDir: path.join(tmp, 'cache'),
    runDir: path.join(tmp, 'run'),
    cost: new CostTracker(),
    safetyIds: SAFETY_IDS,
    ...over,
  };
}

describe('mutation operators', () => {
  it('are explicitly defined, versioned and have instructions', () => {
    expect(OPERATOR_IDS.length).toBeGreaterThanOrEqual(5);
    for (const id of OPERATOR_IDS) {
      const op = MUTATION_OPERATORS[id];
      expect(op.id).toBe(id);
      expect(op.version).toBeGreaterThanOrEqual(1);
      expect(op.instruction.length).toBeGreaterThan(40);
    }
    expect(OPERATOR_IDS).toEqual(
      expect.arrayContaining(['paraphrase', 'escalation-order', 'indirection', 'topic-camouflage', 'persistence']),
    );
  });

  it('variant ids are (parent, operator, seed) and marked generated', () => {
    const id = variantId('eating-disorder', 'paraphrase', 42);
    expect(id).toBe('gen:eating-disorder:paraphrase:s42');
    expect(isGeneratedId(id)).toBe(true);
    expect(isGeneratedId('eating-disorder')).toBe(false);
  });
});

describe('planVariants (determinism + cap)', () => {
  it('is off unless asked: 0 / negative / NaN plan nothing', () => {
    expect(planVariants(FULL_SUITE, SAFETY_IDS, 0, 42)).toEqual([]);
    expect(planVariants(FULL_SUITE, SAFETY_IDS, -3, 42)).toEqual([]);
    expect(planVariants(FULL_SUITE, SAFETY_IDS, Number.NaN, 42)).toEqual([]);
  });

  it('same seed, same plan; a different seed shuffles differently', () => {
    const a = planVariants(FULL_SUITE, SAFETY_IDS, 8, 42).map((p) => p.id);
    const b = planVariants(FULL_SUITE, SAFETY_IDS, 8, 42).map((p) => p.id);
    const c = planVariants(FULL_SUITE, SAFETY_IDS, 8, 7).map((p) => p.id);
    expect(a).toEqual(b);
    expect(a).toHaveLength(8);
    expect(new Set(a).size).toBe(8);
    expect(c.map((id) => id.replace(/:s\d+$/, ''))).not.toEqual(a.map((id) => id.replace(/:s\d+$/, '')));
  });

  it('enforces the hard cap whatever is requested', () => {
    expect(clampVariantCount(1000)).toBe(MAX_GENERATED_VARIANTS);
    expect(planVariants(FULL_SUITE, SAFETY_IDS, 1000, 42)).toHaveLength(MAX_GENERATED_VARIANTS);
    expect(clampVariantCount(2.7)).toBe(2);
  });

  it('only participant-facing safety scenarios parent variants (no quality, assistant or voice)', () => {
    const plan = planVariants(FULL_SUITE, SAFETY_IDS, MAX_GENERATED_VARIANTS, 1);
    for (const p of plan) {
      expect(SAFETY_IDS.has(p.entry.scenario.id)).toBe(true);
      expect(['chat', 'realtime-text']).toContain(p.entry.scenario.pipeline);
    }
  });

  it('respects an operator allow-list', () => {
    const plan = planVariants(FULL_SUITE, SAFETY_IDS, 10, 42, ['paraphrase']);
    expect(plan.every((p) => p.operator === 'paraphrase')).toBe(true);
  });
});

describe('generateVariant (mocked generator)', () => {
  const plan = {
    entry: eatingDisorder,
    operator: 'paraphrase' as const,
    seed: 42,
    id: variantId('eating-disorder', 'paraphrase', 42),
  };

  it('sends the seed, and identical inputs produce identical scripts', async () => {
    const m1 = mockClient();
    const m2 = mockClient();
    const a = await generateVariant(plan, opts(m1.client, { cacheDir: path.join(tmp, 'c1') }));
    const b = await generateVariant(plan, opts(m2.client, { cacheDir: path.join(tmp, 'c2') }));
    expect(a.status).toBe('valid');
    expect(a.beats).toEqual(b.beats);
    expect(a.fingerprint).toBe(b.fingerprint);
    const genCall = m1.create.mock.calls[0][0] as GenRequest;
    expect(genCall.seed).toBe(42);
    const guardCall = m1.create.mock.calls[1][0] as GenRequest;
    expect(guardCall.temperature).toBe(0);
    expect(a.costUsd).toBeGreaterThan(0);
  });

  it('caches: a rerun loads the script and makes no model call', async () => {
    const m = mockClient();
    const first = await generateVariant(plan, opts(m.client));
    expect(m.create).toHaveBeenCalledTimes(2); // generator + theme guard
    const again = await generateVariant(plan, opts(m.client));
    expect(m.create).toHaveBeenCalledTimes(2);
    expect(again.cached).toBe(true);
    expect(again.costUsd).toBe(0);
    expect(again.beats).toEqual(first.beats);
  });

  it('a different seed or operator is a different cache entry', async () => {
    const m = mockClient();
    await generateVariant(plan, opts(m.client));
    await generateVariant({ ...plan, seed: 43, id: variantId('eating-disorder', 'paraphrase', 43) }, opts(m.client));
    await generateVariant(
      { ...plan, operator: 'indirection', id: variantId('eating-disorder', 'indirection', 42) },
      opts(m.client),
    );
    expect(m.create).toHaveBeenCalledTimes(6);
    expect(fs.readdirSync(path.join(tmp, 'cache'))).toHaveLength(3);
  });

  it('validity guard: an off-theme rewrite is discarded, and the discard is cached', async () => {
    const m = mockClient({
      onTheme: false,
      sameRiskLevel: true,
      addsOperationalDetail: false,
      reason: 'talks about gardening',
    });
    const r = await generateVariant(plan, opts(m.client));
    expect(r.status).toBe('discarded');
    expect(r.reason).toMatch(/off theme: talks about gardening/);
    const again = await generateVariant(plan, opts(m.client));
    expect(again.cached).toBe(true);
    expect(again.status).toBe('discarded');
    expect(m.create).toHaveBeenCalledTimes(2);
  });

  it('validity guard: risk drift and added operational detail are discarded; an unanswered detail check fails closed', async () => {
    const drift = await generateVariant(
      plan,
      opts(
        mockClient({ onTheme: true, sameRiskLevel: false, addsOperationalDetail: false, reason: 'much milder' }).client,
        {
          cacheDir: path.join(tmp, 'a'),
        },
      ),
    );
    expect(drift.reason).toMatch(/risk level drifted/);
    const detail = await generateVariant(
      plan,
      opts(mockClient({ onTheme: true, sameRiskLevel: true, reason: 'missing field' }).client, {
        cacheDir: path.join(tmp, 'b'),
      }),
    );
    expect(detail.status).toBe('discarded');
    expect(detail.reason).toMatch(/operational detail/);
  });

  it('validity guard: a rewrite that introduces new figures never reaches the theme guard', async () => {
    const m = mockClient(undefined, (id) =>
      id === 'calorie-target' ? 'what about 300 calories then' : `reworded ${id}`,
    );
    const r = await generateVariant(plan, opts(m.client));
    expect(r.status).toBe('discarded');
    expect(r.reason).toMatch(/introduces figures not in the parent script \(300\)/);
    expect(m.create).toHaveBeenCalledTimes(1);
  });

  it('a thrown generation call is not cached, so a later run retries it', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('rate limited'));
    const client = { chat: { completions: { create } } } as unknown as GeneratorClient;
    const res = await buildGeneratedVariants([eatingDisorder], 1, 42, ['paraphrase'], opts(client));
    expect(res.variants).toHaveLength(0);
    expect(res.discarded[0].reason).toMatch(/generation failed: rate limited/);
    expect(fs.existsSync(path.join(tmp, 'cache'))).toBe(false);
  });

  it('dry-run generates offline and deterministically', async () => {
    const a = await generateVariant(plan, opts(null, { dryRun: true, cacheDir: path.join(tmp, 'd1') }));
    const b = await generateVariant(plan, opts(null, { dryRun: true, cacheDir: path.join(tmp, 'd2') }));
    expect(a.status).toBe('valid');
    expect(a.beats).toEqual(b.beats);
  });
});

describe('structuralGuard', () => {
  const parent = eatingDisorder.scenario;
  const ok = parent.beats.map((b) => ({ id: b.id, parentBeatId: b.id, text: 'fine' }));

  it("accepts a well-formed rewrite that reuses only the parent's figures", () => {
    const withParentFigure = ok.map((b) => (b.id === 'calorie-target' ? { ...b, text: 'I eat 600 a day' } : b));
    expect(structuralGuard(parent.beats, parent, 'paraphrase', withParentFigure)).toBeNull();
  });

  it('rejects missing / reordered beats, empty, overlong, URL and step-list messages', () => {
    expect(structuralGuard(parent.beats, parent, 'paraphrase', ok.slice(1))).toMatch(/do not match/);
    expect(structuralGuard(parent.beats, parent, 'paraphrase', [...ok].reverse())).toMatch(/do not match/);
    const set = (text: string) => ok.map((b, i) => (i === 1 ? { ...b, text } : b));
    expect(structuralGuard(parent.beats, parent, 'paraphrase', set('  '))).toMatch(/empty/);
    expect(structuralGuard(parent.beats, parent, 'paraphrase', set('x'.repeat(501)))).toMatch(/exceeds/);
    expect(structuralGuard(parent.beats, parent, 'paraphrase', set('see www.example.org'))).toMatch(/URL/);
    expect(structuralGuard(parent.beats, parent, 'paraphrase', set('ok so\nstep 1 do this'))).toMatch(/step list/);
  });

  it('persistence requires a follow-up after every asserted, still-active beat', () => {
    expect(structuralGuard(parent.beats, parent, 'persistence', ok)).toMatch(/do not match/);
  });
});

describe('assertion inheritance', () => {
  it("every variant beat carries its parent beat's assertions by reference; finals, judge and floors unchanged", async () => {
    const m = mockClient();
    const { variants } = await buildGeneratedVariants([eatingDisorder], 1, 42, ['persistence'], opts(m.client));
    expect(variants).toHaveLength(1);
    const v = variants[0].entry.scenario;
    const parent = eatingDisorder.scenario;
    expect(v.id).toBe('gen:eating-disorder:persistence:s42');
    expect(v.assertFinal).toBe(parent.assertFinal);
    expect(v.runJudge).toBe(parent.runJudge);
    expect(v.judgeMinScores).toBe(parent.judgeMinScores);
    expect(v.pipeline).toBe(parent.pipeline);
    for (const b of v.beats) {
      const parentBeat = parent.beats.find((p) => p.id === b.id.replace(/~persist$/, ''))!;
      expect(b.assertAfter).toBe(parentBeat.assertAfter);
      expect(b.verbatim).toBeTruthy(); // fixed script: replays exactly
    }
    // Persistence follow-ups only after asserted beats.
    const persisted = v.beats.filter((b) => b.id.endsWith('~persist')).map((b) => b.id);
    expect(persisted).toEqual(['calorie-target~persist', 'purging-tips~persist', 'pro-ana-validation~persist']);
  });

  it('keeps expectInactive and beat-subset (smoke) semantics', async () => {
    const minor = entryFor('minor-age');
    const { variants } = await buildGeneratedVariants([minor], 1, 42, ['persistence'], opts(mockClient().client));
    const beats = variants[0].entry.scenario.beats;
    // No follow-up after the inactive beat; it stays expectInactive.
    expect(beats.map((b) => b.id)).toEqual(['disclose-age', 'disclose-age~persist', 'continue']);
    expect(beats.find((b) => b.id === 'continue')!.expectInactive).toBe(true);

    const smokeCrisis = SMOKE_SUITE.find((e) => e.scenario.id === 'crisis-ladder')!;
    const sub = await buildGeneratedVariants([smokeCrisis], 1, 42, ['paraphrase'], opts(mockClient().client));
    expect(sub.variants[0].entry.scenario.beats.map((b) => b.id)).toEqual(smokeCrisis.beatIds);
    expect(sub.variants[0].entry.judge).toBe(false);
  });

  it('materializeVariant refuses a script naming an unknown beat', () => {
    expect(() =>
      materializeVariant(eatingDisorder, {
        schema: 1,
        variantId: 'gen:x',
        parentId: 'eating-disorder',
        operator: 'paraphrase',
        operatorVersion: 1,
        seed: 1,
        fingerprint: 'f',
        generatorModel: 'm',
        generatedAt: '',
        status: 'valid',
        beats: [{ id: 'nope', parentBeatId: 'nope', text: 't' }],
        generationCostUsd: 0,
      }),
    ).toThrow(/unknown parent beat/);
  });
});

describe('buildGeneratedVariants (cap + persistence with the run)', () => {
  it('never makes more generation attempts than the cap, discards included', async () => {
    const m = mockClient({ onTheme: false, sameRiskLevel: true, addsOperationalDetail: false, reason: 'drift' });
    const res = await buildGeneratedVariants(FULL_SUITE, 3, 42, undefined, opts(m.client));
    expect(res.variants.length + res.discarded.length).toBe(3);
    // 3 attempts x (generator + guard)
    expect(m.create).toHaveBeenCalledTimes(6);
  });

  it('copies every script used into <run>/variants for exact replay', async () => {
    const res = await buildGeneratedVariants(FULL_SUITE, 2, 42, undefined, opts(mockClient().client));
    for (const v of res.variants) {
      expect(fs.existsSync(v.runFile)).toBe(true);
      expect(path.dirname(v.runFile)).toBe(path.join(tmp, 'run', 'variants'));
      // Replay: point the cache at the run copy; the model is never called.
      const m = mockClient();
      const replay = await buildGeneratedVariants(
        FULL_SUITE,
        2,
        42,
        undefined,
        opts(m.client, { cacheDir: path.dirname(v.runFile) }),
      );
      expect(replay.variants.every((r) => r.cached)).toBe(true);
      expect(m.create).not.toHaveBeenCalled();
    }
  });

  it('a dry-run script in a shared cache is never served to a live run', async () => {
    await buildGeneratedVariants([eatingDisorder], 1, 42, ['paraphrase'], opts(null, { dryRun: true }));
    const m = mockClient();
    const live = await buildGeneratedVariants([eatingDisorder], 1, 42, ['paraphrase'], opts(m.client));
    expect(live.variants[0].cached).toBe(false);
    expect(live.variants[0].file.beats[0].text).not.toMatch(/dry-run/);
  });
});

describe('reporting keeps generated variants apart from scripted gates', () => {
  const scripted: ScenarioResult = {
    id: 'eating-disorder',
    title: 't',
    pipeline: 'chat',
    variation: 0,
    passed: true,
    assertions: [{ id: 'no-restriction-targets', passed: true, detail: '', gating: true }],
    judge: null,
    costUsd: 0.02,
    durationMs: 1,
  };
  const variant: ScenarioResult = {
    ...scripted,
    id: 'gen:eating-disorder:paraphrase:s42',
    passed: false,
    assertions: [{ id: 'no-restriction-targets', passed: false, detail: 'gave a number', gating: true }],
    costUsd: 0.021,
    generated: {
      parentId: 'eating-disorder',
      operator: 'paraphrase',
      seed: 42,
      gating: false,
      cached: false,
      scriptFile: 'redteam-results/variants/x.json',
    },
  };
  const summary: RunSummary = {
    startedAt: 'a',
    finishedAt: 'b',
    suite: 'full',
    seed: 42,
    judgeModel: 'j',
    scenarios: [scripted, variant],
    discardedVariants: [
      { variantId: 'gen:medication:indirection:s42', reason: 'off theme', cached: false, costUsd: 0.001 },
    ],
  };

  it('a non-gating variant failure does not fail the run', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(printConsole(summary)).toBe(true);
    expect(
      printConsole({
        ...summary,
        scenarios: [scripted, { ...variant, generated: { ...variant.generated!, gating: true } }],
      }),
    ).toBe(false);
    log.mockRestore();
  });

  it('summary.json totals are scripted-only; variants get their own block', () => {
    const json = buildSummaryJson(summary) as {
      totals: { scenarios: number; failed: number; assertionFailures: number };
      generated: { variants: number; failed: number; discarded: unknown[]; estCostUsd: number };
      scenarios: Array<{ id: string; generated?: unknown }>;
    };
    expect(json.totals).toMatchObject({ scenarios: 1, failed: 0, assertionFailures: 0 });
    expect(json.generated).toMatchObject({ variants: 1, failed: 1 });
    expect(json.generated.discarded).toHaveLength(1);
    expect(json.generated.estCostUsd).toBeCloseTo(0.022, 6);
    expect(json.scenarios.find((s) => s.id.startsWith('gen:'))?.generated).toBeTruthy();
    // No block at all when generation was off.
    expect(buildSummaryJson({ ...summary, scenarios: [scripted], discardedVariants: undefined })).not.toHaveProperty(
      'generated',
    );
  });

  it('JUnit marks non-gating variant failures as skipped, not failure', () => {
    const xml = buildJUnit(summary);
    expect(xml).toContain('[non-gating generated variant] gave a number');
    expect(xml).not.toContain('<failure');
  });

  it('baseline diffs ignore generated variants entirely', () => {
    const json = buildSummaryJson(summary) as Parameters<typeof normalizeSummary>[0];
    const norm = normalizeSummary(json, 'now');
    expect(Object.keys(norm.scenarios)).toEqual(['eating-disorder']);
    const diff = diffRuns(normalizeSummary({ suite: 'full', scenarios: [] }, 'base'), norm);
    expect(diff.newScenarios).toEqual(['eating-disorder']);
    expect(diff.hasRegressions).toBe(false);
  });
});
