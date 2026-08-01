import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import { setKnowledgeChunkActive, approveKnowledgeChunks } from './knowledge.queries.js';

beforeEach(() => {
  queryMock.mockReset();
});

describe('setKnowledgeChunkActive (approval audit)', () => {
  it('stamps approver, timestamp, and note on approve', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1 });
    const ok = await setKnowledgeChunkActive(7, true, 'nathan', 'looks good');
    expect(ok).toBe(true);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('active = TRUE');
    expect(sql).toContain('approved_by');
    expect(sql).toContain('approved_at = CURRENT_TIMESTAMP');
    expect(sql).toContain('approval_note');
    expect(params).toEqual([7, 'nathan', 'looks good']);
  });

  it('does NOT touch approval fields on unapprove (retains last-approval record)', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1 });
    await setKnowledgeChunkActive(7, false, 'nathan');
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('active = FALSE');
    expect(sql).not.toContain('approved_by');
    expect(sql).not.toContain('approval_note');
    expect(params).toEqual([7]);
  });

  it('passes null when no note is given on approve', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1 });
    await setKnowledgeChunkActive(9, true, 'nathan');
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[2]).toBeNull();
  });

  it('returns false when the chunk id does not exist', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0 });
    expect(await setKnowledgeChunkActive(404, true, 'nathan')).toBe(false);
  });
});

describe('approveKnowledgeChunks (bulk approval audit)', () => {
  it('stamps actor + note on every affected row and returns the count', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 5 });
    const n = await approveKnowledgeChunks({ kind: 'worksheet' }, 'nathan', 'IRB batch 3');
    expect(n).toBe(5);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('active = TRUE');
    expect(sql).toContain('approved_by');
    expect(sql).toContain('approval_note');
    expect(params).toEqual(['worksheet', null, 'nathan', 'IRB batch 3']);
  });
});
