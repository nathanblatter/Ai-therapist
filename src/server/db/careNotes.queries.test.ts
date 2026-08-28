import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, clientQueryMock, releaseMock, connectMock } = vi.hoisted(() => {
  const clientQueryMock = vi.fn();
  const releaseMock = vi.fn();
  const connectMock = vi.fn(async () => ({ query: clientQueryMock, release: releaseMock }));
  return { queryMock: vi.fn(), clientQueryMock, releaseMock, connectMock };
});
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: connectMock, on: vi.fn() },
}));

import {
  createCareNote,
  getCareNoteById,
  listCareNotesForClient,
  updateCareNoteDraft,
  deleteCareNoteDraft,
  signCareNote,
  createCareNoteAmendment,
  computeSignHash,
  getLiveProgressNoteForSession,
} from './careNotes.queries.js';

beforeEach(() => {
  queryMock.mockReset();
  clientQueryMock.mockReset();
  releaseMock.mockReset();
});

const DRAFT = {
  note_id: 5,
  org_id: 1,
  client_id: 42,
  author_id: 7,
  author_name: 'dr_t',
  author_role: 'therapist',
  note_type: 'progress',
  content: { subjective: 's' },
  status: 'draft',
  amends_note_id: null,
};

describe('createCareNote', () => {
  it('inserts a draft with JSON-stringified content', async () => {
    queryMock.mockResolvedValueOnce({ rows: [DRAFT] });
    const note = await createCareNote({
      orgId: 1, clientId: 42, authorId: 7, authorName: 'dr_t',
      authorRole: 'therapist', noteType: 'progress', content: { subjective: 's' },
    });
    expect(note).toEqual(DRAFT);
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[10]).toBe(JSON.stringify({ subjective: 's' }));
  });
});

describe('listCareNotesForClient', () => {
  it('therapist viewer sees everything (no visibility clause)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listCareNotesForClient(42, { userId: 7, role: 'therapist' });
    const sql = String(queryMock.mock.calls[0][0]);
    // The column list mentions shared_with_care_team; the WHERE clause must not.
    expect(sql).not.toContain('shared_with_care_team = TRUE');
    expect(sql).not.toContain(`note_type = 'case'`);
    expect(queryMock.mock.calls[0][1]).toEqual([42, 100]);
  });

  it('caseworker viewer is limited to case notes, shared progress notes, and own notes', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listCareNotesForClient(42, { userId: 9, role: 'caseworker' });
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain(`note_type = 'case'`);
    expect(sql).toContain('shared_with_care_team = TRUE');
    expect(sql).toContain('author_id = $3');
    expect(queryMock.mock.calls[0][1]).toEqual([42, 100, 9]);
  });
});

describe('draft guards', () => {
  it("updateCareNoteDraft only touches the author's own draft", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(updateCareNoteDraft(5, 7, { content: { a: 1 } })).resolves.toBeNull();
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain(`author_id = $2 AND status = 'draft'`);
  });

  it('deleteCareNoteDraft returns false when nothing matched', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(deleteCareNoteDraft(5, 7)).resolves.toBe(false);
  });

  it('updateCareNoteDraft leaves case_note_kind untouched when the field is omitted', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await updateCareNoteDraft(5, 7, { content: { a: 1 } });
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[3]).toBeNull();  // kind value unused...
    expect(params[4]).toBe(false); // ...because the set flag is off
  });

  it('updateCareNoteDraft supports an explicit null to CLEAR case_note_kind (no COALESCE swallow)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await updateCareNoteDraft(5, 7, { caseNoteKind: null });
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('CASE WHEN $5::boolean THEN $4 ELSE case_note_kind END');
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[3]).toBeNull();
    expect(params[4]).toBe(true); // set flag on: NULL is written through
  });
});

describe('signCareNote', () => {
  it('signs a draft in a transaction and computes a sign hash', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })                    // BEGIN
      .mockResolvedValueOnce({ rows: [DRAFT] })               // SELECT ... FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ ...DRAFT, status: 'signed', sign_hash: 'h' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] });                   // COMMIT
    const signed = await signCareNote(5, 7);
    expect(signed?.status).toBe('signed');
    const sqls = clientQueryMock.mock.calls.map((c) => String(c[0]));
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toContain('FOR UPDATE');
    expect(sqls[2]).toContain(`status = 'signed'`);
    expect(sqls[3]).toBe('COMMIT');
    expect(releaseMock).toHaveBeenCalledOnce();
    // The hash param is a sha256 hex string.
    expect(clientQueryMock.mock.calls[2][1][3]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rolls back and returns null when the note is not a signable draft', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })   // BEGIN
      .mockResolvedValueOnce({ rows: [] })   // SELECT miss
      .mockResolvedValueOnce({ rows: [] });  // ROLLBACK
    await expect(signCareNote(5, 7)).resolves.toBeNull();
    expect(String(clientQueryMock.mock.calls[2][0])).toBe('ROLLBACK');
  });

  it('flips the amended original to amended in the same transaction', async () => {
    const amendment = { ...DRAFT, note_id: 6, amends_note_id: 5 };
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })                          // BEGIN
      .mockResolvedValueOnce({ rows: [amendment] })                 // SELECT
      .mockResolvedValueOnce({ rows: [{ ...amendment, status: 'signed' }] }) // UPDATE sign
      .mockResolvedValueOnce({ rows: [] })                          // UPDATE original -> amended
      .mockResolvedValueOnce({ rows: [] });                         // COMMIT
    await signCareNote(6, 7);
    const flip = clientQueryMock.mock.calls[3];
    expect(String(flip[0])).toContain(`'amended'`);
    expect(flip[1]).toEqual([5]);
  });

  it('carries the original session_id onto the signed amendment (live-note linkage preserved)', async () => {
    const amendment = { ...DRAFT, note_id: 6, amends_note_id: 5, session_id: null };
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })                                     // BEGIN
      .mockResolvedValueOnce({ rows: [amendment] })                            // SELECT ... FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ ...amendment, status: 'signed' }] })   // UPDATE sign
      .mockResolvedValueOnce({ rows: [{ session_id: 'sess-1' }] })             // flip original -> amended
      .mockResolvedValueOnce({ rows: [{ ...amendment, status: 'signed', session_id: 'sess-1' }] }) // carry
      .mockResolvedValueOnce({ rows: [] });                                    // COMMIT
    const signed = await signCareNote(6, 7);
    expect(signed?.session_id).toBe('sess-1');
    const carry = clientQueryMock.mock.calls[4];
    expect(String(carry[0])).toContain('SET session_id = $2');
    expect(carry[1]).toEqual([6, 'sess-1']);
    // The carry happens AFTER the original left the partial unique index.
    expect(String(clientQueryMock.mock.calls[3][0])).toContain(`'amended'`);
    expect(String(clientQueryMock.mock.calls[5][0])).toBe('COMMIT');
  });

  it('skips the carry when the original has no session linkage', async () => {
    const amendment = { ...DRAFT, note_id: 6, amends_note_id: 5, session_id: null };
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })                                     // BEGIN
      .mockResolvedValueOnce({ rows: [amendment] })                            // SELECT
      .mockResolvedValueOnce({ rows: [{ ...amendment, status: 'signed' }] })   // UPDATE sign
      .mockResolvedValueOnce({ rows: [{ session_id: null }] })                 // flip
      .mockResolvedValueOnce({ rows: [] });                                    // COMMIT
    await signCareNote(6, 7);
    expect(String(clientQueryMock.mock.calls[4][0])).toBe('COMMIT');
  });
});

describe('computeSignHash', () => {
  it('is deterministic regardless of content key order', () => {
    const base = {
      note_id: 1, client_id: 2, author_id: 3, author_name: 'a',
      note_type: 'case', signed_at: '2026-08-27T00:00:00.000Z',
    };
    const h1 = computeSignHash({ ...base, content: { x: 1, y: { b: 2, a: 1 } } });
    const h2 = computeSignHash({ ...base, content: { y: { a: 1, b: 2 }, x: 1 } });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when content changes', () => {
    const base = {
      note_id: 1, client_id: 2, author_id: 3, author_name: 'a',
      note_type: 'case', signed_at: '2026-08-27T00:00:00.000Z',
    };
    expect(computeSignHash({ ...base, content: { x: 1 } }))
      .not.toBe(computeSignHash({ ...base, content: { x: 2 } }));
  });
});

describe('createCareNoteAmendment', () => {
  it('copies a signed note into a linked draft via INSERT..SELECT', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...DRAFT, note_id: 6, amends_note_id: 5 }] });
    const draft = await createCareNoteAmendment(5, 7);
    expect(draft?.amends_note_id).toBe(5);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain(`status = 'signed'`);
  });
});

describe('getLiveProgressNoteForSession', () => {
  it('excludes amended notes', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(getLiveProgressNoteForSession('s1')).resolves.toBeNull();
    expect(String(queryMock.mock.calls[0][0])).toContain(`status <> 'amended'`);
  });
});

describe('getCareNoteById', () => {
  it('returns null on a miss', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(getCareNoteById(1)).resolves.toBeNull();
  });
});
