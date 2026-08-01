import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import {
  recordConsent,
  getActiveConsentDocument,
  insertConsentDocument,
} from './consent.queries.js';

beforeEach(() => {
  queryMock.mockReset();
});

describe('getActiveConsentDocument', () => {
  it('selects the newest document with effective_at <= now (future versions ignored)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ document_id: 2, version: '2026-07-30.1', body: 'b', body_hash: 'h' }] });
    const doc = await getActiveConsentDocument();
    expect(doc?.version).toBe('2026-07-30.1');
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain('effective_at <= CURRENT_TIMESTAMP');
    expect(sql).toContain('ORDER BY effective_at DESC');
  });

  it('returns null when the table is empty', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await getActiveConsentDocument()).toBeNull();
  });
});

describe('recordConsent', () => {
  it('persists the body_hash alongside the acceptance', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ consent_id: 1 }] });
    await recordConsent({ sessionId: null, userId: 42, consentVersion: '2026-07-30.1', recordingEnabled: false, bodyHash: 'deadbeef' });
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params).toEqual([null, 42, '2026-07-30.1', false, 'deadbeef']);
  });

  it('stores null body_hash when omitted', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ consent_id: 1 }] });
    await recordConsent({ consentVersion: 'v', recordingEnabled: true });
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[4]).toBeNull();
  });
});

describe('insertConsentDocument', () => {
  it('inserts version/body/hash and defaults effective_at to now when null', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ document_id: 3, version: 'v2' }] });
    await insertConsentDocument({ version: 'v2', body: 'copy', bodyHash: 'hash', effectiveAt: null, publishedBy: 'nathan' });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('COALESCE($4, CURRENT_TIMESTAMP)');
    expect(params).toEqual(['v2', 'copy', 'hash', null, 'nathan']);
  });
});
