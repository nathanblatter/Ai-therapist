// MFA service (ai-therapist-236 test backfill). The TOTP/backup-code logic is
// deterministic and security-relevant: a regression here either locks every
// admin out or lets a stale/used code through. bcrypt is real (cost 10 is
// fast enough); only the pool is mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import speakeasy from 'speakeasy';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import {
  generateMFASecret,
  generateQRCode,
  verifyTOTP,
  generateBackupCodes,
  verifyBackupCode,
  enableMFA,
  disableMFA,
  updateMFAVerificationTime,
  getMFAStatus,
  updateBackupCodes,
} from './mfa.service.js';

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 1 });
});

describe('generateMFASecret / generateQRCode', () => {
  it('labels the otpauth URL with the username and issuer and returns a base32 secret', () => {
    const { secret, otpauthUrl } = generateMFASecret('dr.jones');
    expect(secret).toMatch(/^[A-Z2-7]+=*$/);
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(otpauthUrl).toContain('otpauth://totp/');
    expect(decodeURIComponent(otpauthUrl ?? '')).toContain('AI Therapy (dr.jones)');
    expect(decodeURIComponent(otpauthUrl ?? '')).toContain('issuer=AI Therapy Platform');
  });

  it('never returns the same secret twice', () => {
    expect(generateMFASecret('a').secret).not.toBe(generateMFASecret('a').secret);
  });

  it('renders the otpauth URL as a PNG data URL', async () => {
    const { otpauthUrl } = generateMFASecret('qr');
    const dataUrl = await generateQRCode(otpauthUrl!);
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });
});

describe('verifyTOTP', () => {
  const secret = generateMFASecret('totp').secret;
  const tokenAt = (offsetSeconds: number) =>
    speakeasy.totp({ secret, encoding: 'base32', time: Math.floor(Date.now() / 1000) + offsetSeconds });

  it('accepts the current token and tokens within two steps of clock drift', () => {
    expect(verifyTOTP(tokenAt(0), secret)).toBe(true);
    expect(verifyTOTP(tokenAt(-60), secret)).toBe(true);
    expect(verifyTOTP(tokenAt(60), secret)).toBe(true);
  });

  it('rejects a token far outside the drift window and a token for another secret', () => {
    expect(verifyTOTP(tokenAt(-300), secret)).toBe(false);
    expect(verifyTOTP(tokenAt(0), generateMFASecret('other').secret)).toBe(false);
  });

  it('rejects garbage', () => {
    expect(verifyTOTP('', secret)).toBe(false);
    expect(verifyTOTP('abcdef', secret)).toBe(false);
  });
});

describe('backup codes', () => {
  it('generates N distinct 8-char uppercase hex codes with bcrypt hashes that verify', async () => {
    const { codes, hashedCodes } = await generateBackupCodes(4);
    expect(codes).toHaveLength(4);
    expect(hashedCodes).toHaveLength(4);
    expect(new Set(codes).size).toBe(4);
    for (const c of codes) expect(c).toMatch(/^[0-9A-F]{8}$/);
    for (const h of hashedCodes) expect(h.startsWith('$2')).toBe(true);
    expect(hashedCodes).not.toContain(codes[0]);
  });

  it('a valid code is consumed exactly once and the remaining list shrinks by one', async () => {
    const { codes, hashedCodes } = await generateBackupCodes(3);
    const first = await verifyBackupCode(codes[1], hashedCodes);
    expect(first.valid).toBe(true);
    expect(first.remainingCodes).toHaveLength(2);
    expect(first.remainingCodes).not.toContain(hashedCodes[1]);
    // Replay with the already-consumed code against the updated list fails.
    const replay = await verifyBackupCode(codes[1], first.remainingCodes);
    expect(replay.valid).toBe(false);
    expect(replay.remainingCodes).toEqual(first.remainingCodes);
  });

  it('rejects an unknown code without touching the list, and an empty list', async () => {
    const { hashedCodes } = await generateBackupCodes(2);
    const r = await verifyBackupCode('ZZZZZZZZ', hashedCodes);
    expect(r).toEqual({ valid: false, remainingCodes: hashedCodes });
    expect(await verifyBackupCode('ANYTHING', [])).toEqual({ valid: false, remainingCodes: [] });
  });
});

describe('persistence', () => {
  it('enableMFA stores secret, hashed codes and the enabled timestamp', async () => {
    await enableMFA(7, 'SECRET', ['h1', 'h2']);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('mfa_enabled = true');
    expect(sql).toContain('mfa_enabled_at = CURRENT_TIMESTAMP');
    expect(params).toEqual(['SECRET', ['h1', 'h2'], 7]);
  });

  it('disableMFA clears every MFA column', async () => {
    await disableMFA(7);
    const [sql, params] = queryMock.mock.calls[0];
    for (const col of ['mfa_secret = NULL', 'mfa_backup_codes = NULL', 'mfa_enabled_at = NULL', 'last_mfa_verified_at = NULL']) {
      expect(sql).toContain(col);
    }
    expect(params).toEqual([7]);
  });

  it('updateMFAVerificationTime and updateBackupCodes target the user row', async () => {
    await updateMFAVerificationTime(7);
    expect(queryMock.mock.calls[0][0]).toContain('last_mfa_verified_at = CURRENT_TIMESTAMP');
    await updateBackupCodes(7, ['h2']);
    expect(queryMock.mock.calls[1][1]).toEqual([['h2'], 7]);
  });

  it('getMFAStatus maps the row and counts remaining codes; unknown user throws', async () => {
    const enabledAt = new Date('2026-01-01T00:00:00Z');
    queryMock.mockResolvedValueOnce({ rows: [{
      mfa_enabled: true, mfa_secret: 'S', mfa_backup_codes: ['a', 'b', 'c'], mfa_enabled_at: enabledAt, last_mfa_verified_at: null,
    }] });
    expect(await getMFAStatus(7)).toEqual({
      enabled: true, enabledAt, lastVerifiedAt: null, backupCodesRemaining: 3, secret: 'S',
    });
    queryMock.mockResolvedValueOnce({ rows: [{
      mfa_enabled: false, mfa_secret: null, mfa_backup_codes: null, mfa_enabled_at: null, last_mfa_verified_at: null,
    }] });
    expect((await getMFAStatus(8)).backupCodesRemaining).toBe(0);
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(getMFAStatus(9)).rejects.toThrow('User not found');
  });
});
