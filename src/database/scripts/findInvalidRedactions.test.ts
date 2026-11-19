// List-only finder for stored redactions that fail validation (ai-therapist-382).
import { describe, it, expect, vi } from 'vitest';
import { classifyStoredRow, findInvalidRedactions, summarize, type StoredRow } from './findInvalidRedactions.js';

const REFUSAL = 'I’m really sorry you’re feeling like this. Call or text 988.';
const base: StoredRow = {
  message_id: 1,
  session_id: 'session-abcdef-123',
  role: 'user',
  created_at: '2026-01-02T03:04:05Z',
  content: 'I had a hard week',
  content_redacted: 'I had a hard week',
  rejected: false,
};

describe('classifyStoredRow', () => {
  it('ok when the stored text is a redaction of the original', () => {
    expect(classifyStoredRow(base).cls).toBe('ok');
  });
  it('invalid when a refusal was stored as the redaction', () => {
    expect(classifyStoredRow({ ...base, content_redacted: REFUSAL })).toMatchObject({ cls: 'invalid' });
  });
  it('rejected when the pipeline already refused to store one', () => {
    expect(classifyStoredRow({ ...base, content_redacted: null, rejected: true }).cls).toBe('rejected');
  });
  it('unverifiable when the original is wiped and the text opens like a refusal', () => {
    expect(classifyStoredRow({ ...base, content: null, content_redacted: REFUSAL }).cls).toBe('unverifiable');
  });
  it('ok when the original is wiped and nothing looks off', () => {
    expect(classifyStoredRow({ ...base, content: null }).cls).toBe('ok');
  });
});

describe('findInvalidRedactions', () => {
  it('pages by message_id, reads only, and never returns message text', async () => {
    const page1 = Array.from({ length: 1000 }, (_, k) => ({ ...base, message_id: k + 1 }));
    page1[5] = { ...page1[5], content_redacted: REFUSAL };
    const page2 = [{ ...base, message_id: 1001, content: null, content_redacted: REFUSAL }];
    const query = vi.fn().mockResolvedValueOnce({ rows: page1 }).mockResolvedValueOnce({ rows: page2 });
    const findings = await findInvalidRedactions(query);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toEqual([1000, 1000]);
    for (const [sql] of query.mock.calls) expect(sql).toMatch(/^\s*SELECT/);
    expect(findings.map((f) => [f.messageId, f.cls, f.reRedactable])).toEqual([
      ['6', 'invalid', true],
      ['1001', 'unverifiable', false],
    ]);
    expect(JSON.stringify(findings)).not.toContain('sorry');
    expect(summarize(findings)[0]).toBe('invalid: 1 row(s) in 1 session(s) (user 1)');
  });
});
