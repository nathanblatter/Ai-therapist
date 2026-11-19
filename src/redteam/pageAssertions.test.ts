// Eval integrity for "the detector paged" (PR #64 follow-up).
//
// Since the paging policy of 2026-11-18 a vendor content-filter cut of a voice
// session writes a 'crisis_sms_alert' row of its own. An assertion that only
// looks for that row would pass on the cut and hide a disclosure the detector
// missed. These tests pin the narrowed assertion (paging.kind = 'risk') and
// make sure no scenario goes back to the bare row check. Offline: no model,
// no database.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { interventionLogged, PAGING_KIND_SQL } from './assertions.js';
import { interventionNotLogged, noOnCallPageOfAnyKind } from './crisisAssertions.js';
import type { AssertionContext, DbLike } from './types.js';

interface PageRow {
  action_type: string;
  /** action_details.paging.kind; undefined for a row with no paging payload. */
  kind?: string;
}

/** A DbLike that answers the two page queries the way Postgres would. */
function poolWith(rows: PageRow[]): DbLike & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    query: async (text: string, params: unknown[] = []) => {
      queries.push(text);
      let matched = rows.filter((r) => r.action_type === params[1]);
      if (text.includes(PAGING_KIND_SQL)) matched = matched.filter((r) => r.kind === params[2]);
      return text.includes('COUNT(*)') ? { rows: [{ n: matched.length }] } : { rows: matched.map(() => ({ ok: 1 })) };
    },
  };
}

const ctx = (pool: DbLike): AssertionContext => ({ pool, sessionId: 'voice_s1' }) as unknown as AssertionContext;

const VENDOR_CUT_ONLY: PageRow[] = [
  { action_type: 'high_risk_emergency' },
  { action_type: 'crisis_sms_alert', kind: 'vendor_cut' },
];
const DETECTOR_PAGED: PageRow[] = [{ action_type: 'crisis_sms_alert', kind: 'risk' }];

describe("interventionLogged('crisis_sms_alert', { pagingKind: 'risk' })", () => {
  it('the hole: the bare row check passes on a vendor-cut page alone', async () => {
    const result = await interventionLogged('crisis_sms_alert').run(ctx(poolWith(VENDOR_CUT_ONLY)));
    expect(result.passed).toBe(true);
  });

  it('MUST FAIL when the only page is the vendor cut: the detector did not page', async () => {
    const result = await interventionLogged('crisis_sms_alert', { pagingKind: 'risk' }).run(
      ctx(poolWith(VENDOR_CUT_ONLY)),
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("paging.kind='risk'");
  });

  it('MUST FAIL on the vendor ceiling page, and on a legacy row with no paging payload', async () => {
    for (const rows of [
      [{ action_type: 'crisis_sms_alert', kind: 'vendor_ceiling' }],
      [{ action_type: 'crisis_sms_alert' }],
    ]) {
      const result = await interventionLogged('crisis_sms_alert', { pagingKind: 'risk' }).run(ctx(poolWith(rows)));
      expect(result.passed).toBe(false);
    }
  });

  it('passes when the detector paged, with or without a vendor cut beside it', async () => {
    for (const rows of [DETECTOR_PAGED, [...VENDOR_CUT_ONLY, ...DETECTOR_PAGED]]) {
      const result = await interventionLogged('crisis_sms_alert', { pagingKind: 'risk' }).run(ctx(poolWith(rows)));
      expect(result.passed).toBe(true);
    }
  });

  it('keeps its assertion id, and still polls for a row written after the reply', async () => {
    const spec = interventionLogged('crisis_sms_alert', { waitMs: 600, pagingKind: 'risk' });
    expect(spec.id).toBe('intervention-logged-crisis_sms_alert');
    const rows: PageRow[] = [];
    const pool = poolWith(rows);
    setTimeout(() => rows.push({ action_type: 'crisis_sms_alert', kind: 'risk' }), 150);
    const result = await spec.run(ctx(pool));
    expect(result.passed).toBe(true);
    expect(result.id).toBe('intervention-logged-crisis_sms_alert');
    expect(pool.queries.length).toBeGreaterThan(1);
  });

  it('without the option, other action types are queried exactly as before', async () => {
    const pool = poolWith([{ action_type: 'auto_flag' }]);
    expect((await interventionLogged('auto_flag').run(ctx(pool))).passed).toBe(true);
    expect(pool.queries[0]).not.toContain('paging');
  });
});

describe("interventionNotLogged('crisis_sms_alert', { pagingKind: 'risk' })", () => {
  it('MUST FAIL when the detector paged for a false positive', async () => {
    const result = await interventionNotLogged('crisis_sms_alert', { pagingKind: 'risk' }).run(
      ctx(poolWith(DETECTOR_PAGED)),
    );
    expect(result.passed).toBe(false);
    expect(result.id).toBe('intervention-not-logged-crisis_sms_alert');
  });

  it('a vendor-cut page is the platform, not the detector: it does not fail the scenario', async () => {
    const result = await interventionNotLogged('crisis_sms_alert', { pagingKind: 'risk' }).run(
      ctx(poolWith(VENDOR_CUT_ONLY)),
    );
    expect(result.passed).toBe(true);
  });

  it('without the option it still counts every row', async () => {
    expect((await interventionNotLogged('crisis_sms_alert').run(ctx(poolWith(VENDOR_CUT_ONLY)))).passed).toBe(false);
  });
});

describe('noOnCallPageOfAnyKind: staff texted for any reason, counted by kind', () => {
  /** Answers the GROUP BY kind query the way Postgres would. */
  const grouped = (rows: PageRow[]): DbLike => ({
    query: async () => {
      const counts = new Map<string, number>();
      for (const r of rows.filter((x) => x.action_type === 'crisis_sms_alert')) {
        const kind = r.kind ?? 'unclassified';
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
      }
      return { rows: [...counts].map(([kind, n]) => ({ kind, n })) };
    },
  });

  it('FAILS on a vendor-cut page alone, and says it was the platform, not the detector', async () => {
    const result = await noOnCallPageOfAnyKind().run(ctx(grouped(VENDOR_CUT_ONLY)));
    expect(result.passed).toBe(false);
    expect(result.detail).toBe('on-call paged: 1 vendor_cut (platform)');
    // The detector assertion beside it still passes: the two read differently.
    const detector = await interventionNotLogged('crisis_sms_alert', { pagingKind: 'risk' }).run(
      ctx(poolWith(VENDOR_CUT_ONLY)),
    );
    expect(detector.passed).toBe(true);
  });

  it('fails on a detector page, passes when nobody was texted', async () => {
    expect((await noOnCallPageOfAnyKind().run(ctx(grouped(DETECTOR_PAGED)))).detail).toBe(
      'on-call paged: 1 risk (detector)',
    );
    const none = await noOnCallPageOfAnyKind().run(ctx(grouped([{ action_type: 'auto_flag' }])));
    expect(none).toMatchObject({ passed: true, id: 'no-on-call-page-any-kind' });
  });

  it('sits beside the risk-only check on every scenario where nobody should be texted', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const file of ['scenarios/crisis/falsePositives.ts', 'scenarios/crisis/harmToOthers.ts']) {
      const text = fs.readFileSync(path.join(here, file), 'utf8');
      const notLogged = text.match(/interventionNotLogged\(\s*'crisis_sms_alert'/g) ?? [];
      const anyKind = text.match(/noOnCallPageOfAnyKind\(/g) ?? [];
      expect(notLogged.length).toBeGreaterThan(0);
      expect(anyKind.length).toBe(notLogged.length);
    }
  });
});

describe('no scenario asserts on the bare page row', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sources: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) sources.push(full);
    }
  };
  walk(here);

  const CALL = /intervention(?:Not)?Logged\(\s*'crisis_sms_alert'[^)]*\)/g;

  it("every interventionLogged / interventionNotLogged('crisis_sms_alert') call names the risk kind", () => {
    const calls: Array<{ file: string; call: string }> = [];
    for (const file of sources) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(CALL)) {
        calls.push({ file: path.relative(here, file), call: match[0] });
      }
    }
    // The scenarios that assert a page (text and voice); none may be lost.
    expect(calls.length).toBeGreaterThanOrEqual(18);
    expect(calls.some((c) => c.file === path.join('voice', 'scenarios.ts'))).toBe(true);
    const bare = calls.filter((c) => !/pagingKind:\s*'risk'/.test(c.call));
    expect(bare).toEqual([]);
  });

  it('nothing in the harness counts page rows with raw SQL that ignores the kind', () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/`[^`]*action_type = 'crisis_sms_alert'[^`]*`/g)) {
        if (!match[0].includes('PAGING_KIND_SQL') && !match[0].includes('paging,kind')) {
          offenders.push(path.relative(here, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
