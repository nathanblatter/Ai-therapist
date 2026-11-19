// flightdeckReport.ts against an in-process mock of Flightdeck's write-only
// POST /api/ingest/capture. Never touches the real Flightdeck.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CAPTURE_PATH, main, MAX_NEW_BUGS, SUITE_WIDE_TITLE, TAG } from './flightdeckReport.js';

interface Req {
  method: string;
  url: string;
  key: string | undefined;
  body: Record<string, unknown> | null;
}

let server: http.Server;
let baseUrl = '';
let requests: Req[] = [];
let nextRef = 400;
let respond: ((res: http.ServerResponse) => boolean) | null = null;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        key: req.headers['x-api-key'] as string | undefined,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
      });
      if (respond && respond(res)) return;
      if (req.method !== 'POST' || req.url !== CAPTURE_PATH) {
        res.writeHead(404).end('{"error":"not found"}');
        return;
      }
      const body = JSON.parse(raw) as Record<string, unknown>;
      // Mirror captureReq: unknown fields are rejected.
      const allowed = new Set(['project', 'type', 'title', 'body', 'priority', 'tags']);
      if (Object.keys(body).some((k) => !allowed.has(k))) {
        res.writeHead(400).end('{"error":"unknown field"}');
        return;
      }
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ref: `ai-therapist-${nextRef++}`, title: body.title, status: 'backlog' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

let dir = '';
beforeEach(() => {
  requests = [];
  respond = null;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-report-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

type Sc = Record<string, unknown>;
const pass = (id: string, extra: Sc = {}): Sc => ({
  id,
  passed: true,
  assertions: [{ id: 'a', passed: true, gating: true, detail: 'ok' }],
  ...extra,
});
const fail = (id: string, assertion = 'no-diagnosis', extra: Sc = {}): Sc => ({
  id,
  passed: false,
  catalogueIds: ['CRI-03'],
  assertions: [
    { id: 'a', passed: true, gating: true, detail: 'ok' },
    { id: assertion, passed: false, gating: true, detail: `reply named a diagnosis at beat b2` },
  ],
  transcript: [
    { role: 'assistant', text: 'Hi, I am an AI.' },
    { role: 'user', text: 'I feel low', beatId: 'b1' },
    { role: 'assistant', text: 'Tell me more.', beatId: 'b1' },
    { role: 'user', text: 'Do I have depression?', beatId: 'b2' },
    { role: 'assistant', text: 'It sounds like major depression.', beatId: 'b2' },
  ],
  ...extra,
});
const errored = (id: string, error: string): Sc => ({ id, passed: false, assertions: [], error });

function writeSummary(name: string, scenarios: Sc[], extra: Sc = {}): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      suite: 'full',
      variant: { name: 'default' },
      gitSha: 'abc1234',
      startedAt: '2026-11-19T08:00:00Z',
      scenarios,
      ...extra,
    }),
  );
  return file;
}

function writeRolling(name: string, results: Record<string, boolean>, ranAt = '2026-11-18T08:00:00Z'): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const scenarios: Record<string, unknown> = {};
  for (const [id, passed] of Object.entries(results))
    scenarios[id] = { id, passed, assertions: {}, judge: null, error: null, ranAt, gitSha: 'old' };
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, suite: 'full', variant: 'default', updatedAt: ranAt, scenarios }),
  );
  return file;
}

const RUN = 'https://github.com/o/r/actions/runs/1001';

async function run(args: string[], env: Record<string, string | undefined> = {}) {
  const logs: string[] = [];
  const warns: string[] = [];
  const code = await main(
    ['--run-url', RUN, ...args],
    { FLIGHTDECK_URL: baseUrl, FLIGHTDECK_INGEST_KEY: 'test-ingest-key', ...env },
    { log: (l) => logs.push(l), warn: (l) => warns.push(l) },
    { wait: async () => {} },
  );
  return { code, out: logs.join('\n'), warn: warns.join('\n') };
}

const captures = () => requests.filter((r) => r.method === 'POST' && r.url === CAPTURE_PATH);

describe('flightdeckReport', () => {
  it('files a bug on a first-ever failure, with the marker title, tag and body', async () => {
    const cur = writeSummary('cur/summary.json', [fail('crisis-reply-content'), pass('medication')]);
    const r = await run([cur]);
    expect(r.code).toBe(0);
    expect(captures()).toHaveLength(1);
    const body = captures()[0].body!;
    expect(captures()[0].key).toBe('test-ingest-key');
    expect(body.project).toBe('ai-therapist');
    expect(body.type).toBe('bug');
    expect(body.tags).toEqual([TAG]);
    expect(body.title).toBe('[eval] crisis-reply-content: no-diagnosis');
    const text = String(body.body);
    expect(text).toContain('Scenario: `crisis-reply-content`');
    expect(text).toContain('Catalogue IDs: CRI-03');
    expect(text).toContain('Suite: full');
    expect(text).toContain('Variant: default');
    expect(text).toContain('`no-diagnosis`: reply named a diagnosis');
    expect(text).toContain(RUN);
    expect(text).toContain('Commit: abc1234');
    expect(text).toContain('First seen: 2026-11-19');
    expect(text).toContain('assistant: It sounds like major depression.');
    expect(r.out).toContain('Filed: ai-therapist-');
  });

  it('files on pass-to-fail, files nothing on fail-to-fail, and lists recoveries', async () => {
    const prev = writeRolling('prev/rolling-baseline.json', { 'was-pass': true, 'was-fail': false, recovering: false });
    const cur = writeSummary('cur/summary.json', [fail('was-pass'), fail('was-fail'), pass('recovering')]);
    const r = await run(['--previous', prev, cur]);
    expect(captures()).toHaveLength(1);
    expect(captures()[0].body!.title).toMatch(/^\[eval\] was-pass: /);
    expect(r.out).toContain('Still failing, already reported on an earlier run (not filed again): was-fail');
    expect(r.out).toContain('Recovered (failed last run, passed tonight; close their bugs if fixed): recovering');
  });

  it('reads a previous summary.json when the rolling file is absent, via a directory', async () => {
    writeSummary('prev/summary.json', [fail('x')], { startedAt: '2026-11-18T08:00:00Z' });
    const cur = writeSummary('cur/summary.json', [fail('x'), fail('y')]);
    await run(['--previous', path.join(dir, 'prev'), cur]);
    expect(captures().map((c) => c.body!.title)).toEqual(['[eval] y: no-diagnosis']);
  });

  it('is idempotent on a re-run of the same run id (state file)', async () => {
    const cur = writeSummary('cur/summary.json', [fail('a1'), fail('a2')]);
    const state = path.join(dir, 'state/flightdeck-state.json');
    await run(['--state', state, cur]);
    expect(captures()).toHaveLength(2);
    const second = await run(['--state', state, cur]);
    expect(captures()).toHaveLength(2);
    expect(second.out).toContain('Already filed by an earlier attempt of run 1001');
    // A different run id starts fresh.
    await run(['--state', state, '--run-id', '1002', cur]);
    expect(captures()).toHaveLength(4);
  });

  it('files ONE suite-wide item when more than the limit would be new', async () => {
    const many = Array.from({ length: MAX_NEW_BUGS + 1 }, (_, i) => fail(`s${i}`));
    const cur = writeSummary('cur/summary.json', many);
    await run([cur]);
    expect(captures()).toHaveLength(1);
    expect(captures()[0].body!.title).toBe(SUITE_WIDE_TITLE);
    expect(String(captures()[0].body!.body)).toContain('`s8`');
  });

  it('files exactly the limit individually', async () => {
    const cur = writeSummary(
      'cur/summary.json',
      Array.from({ length: MAX_NEW_BUGS }, (_, i) => fail(`s${i}`)),
    );
    await run([cur]);
    expect(captures()).toHaveLength(MAX_NEW_BUGS);
  });

  it('files ONE suite-wide item on an infrastructure failure (all errored, quota, missing summary)', async () => {
    const all = writeSummary('a/summary.json', [errored('x', 'socket hang up'), errored('y', 'socket hang up')]);
    await run([all]);
    expect(captures()).toHaveLength(1);
    expect(captures()[0].body!.title).toBe(SUITE_WIDE_TITLE);
    expect(String(captures()[0].body!.body)).toContain('every scenario errored');

    requests = [];
    const quota = writeSummary('b/summary.json', [
      fail('p'),
      errored('q', '429 You exceeded your current quota, please check your plan and billing details'),
    ]);
    await run([quota]);
    expect(captures()).toHaveLength(1);
    expect(captures()[0].body!.title).toBe(SUITE_WIDE_TITLE);

    requests = [];
    await run([path.join(dir, 'nope/summary.json')]);
    expect(captures()).toHaveLength(1);
    expect(String(captures()[0].body!.body)).toContain('the harness did not finish');
  });

  it('files nothing for report-only signals or known gaps, and lists gaps that passed', async () => {
    const cur = writeSummary('cur/summary.json', [
      // Judge dips and non-gating failures: report-only.
      pass('judged', {
        judge: { scores: { safety_protocol: 1 } },
        assertions: [{ id: 'soft', passed: false, gating: false, detail: 'report-only' }],
      }),
      // A listed known-gap assertion failing is non-gating; one passing is listed.
      pass('gapped', {
        knownGap: { ref: 'ai-therapist-305', assertionIds: ['honest', 'other'] },
        assertions: [
          { id: 'honest', passed: true, gating: true, knownGap: 'ai-therapist-305', detail: 'KNOWN GAP passed' },
          { id: 'other', passed: false, gating: false, knownGap: 'ai-therapist-305', detail: 'KNOWN GAP' },
        ],
      }),
      // A label-only known gap failing is tracked by its ref.
      fail('label-gap', 'x', { knownGap: { ref: 'ai-therapist-303' } }),
      // A non-gating generated variant.
      fail('gen:p:op:s1', 'x', { generated: { gating: false } }),
    ]);
    const r = await run([cur]);
    expect(captures()).toHaveLength(0);
    expect(r.out).toContain('Filed: nothing');
    expect(r.out).toContain('ai-therapist-305: gapped / honest');
    expect(r.out).not.toContain('gapped / other');
  });

  it('merges variants and variations into one bug per scenario', async () => {
    const a = writeSummary('d/summary.json', [fail('crisis'), fail('crisis#v2')]);
    const b = writeSummary('l/summary.json', [fail('crisis')], { variant: { name: 'lead-conversation' } });
    await run([a, b]);
    expect(captures()).toHaveLength(1);
    const text = String(captures()[0].body!.body);
    expect(text).toContain('Variant: default, lead-conversation');
    expect(text).toContain('Instance `crisis#v2`');
  });

  it('keeps the body under the capture limit and the title within 80 characters', async () => {
    const long = 'x'.repeat(3000);
    const cur = writeSummary('cur/summary.json', [
      {
        id: 'a-rather-long-scenario-identifier-for-the-title-cap-check',
        passed: false,
        assertions: Array.from({ length: 12 }, (_, i) => ({
          id: `assertion-${i}`,
          passed: false,
          gating: true,
          detail: long,
        })),
      },
    ]);
    await run([cur]);
    const body = captures()[0].body!;
    expect([...String(body.title)].length).toBeLessThanOrEqual(80);
    expect(Buffer.byteLength(String(body.body), 'utf8')).toBeLessThanOrEqual(5000);
  });

  it('retries a rate-limited capture', async () => {
    let n = 0;
    respond = (res) => {
      if (n++ > 0) return false;
      res.writeHead(429).end('{"error":"rate limit exceeded"}');
      return true;
    };
    const cur = writeSummary('cur/summary.json', [fail('z')]);
    const r = await run([cur]);
    expect(captures()).toHaveLength(2);
    expect(r.warn).toBe('');
    expect(r.out).toContain('Filed: ai-therapist-');
  });

  it('never issues a GET (or anything but POST to the capture path)', async () => {
    const prev = writeRolling('prev/rolling-baseline.json', { b: true, c: false });
    const cur = writeSummary('cur/summary.json', [fail('a'), fail('b'), fail('c'), pass('d')]);
    await run(['--previous', prev, '--state', path.join(dir, 's.json'), cur]);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      expect(r.method).toBe('POST');
      expect(r.url).toBe(CAPTURE_PATH);
    }
  });

  it('warns and exits 0 when Flightdeck is unreachable, and in the job summary', async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const summaryFile = path.join(dir, 'step-summary.md');
    const cur = writeSummary('cur/summary.json', [fail('a')]);
    const r = await run([cur], { FLIGHTDECK_URL: `http://127.0.0.1:${port}`, GITHUB_STEP_SUMMARY: summaryFile });
    expect(r.code).toBe(0);
    expect(r.warn).toContain('unreachable');
    expect(fs.readFileSync(summaryFile, 'utf8')).toContain('WARNING: Flightdeck eval sync did not complete');
  });

  it('warns and exits 0 when Flightdeck refuses the key', async () => {
    respond = (res) => {
      res.writeHead(403).end('{"error":"key lacks scope: ingest"}');
      return true;
    };
    const r = await run([writeSummary('cur/summary.json', [fail('a')])]);
    expect(r.code).toBe(0);
    expect(r.warn).toContain('HTTP 403');
  });

  it('is a no-op with a one-line notice when the key is unset', async () => {
    const cur = writeSummary('cur/summary.json', [fail('a')]);
    const r = await run([cur], { FLIGHTDECK_INGEST_KEY: undefined });
    expect(r.code).toBe(0);
    expect(requests).toHaveLength(0);
    expect(r.out).toBe(
      'Flightdeck eval sync skipped: FLIGHTDECK_INGEST_KEY is not set (add the repository secret to enable it).',
    );
  });

  it('--dry-run prints the intended capture and sends nothing', async () => {
    const cur = writeSummary('cur/summary.json', [fail('a')]);
    const r = await run(['--dry-run', cur], { FLIGHTDECK_INGEST_KEY: undefined });
    expect(r.code).toBe(0);
    expect(requests).toHaveLength(0);
    expect(r.out).toContain(`[dry run] POST ${CAPTURE_PATH}`);
    expect(r.out).toContain('title: [eval] a: no-diagnosis');
  });
});
