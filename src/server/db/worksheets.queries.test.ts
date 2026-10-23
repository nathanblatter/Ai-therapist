// Worksheet review queue queries (ai-therapist-89): predicates, reviewer
// stamping, and per-instance idempotent promotion.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, clientQuery, release, connectMock } = vi.hoisted(() => {
  const clientQuery = vi.fn();
  const release = vi.fn();
  return {
    queryMock: vi.fn(),
    clientQuery,
    release,
    connectMock: vi.fn().mockResolvedValue({ query: clientQuery, release }),
  };
});
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: connectMock, on: vi.fn() },
}));

import {
  listWorksheetInstancesForReview,
  getWorksheetInstanceForReview,
  markWorksheetRejected,
  promoteWorksheetToKnowledgeChunk,
} from './worksheets.queries.js';

beforeEach(() => {
  queryMock.mockReset();
  clientQuery.mockReset();
  release.mockClear();
  connectMock.mockClear();
});

describe('listWorksheetInstancesForReview', () => {
  it('selects completed, still-pending instances newest first with a pseudo-reference and no answers', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          instance_id: 2,
          session_id: 's2',
          user_id: 9,
          template_chunk_id: null,
          template_title: 'Evidence list',
          title: 'T',
          section_count: 2,
          created_at: new Date(),
          completed_at: new Date(),
          total_count: '2',
        },
        {
          instance_id: 1,
          session_id: 's1',
          user_id: 9,
          template_chunk_id: 21,
          template_title: null,
          title: 'T',
          section_count: 3,
          created_at: new Date(),
          completed_at: new Date(),
          total_count: '2',
        },
      ],
    });
    const { rows, total } = await listWorksheetInstancesForReview({ limit: 500, offset: -3 });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/w\.status = 'completed' AND w\.review_status = 'pending'/);
    expect(sql).toMatch(/ORDER BY w\.completed_at DESC NULLS LAST, w\.instance_id DESC/);
    expect(sql).toMatch(/LEFT JOIN therapy_sessions ts ON ts\.session_id::text = w\.session_id/);
    expect(sql).not.toMatch(/responses/);
    expect(sql).not.toMatch(/username/);
    expect(params).toEqual([200, 0]); // clamped
    expect(total).toBe(2);
    expect(rows.map((r) => r.instance_id)).toEqual([2, 1]);
    expect(rows[0]).not.toHaveProperty('total_count');
  });

  it('returns total 0 for an empty queue', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await listWorksheetInstancesForReview()).toEqual({ rows: [], total: 0 });
    expect(queryMock.mock.calls[0][1]).toEqual([50, 0]);
  });
});

describe('getWorksheetInstanceForReview', () => {
  it('joins the vetted template content and the session owner', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ instance_id: 1 }] });
    expect(await getWorksheetInstanceForReview(1)).toEqual({ instance_id: 1 });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/kc\.content AS template_content/);
    expect(sql).toMatch(/ts\.user_id/);
    expect(sql).toMatch(/w\.responses/);
    expect(params).toEqual([1]);
  });

  it('returns null when missing', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await getWorksheetInstanceForReview(404)).toBeNull();
  });
});

describe('markWorksheetRejected', () => {
  it('stamps reviewer, timestamp and note, only while pending and completed', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1 });
    expect(await markWorksheetRejected(5, 'nathan', 'duplicate of chunk 21')).toBe(true);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/review_status = 'rejected'/);
    expect(sql).toMatch(/reviewed_at = CURRENT_TIMESTAMP/);
    expect(sql).toMatch(/WHERE instance_id = \$1 AND status = 'completed' AND review_status = 'pending'/);
    expect(params).toEqual([5, 'nathan', 'duplicate of chunk 21']);
  });

  it('returns false when nothing was pending', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0 });
    expect(await markWorksheetRejected(5, 'nathan', 'x')).toBe(false);
  });
});

describe('promoteWorksheetToKnowledgeChunk', () => {
  const input = {
    instanceId: 7,
    reviewer: 'nathan',
    note: null,
    title: 'Evidence list',
    content: 'Worksheet template: Evidence list',
    content_hash: 'abc',
    embedding: [0.1, 0.2],
    topic: 'anxiety',
    metadata: { sections: [{ type: 'textarea' }], render_tool: 'show_journaling_prompt' },
    template_kind: 'vetted_template',
  };

  function pendingRow() {
    return { rows: [{ status: 'completed', review_status: 'pending', promoted_chunk_id: null }] };
  }

  it('inserts a pending worksheet chunk with provenance and marks the instance, in one transaction', async () => {
    clientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce(pendingRow()) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ chunk_id: 99 }] }) // INSERT
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE
      .mockResolvedValueOnce({}); // COMMIT
    const result = await promoteWorksheetToKnowledgeChunk(input);
    expect(result).toEqual({ outcome: 'promoted', chunk_id: 99 });

    const calls = clientQuery.mock.calls.map((c) => c[0] as string);
    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toMatch(/FOR UPDATE/);
    expect(calls[2]).toMatch(/INSERT INTO knowledge_chunks/);
    expect(calls[2]).toMatch(/'worksheet_promotion'/);
    expect(calls[2]).toMatch(/'worksheet'/);
    expect(calls[2]).toMatch(/ON CONFLICT \(content_hash\) DO NOTHING/);
    expect(calls[2]).toMatch(/FALSE\)/); // active = false: pending approval
    expect(calls[3]).toMatch(/review_status = 'promoted', promoted = TRUE, promoted_chunk_id = \$2/);
    expect(calls[4]).toBe('COMMIT');

    const insertParams = clientQuery.mock.calls[2][1] as unknown[];
    expect(insertParams[0]).toBe('anxiety');
    expect(insertParams[1]).toBe('Evidence list');
    expect(insertParams[2]).toBe(input.content);
    const meta = JSON.parse(insertParams[3] as string);
    expect(meta.sections).toEqual([{ type: 'textarea' }]);
    expect(meta.render_tool).toBe('show_journaling_prompt');
    expect(meta.provenance).toEqual({
      worksheet_instance_id: 7,
      reviewer: 'nathan',
      template_kind: 'vetted_template',
      promoted_at: expect.any(String),
    });
    expect(insertParams[4]).toBe('abc');
    expect(insertParams[5]).toBe('[0.1,0.2]');

    const updateParams = clientQuery.mock.calls[3][1] as unknown[];
    expect(updateParams).toEqual([7, 99, 'nathan', meta.provenance.promoted_at, null]);
    expect(release).toHaveBeenCalled();
  });

  it('is idempotent per instance: a second promotion returns the linked chunk without inserting', async () => {
    clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ status: 'completed', review_status: 'promoted', promoted_chunk_id: '99' }] })
      .mockResolvedValueOnce({});
    expect(await promoteWorksheetToKnowledgeChunk(input)).toEqual({ outcome: 'already_promoted', chunk_id: 99 });
    const calls = clientQuery.mock.calls.map((c) => c[0] as string);
    expect(calls.some((s) => s.includes('INSERT'))).toBe(false);
    expect(calls[calls.length - 1]).toBe('ROLLBACK');
    expect(release).toHaveBeenCalled();
  });

  it('refuses a rejected or draft instance', async () => {
    clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ status: 'completed', review_status: 'rejected', promoted_chunk_id: null }] })
      .mockResolvedValueOnce({});
    expect(await promoteWorksheetToKnowledgeChunk(input)).toEqual({ outcome: 'not_pending' });
    clientQuery.mockReset();
    clientQuery.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({});
    expect(await promoteWorksheetToKnowledgeChunk(input)).toEqual({ outcome: 'not_pending' });
  });

  it('refuses when identical template text already exists (content_hash conflict) and rolls back', async () => {
    clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(pendingRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({});
    expect(await promoteWorksheetToKnowledgeChunk(input)).toEqual({ outcome: 'duplicate_content' });
    const calls = clientQuery.mock.calls.map((c) => c[0] as string);
    expect(calls.some((s) => s.includes('UPDATE worksheet_instances'))).toBe(false);
    expect(calls[calls.length - 1]).toBe('ROLLBACK');
  });

  it('rolls back and rethrows on a failure mid-transaction, releasing the client', async () => {
    clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(pendingRow())
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({});
    await expect(promoteWorksheetToKnowledgeChunk(input)).rejects.toThrow('boom');
    expect(clientQuery.mock.calls.map((c) => c[0])).toContain('ROLLBACK');
    expect(release).toHaveBeenCalled();
  });
});
