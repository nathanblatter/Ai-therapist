import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import {
  recordConsent,
  getActiveConsentDocument,
  insertConsentDocument,
  isRecordingConsentedForSession,
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

describe('isRecordingConsentedForSession (086 enforcement)', () => {
  it('returns false when the owner\'s latest consent snapshot disables recording', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ recording_enabled: false }] });
    expect(await isRecordingConsentedForSession('sess1')).toBe(false);
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain('ORDER BY accepted_at DESC');
    expect(sql).toContain('ts.user_id IS NOT NULL');
  });

  it('returns true when the latest consent allows recording', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ recording_enabled: true }] });
    expect(await isRecordingConsentedForSession('sess1')).toBe(true);
  });

  it('returns true for sessions with no linked user or no consent rows (demo keeps current behavior)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await isRecordingConsentedForSession('sess1')).toBe(true);
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
