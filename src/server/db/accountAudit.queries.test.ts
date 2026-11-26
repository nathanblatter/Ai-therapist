// The account audit writer never fails the change it records, and a database
// without migration 132 says so once instead of on every account change.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const pool = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../config/db.js', () => ({ pool }));
const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../utils/logger.js', () => ({ createLogger: () => logger }));

const { insertAccountAudit, listAccountAudit, _resetAccountAuditWarning } = await import('./accountAudit.queries.js');

const ROW = {
  action: 'role_changed' as const,
  targetUserId: 5,
  targetUsername: 'u5',
  organizationId: 1,
  actorUserId: 1,
  actorUsername: 'r1',
  detail: { from: 'participant', to: 'therapist' },
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetAccountAuditWarning();
  pool.query.mockResolvedValue({ rows: [] });
});

describe('insertAccountAudit', () => {
  it('writes one row with the detail as JSON', async () => {
    await insertAccountAudit(ROW);
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO account_audit_log');
    expect(params).toEqual(['role_changed', 5, 'u5', 1, 1, 'r1', '{"from":"participant","to":"therapist"}']);
  });

  it('stores NULL for a missing organisation and a missing detail', async () => {
    await insertAccountAudit({ ...ROW, organizationId: undefined, detail: undefined });
    expect(pool.query.mock.calls[0][1]).toEqual(['role_changed', 5, 'u5', null, 1, 'r1', null]);
  });

  it('never throws, and logs a failure at error level', async () => {
    pool.query.mockRejectedValue(new Error('db down'));
    await expect(insertAccountAudit(ROW)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('a database without the table warns once, then stays quiet', async () => {
    pool.query.mockRejectedValue(
      Object.assign(new Error('relation "account_audit_log" does not exist'), { code: '42P01' }),
    );
    await insertAccountAudit(ROW);
    await insertAccountAudit(ROW);
    await insertAccountAudit(ROW);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('listAccountAudit on a database without the table', () => {
  it('answers null (the caller says the trail is not set up), and rethrows any other failure', async () => {
    pool.query.mockRejectedValueOnce(Object.assign(new Error('no such table'), { code: '42P01' }));
    await expect(listAccountAudit(3)).resolves.toBeNull();
    pool.query.mockRejectedValueOnce(new Error('db down'));
    await expect(listAccountAudit(3)).rejects.toThrow('db down');
  });
});

describe('listAccountAudit', () => {
  it('reads one organisation, newest first, with a bounded limit', async () => {
    await listAccountAudit(3, 50_000);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('WHERE organization_id = $1');
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(params).toEqual([3, 1000]);
  });
});
