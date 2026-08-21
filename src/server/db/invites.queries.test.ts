// Unit coverage for the client-invite queries (ai-therapist-119): token
// generation/hashing, atomic single-use consumption SQL, and listing.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import {
  createInvite,
  findInviteByToken,
  consumeInvite,
  markInviteUsedBy,
  releaseInvite,
  listInvites,
} from './invites.queries.js';

const INVITE_ROW = {
  invite_id: 7,
  token_hash: 'abc',
  therapist_id: 3,
  label: 'JB',
  created_at: '2026-08-21T00:00:00Z',
  expires_at: '2026-08-28T00:00:00Z',
  used_at: null,
  used_by: null,
};

beforeEach(() => {
  queryMock.mockReset();
});

describe('createInvite', () => {
  it('generates a 32-byte base64url token and stores only its sha256 hex', async () => {
    queryMock.mockResolvedValueOnce({ rows: [INVITE_ROW] });

    const { rawToken, invite } = await createInvite(3, 'JB');

    // 32 random bytes -> 43 base64url chars, no padding, URL-safe alphabet.
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(rawToken, 'base64url')).toHaveLength(32);

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO client_invites');
    const expectedHash = createHash('sha256').update(rawToken).digest('hex');
    expect(params[0]).toBe(expectedHash);
    expect(params[0]).not.toContain(rawToken);
    expect(params[1]).toBe(3);
    expect(params[2]).toBe('JB');
    expect(params[3]).toBe(168); // default ttlHours
    expect(invite).toBe(INVITE_ROW);
  });

  it('honors a custom ttlHours', async () => {
    queryMock.mockResolvedValueOnce({ rows: [INVITE_ROW] });
    await createInvite(3, null, 24);
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[2]).toBeNull();
    expect(params[3]).toBe(24);
  });

  it('mints a distinct token per invite', async () => {
    queryMock.mockResolvedValue({ rows: [INVITE_ROW] });
    const a = await createInvite(3, null);
    const b = await createInvite(3, null);
    expect(a.rawToken).not.toBe(b.rawToken);
  });
});

describe('consumeInvite', () => {
  it('is a single atomic UPDATE guarded on used_at IS NULL and expires_at > now()', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...INVITE_ROW, used_at: '2026-08-21T01:00:00Z' }] });

    const invite = await consumeInvite('raw-token');

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('UPDATE client_invites SET used_at = now()');
    expect(sql).toContain('used_at IS NULL');
    expect(sql).toContain('expires_at > now()');
    expect(sql).toContain('RETURNING');
    expect(params[0]).toBe(createHash('sha256').update('raw-token').digest('hex'));
    expect(invite?.used_at).toBe('2026-08-21T01:00:00Z');
  });

  it('returns null when the token is unknown, used, or expired (no matching row)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await consumeInvite('dead-token')).toBeNull();
  });
});

describe('findInviteByToken', () => {
  it('looks up by hash without mutating and returns null when absent', async () => {
    queryMock.mockResolvedValueOnce({ rows: [INVITE_ROW] });
    const found = await findInviteByToken('raw-token');
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('SELECT');
    expect(sql).not.toContain('UPDATE');
    expect(params[0]).toBe(createHash('sha256').update('raw-token').digest('hex'));
    expect(found).toBe(INVITE_ROW);

    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await findInviteByToken('nope')).toBeNull();
  });
});

describe('markInviteUsedBy / releaseInvite', () => {
  it('records the created account on the invite', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await markInviteUsedBy(7, 42);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('SET used_by = $1');
    expect(params).toEqual([42, 7]);
  });

  it('release clears used_at and used_by', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await releaseInvite(7);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('used_at = NULL');
    expect(sql).toContain('used_by = NULL');
    expect(params).toEqual([7]);
  });
});

describe('listInvites', () => {
  it('returns the therapist rows newest first', async () => {
    queryMock.mockResolvedValueOnce({ rows: [INVITE_ROW] });
    const rows = await listInvites(3);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE therapist_id = $1');
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(params).toEqual([3]);
    expect(rows).toEqual([INVITE_ROW]);
  });
});
