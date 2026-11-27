// Shadow risk scorer service: the two switches (default off), what one row
// records, and that every failure ends in an errored row or a dropped turn,
// never in a throw. The pipeline-level proof that it cannot change what the
// pipeline does is in crisisPipeline.shadowScorer.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  shadowScoreTurn,
  startShadowRiskScorer,
  parseShadowConfig,
  errorCodeFor,
  DEFAULT_SHADOW_CONFIG,
  SHADOW_MAX_IN_FLIGHT,
  _resetShadowScorerForTests,
  _settleShadowScorerForTests,
  _shadowInFlightForTests,
  type ShadowTurn,
} from './shadowRiskScorer.service.js';
import { SHADOW_PREDICATE_NAMES, ShadowAnswerError } from './shadowRiskQuestions.js';
import type { ShadowRiskScoreInsert } from '../db/shadowRisk.queries.js';

const SECRET = 'I have been thinking about ending it, my name is Jordan Example';

const TURN: ShadowTurn = {
  sessionId: 'sess_abcdefghijklmnop',
  messageId: 42,
  content: SECRET,
  history: [{ role: 'assistant', content: 'How are you feeling tonight?' }],
  productionScore: 30,
  productionSeverity: 'low',
};

function answer(band: 'none' | 'low' | 'medium' | 'high', refuse: string[] = []) {
  const p = { none: 0.01, low: 0.01, medium: 0.01, high: 0.01, [band]: 0.97 };
  return {
    model: 'gpt-6-luna',
    answers: [
      refuse.includes('severity')
        ? { type: 'refusal', name: 'severity' }
        : {
            type: 'score',
            name: 'severity',
            score: 3,
            confidence: 0.97,
            probabilities: (['none', 'low', 'medium', 'high'] as const).map((label, value) => ({
              label,
              value,
              probability: p[label],
            })),
          },
      ...SHADOW_PREDICATE_NAMES.map((name) =>
        refuse.includes(name) ? { type: 'refusal', name } : { type: 'predicate', name, probability: 0.02 },
      ),
    ],
    usage: { input_tokens: 3100, output_tokens: 0 },
  };
}

const create = vi.fn();
const insert = vi.fn<(row: ShadowRiskScoreInsert) => Promise<void>>();
const readConfig = vi.fn();

function arm(overrides: Record<string, unknown> = {}, start = true): void {
  _resetShadowScorerForTests(
    { readConfig, getClient: async () => ({ decisions: { create } }), insert, timeoutMs: 50, ...overrides },
    start,
  );
}

async function score(turn: ShadowTurn = TURN): Promise<void> {
  expect(shadowScoreTurn(turn)).toBeUndefined();
  await _settleShadowScorerForTests();
}

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue(answer('high'));
  insert.mockReset();
  insert.mockResolvedValue(undefined);
  readConfig.mockReset();
  readConfig.mockResolvedValue({ enabled: true });
  arm();
});

describe('the switch', () => {
  it('is off in code', () => {
    expect(DEFAULT_SHADOW_CONFIG).toEqual({ enabled: false });
  });

  it.each([[undefined], [null], [{}], [{ enabled: false }], [{ enabled: 'true' }], [{ enabled: 1 }], ['true'], [true]])(
    'config %j is off',
    (value) => {
      expect(parseShadowConfig(value).enabled).toBe(false);
    },
  );

  it('only a literal enabled: true is on', () => {
    expect(parseShadowConfig({ enabled: true }).enabled).toBe(true);
  });

  it('no config row: nothing is sent and nothing is stored', async () => {
    readConfig.mockResolvedValue(undefined);
    await score();
    expect(create).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('an unreadable config is off, and is not re-read for every turn', async () => {
    readConfig.mockRejectedValue(new Error('db down'));
    await score();
    await score();
    await score();
    expect(readConfig).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('enabled in config but the server never started it (a script, a harness): nothing happens', async () => {
    arm({}, false);
    await score();
    expect(readConfig).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    startShadowRiskScorer();
    await score();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('reads the config once for many turns', async () => {
    for (let i = 0; i < 5; i++) await score();
    expect(readConfig).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(5);
  });

  it('an empty turn is not sent', async () => {
    await score({ ...TURN, content: '   ' });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('the row', () => {
  it('records the production verdict beside the shadow answers, and no message text', async () => {
    await score();
    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0][0];
    expect(row).toMatchObject({
      sessionId: TURN.sessionId,
      messageId: 42,
      turnSource: 'message',
      productionScore: 30,
      productionSeverity: 'low',
      status: 'scored',
      shadowSeverity: 'high',
      refusedQuestions: [],
      errorCode: null,
      model: 'gpt-6-luna',
      questionSetVersion: 1,
      tokensIn: 3100,
      tokensOut: 0,
    });
    expect(row.severityProbabilities?.high).toBe(0.97);
    expect(Object.keys(row.predicates ?? {})).toHaveLength(8);
    expect(typeof row.latencyMs).toBe('number');
    const stored = JSON.stringify(row);
    expect(stored).not.toContain('Jordan');
    expect(stored).not.toContain('ending it');
    expect(stored).not.toContain('feeling tonight');
  });

  it('sends the turn with the history it was given', async () => {
    await score();
    const body = create.mock.calls[0][0] as { input: string; model: string };
    expect(body.model).toBe('gpt-6-luna');
    expect(body.input).toContain('Assistant: How are you feeling tonight?');
    expect(body.input).toContain(`Latest participant message:\n"${SECRET}"`);
  });

  it('a check-in turn has no message id; an in-memory stand-in id is not stored as one', async () => {
    await score({ ...TURN, messageId: null, source: 'checkin' });
    await score({ ...TURN, messageId: 'mem:3' });
    await score({ ...TURN, messageId: '1234' });
    expect(insert.mock.calls.map((c) => [c[0].messageId, c[0].turnSource])).toEqual([
      [null, 'checkin'],
      [null, 'message'],
      [1234, 'message'],
    ]);
  });

  it('a production severity outside the four bands is not recorded at all', async () => {
    await score({ ...TURN, productionSeverity: 'critical' });
    expect(create).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('failures are recorded as unknown, never as none, and never thrown', () => {
  it('an API error: errored row with a status code, not the error text', async () => {
    create.mockRejectedValue(Object.assign(new Error(`bad request echoing ${SECRET}`), { status: 400 }));
    await score();
    const row = insert.mock.calls[0][0];
    expect(row).toMatchObject({ status: 'errored', shadowSeverity: null, errorCode: 'http_400', predicates: null });
    expect(JSON.stringify(row)).not.toContain('Jordan');
  });

  it('an outage (network error): errored row', async () => {
    create.mockRejectedValue(new Error('ECONNREFUSED'));
    await score();
    expect(insert.mock.calls[0][0]).toMatchObject({ status: 'errored', errorCode: 'error' });
  });

  it('a call that never answers: its own deadline ends it, errored as timeout', async () => {
    create.mockReturnValue(new Promise(() => undefined));
    await score();
    expect(insert.mock.calls[0][0]).toMatchObject({ status: 'errored', errorCode: 'timeout', shadowSeverity: null });
    expect(_shadowInFlightForTests()).toBe(0);
  });

  it('a refused predicate: errored, the severity that did come back is kept but the row is not "scored"', async () => {
    create.mockResolvedValue(answer('high', ['self_harm_without_intent']));
    await score();
    const row = insert.mock.calls[0][0];
    expect(row).toMatchObject({
      status: 'errored',
      errorCode: 'refused',
      refusedQuestions: ['self_harm_without_intent'],
      shadowSeverity: 'high',
    });
    expect(row.predicates).not.toHaveProperty('self_harm_without_intent');
  });

  it('a refused severity: errored with no severity', async () => {
    create.mockResolvedValue(answer('none', ['severity']));
    await score();
    expect(insert.mock.calls[0][0]).toMatchObject({
      status: 'errored',
      errorCode: 'refused',
      shadowSeverity: null,
      severityProbabilities: null,
    });
  });

  it('a malformed answer: errored', async () => {
    create.mockResolvedValue({ answers: [] });
    await score();
    expect(insert.mock.calls[0][0]).toMatchObject({ status: 'errored', errorCode: 'malformed' });
  });

  it('no API key: errored, nothing thrown', async () => {
    arm({
      getClient: async () => {
        throw new Error('OPENAI_API_KEY environment variable is not set');
      },
    });
    await score();
    expect(insert.mock.calls[0][0]).toMatchObject({ status: 'errored', errorCode: 'no_key' });
  });

  it('the insert failing is swallowed', async () => {
    insert.mockRejectedValue(new Error('relation "shadow_risk_scores" does not exist'));
    await score();
    expect(insert).toHaveBeenCalledTimes(1);
    expect(_shadowInFlightForTests()).toBe(0);
  });

  it('dependencies that throw synchronously are swallowed too', async () => {
    arm({
      readConfig: () => {
        throw new Error('sync config failure');
      },
    });
    await score();
    create.mockImplementation(() => {
      throw new Error('sync client failure');
    });
    arm();
    await score();
    expect(insert.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'errored' });
  });

  it('error codes come from a fixed vocabulary', () => {
    expect(errorCodeFor(new ShadowAnswerError('x'))).toBe('malformed');
    expect(errorCodeFor({ status: 429, message: SECRET })).toBe('http_429');
    expect(errorCodeFor({ name: 'APIConnectionTimeoutError' })).toBe('timeout');
    expect(errorCodeFor(new Error(SECRET))).toBe('error');
    expect(errorCodeFor(undefined)).toBe('error');
  });
});

describe('back-pressure', () => {
  it(`keeps at most ${SHADOW_MAX_IN_FLIGHT} turns in flight and drops the rest without sending them`, async () => {
    let release: (v: unknown) => void = () => undefined;
    create.mockReturnValue(new Promise((resolve) => (release = resolve)));
    arm({ timeoutMs: 5000 });
    for (let i = 0; i < SHADOW_MAX_IN_FLIGHT + 6; i++) shadowScoreTurn({ ...TURN, messageId: i + 1 });
    expect(_shadowInFlightForTests()).toBe(SHADOW_MAX_IN_FLIGHT);
    release(answer('none'));
    await _settleShadowScorerForTests();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(create.mock.calls.length).toBeLessThanOrEqual(SHADOW_MAX_IN_FLIGHT);
    // Review of PR #152: a dropped turn used to leave only a log counter, so
    // the report's totals shrank silently during an outage. Each of the six
    // dropped turns now has an errored row with code "busy" and no vendor call.
    const busy = insert.mock.calls.map(([row]) => row).filter((row) => row.errorCode === 'busy');
    expect(busy).toHaveLength(6);
    for (const row of busy) expect(row).toMatchObject({ status: 'errored', shadowSeverity: null, tokensIn: null });
  });
});

// Review of PR #152: sandbox sessions ran the pipeline, so every turn made a
// paid call whose row the report then hid.
describe('sessions out of scope', () => {
  it('a sandbox or demo session is never sent and never stored, and is asked about once', async () => {
    const inScope = vi.fn(async () => false);
    arm({ inScope });
    await score();
    await score({ ...TURN, messageId: 99 });
    expect(create).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(inScope).toHaveBeenCalledTimes(1);
  });

  it('an unreadable scope skips the turn and is asked again on the next one', async () => {
    const inScope = vi.fn<(id: string) => Promise<boolean>>().mockRejectedValueOnce(new Error('db down'));
    inScope.mockResolvedValue(true);
    arm({ inScope });
    await score();
    expect(create).not.toHaveBeenCalled();
    await score({ ...TURN, messageId: 99 });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
