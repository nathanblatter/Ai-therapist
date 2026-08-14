import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import {
  setKnowledgeChunkActive,
  approveKnowledgeChunks,
  createKnowledgeChunk,
  updateKnowledgeChunk,
  listKnowledgeChunks,
  searchKnowledgeChunks,
} from './knowledge.queries.js';

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

const CHUNK_FIELDS = {
  topic: 'anxiety',
  title: 'Grounding basics',
  content: 'Some psychoeducation text.',
  source: 'clinician-authored',
  source_url: null,
  license: null,
  kind: 'psychoeducation',
  modality: null,
};

describe('createKnowledgeChunk (ai-therapist-116)', () => {
  it('inserts as pending (active FALSE) and returns the new id', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ chunk_id: 42 }], rowCount: 1 });
    const id = await createKnowledgeChunk({ ...CHUNK_FIELDS, content_hash: 'abc', embedding: [0.1, 0.2] });
    expect(id).toBe(42);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('FALSE');
    expect(sql).toContain('ON CONFLICT (content_hash) DO NOTHING');
    expect(params).toContain('abc');
    expect(params).toContain('[0.1,0.2]');
  });

  it('returns null on duplicate content (hash conflict)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const id = await createKnowledgeChunk({ ...CHUNK_FIELDS, content_hash: 'dupe', embedding: [0.1] });
    expect(id).toBeNull();
  });
});

describe('updateKnowledgeChunk (ai-therapist-116)', () => {
  it('resets active=FALSE and replaces hash + embedding when content changed', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1 });
    const ok = await updateKnowledgeChunk(7, {
      ...CHUNK_FIELDS,
      contentChange: { content_hash: 'newhash', embedding: [0.3, 0.4] },
    });
    expect(ok).toBe(true);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('active = FALSE');
    expect(sql).toContain('content_hash');
    expect(sql).toContain('embedding');
    expect(params).toContain('newhash');
    expect(params).toContain('[0.3,0.4]');
  });

  it('leaves active / hash / embedding untouched on a metadata-only edit', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1 });
    await updateKnowledgeChunk(7, { ...CHUNK_FIELDS, contentChange: null });
    const [sql] = queryMock.mock.calls[0];
    expect(sql).not.toContain('active');
    expect(sql).not.toContain('content_hash');
    expect(sql).not.toContain('embedding');
  });

  it('returns false when the chunk does not exist', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0 });
    expect(await updateKnowledgeChunk(404, { ...CHUNK_FIELDS })).toBe(false);
  });
});

describe('listKnowledgeChunks (search + paging)', () => {
  it('passes ILIKE pattern, limit, and offset; returns total from window count', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { chunk_id: 1, title: 'a', total_count: '7' },
        { chunk_id: 2, title: 'b', total_count: '7' },
      ],
    });
    const result = await listKnowledgeChunks({ kind: 'worksheet', q: 'breathing', limit: 2, offset: 4 });
    expect(result.total).toBe(7);
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0]).not.toHaveProperty('total_count');
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('ILIKE');
    expect(sql).toContain('COUNT(*) OVER()');
    expect(params).toEqual(['worksheet', null, '%breathing%', 2, 4]);
  });

  it('returns total 0 for an empty page', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const result = await listKnowledgeChunks({});
    expect(result).toEqual({ chunks: [], total: 0 });
  });
});

describe('searchKnowledgeChunks includeInactive (test-retrieval playground)', () => {
  it('defaults to active-only', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await searchKnowledgeChunks([0.1], { kind: 'psychoeducation' }, 8);
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[5]).toBe(false);
  });

  it('passes includeInactive=true through for the admin playground', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await searchKnowledgeChunks([0.1], { kind: 'psychoeducation' }, 8, { includeInactive: true });
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[5]).toBe(true);
  });
});
