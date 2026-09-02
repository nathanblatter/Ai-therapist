// Batch redaction resilience (ai-therapist-150). The 2026-09-02 red-team run
// caught the model merging two messages ("returned 5 items, expected 6"),
// which — under the old all-or-nothing length check — left EVERY message in
// the session unredacted. These tests pin the anchored {i, text} format, the
// strict shape validation (including the model-emits-null case that used to
// become the literal string "null"), the one batch retry, and the per-item
// fallback that keeps a mangled batch from sinking the session.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.hoisted(() => vi.fn());
vi.mock('openai', () => ({
  default: class MockOpenAI {
    responses = { create: createMock };
  },
}));
vi.mock('../config/secrets.js', () => ({ getOpenAIKey: async () => 'test-key' }));

import { redactPHIBatch } from './redaction.service.js';

function batchReply(items: Array<{ i: number; text: string | null }>) {
  return { output_text: JSON.stringify(items) };
}

const ITEMS = [
  { id: 11, content: 'My name is John Smith' },
  { id: 12, content: 'I live in Provo' },
];

describe('redactPHIBatch', () => {
  // Block body on purpose: `() => createMock.mockReset()` returns the mock
  // itself, and vitest inspects beforeEach return values — that stray return
  // made it misattribute a (fully handled) worker rejection to whatever test
  // was running.
  beforeEach(() => {
    createMock.mockReset();
  });

  it('sends anchored {i, text} items and maps redacted text back by id (double pass)', async () => {
    createMock
      .mockResolvedValueOnce(batchReply([
        { i: 0, text: 'My name is [REDACTED: NAME]' },
        { i: 1, text: 'I live in [REDACTED: LOCATION]' },
      ]))
      .mockResolvedValueOnce(batchReply([
        { i: 0, text: 'My name is [REDACTED: NAME]' },
        { i: 1, text: 'I live in [REDACTED: LOCATION]' },
      ]));

    const result = await redactPHIBatch(ITEMS);
    expect(result.get(11)).toBe('My name is [REDACTED: NAME]');
    expect(result.get(12)).toBe('I live in [REDACTED: LOCATION]');
    expect(createMock).toHaveBeenCalledTimes(2);
    const sent = JSON.parse(createMock.mock.calls[0][0].input);
    expect(sent).toEqual([
      { i: 0, text: 'My name is John Smith' },
      { i: 1, text: 'I live in Provo' },
    ]);
  });

  it('tolerates out-of-order anchored replies', async () => {
    const shuffled = batchReply([
      { i: 1, text: 'B-red' },
      { i: 0, text: 'A-red' },
    ]);
    createMock.mockResolvedValueOnce(shuffled).mockResolvedValueOnce(shuffled);
    const result = await redactPHIBatch(ITEMS);
    expect(result.get(11)).toBe('A-red');
    expect(result.get(12)).toBe('B-red');
  });

  it('retries the batch once when the model merges/drops items', async () => {
    createMock
      .mockResolvedValueOnce(batchReply([{ i: 0, text: 'merged both messages' }])) // 1 item for 2
      .mockResolvedValueOnce(batchReply([{ i: 0, text: 'A-red' }, { i: 1, text: 'B-red' }]))
      .mockResolvedValueOnce(batchReply([{ i: 0, text: 'A-red' }, { i: 1, text: 'B-red' }]));

    const result = await redactPHIBatch(ITEMS);
    expect(result.get(11)).toBe('A-red');
    expect(result.get(12)).toBe('B-red');
    expect(createMock).toHaveBeenCalledTimes(3);
  });

  it('rejects null text elements instead of storing the literal "null"', async () => {
    createMock
      .mockResolvedValueOnce(batchReply([{ i: 0, text: null }, { i: 1, text: 'B-red' }]))
      .mockResolvedValueOnce(batchReply([{ i: 0, text: 'A-red' }, { i: 1, text: 'B-red' }]))
      .mockResolvedValueOnce(batchReply([{ i: 0, text: 'A-red' }, { i: 1, text: 'B-red' }]));

    const result = await redactPHIBatch(ITEMS);
    expect(result.get(11)).toBe('A-red');
    expect([...result.values()]).not.toContain('null');
  });

  it('rejects duplicate indices', async () => {
    createMock
      .mockResolvedValueOnce(batchReply([{ i: 0, text: 'A' }, { i: 0, text: 'A again' }]))
      .mockResolvedValueOnce(batchReply([{ i: 0, text: 'A-red' }, { i: 1, text: 'B-red' }]))
      .mockResolvedValueOnce(batchReply([{ i: 0, text: 'A-red' }, { i: 1, text: 'B-red' }]));

    const result = await redactPHIBatch(ITEMS);
    expect(result.get(12)).toBe('B-red');
  });

  it('falls back to per-item redaction when both batch attempts are mangled', async () => {
    createMock
      // first pass: two bad batch attempts, then two per-item calls
      .mockResolvedValueOnce({ output_text: 'not json at all' })
      .mockResolvedValueOnce(batchReply([{ i: 0, text: 'only one' }]))
      .mockResolvedValueOnce({ output_text: 'A-item-red' })
      .mockResolvedValueOnce({ output_text: 'B-item-red' })
      // second pass: healthy batch
      .mockResolvedValueOnce(batchReply([{ i: 0, text: 'A-final' }, { i: 1, text: 'B-final' }]));

    const result = await redactPHIBatch(ITEMS);
    expect(result.get(11)).toBe('A-final');
    expect(result.get(12)).toBe('B-final');
    // per-item calls use plain string input, not the anchored JSON array
    const perItemInputs = createMock.mock.calls.slice(2, 4).map(c => c[0].input).sort();
    expect(perItemInputs).toEqual(['I live in Provo', 'My name is John Smith'].sort());
  });

  it('still throws on infrastructure errors (network/auth) — those must surface', async () => {
    createMock.mockImplementation(() => Promise.reject(new Error('ECONNRESET')));
    let caught: unknown = null;
    try {
      await redactPHIBatch(ITEMS);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error)?.message).toBe('ECONNRESET');
  });
});
