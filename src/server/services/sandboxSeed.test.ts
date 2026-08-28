// Sandbox seeding invariants (caseworker portal, spec section 7): the seed is
// deterministic per token_hash, runs in one transaction, marks every seeded
// user is_sandbox and every session is_demo, always stamps content_redacted
// on transcripts (so the redaction sweep never LLM-redacts sandbox data), and
// rolls back cleanly on failure.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { clientQuery, clientRelease, connectMock, poolQuery } = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
  connectMock: vi.fn(),
  poolQuery: vi.fn(),
}));

vi.mock('../config/db.js', () => ({
  pool: { query: poolQuery, connect: connectMock, on: vi.fn() },
}));

// Keep the suite fast: one real bcrypt hash costs ~80ms at cost 10.
vi.mock('bcrypt', () => ({
  default: { hash: vi.fn().mockResolvedValue('$2b$10$fakefakefakefakefakefake') },
}));

import { mulberry32, seedFromTokenHash, seedSandboxCaseload } from './sandboxSeed.js';
import { SANDBOX_PERSONAS, CRISIS_PERSONA_HANDLE, BRAND_NEW_PERSONA_HANDLE } from './sandboxSeed.fixtures.js';

const TOKEN_HASH = 'a1b2c3d4'.repeat(8);

function installHappyClient() {
  let nextId = 1000;
  clientQuery.mockImplementation(async (sql: string) => {
    if (/RETURNING userid/.test(sql)) return { rows: [{ userid: nextId++ }], rowCount: 1 };
    if (/RETURNING escalation_id/.test(sql)) return { rows: [{ escalation_id: nextId++ }], rowCount: 1 };
    if (/RETURNING note_id/.test(sql)) return { rows: [{ note_id: nextId++ }], rowCount: 1 };
    if (/RETURNING event_id/.test(sql)) return { rows: [{ event_id: nextId++ }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
}

beforeEach(() => {
  clientQuery.mockReset();
  clientRelease.mockReset();
  connectMock.mockReset().mockResolvedValue({ query: clientQuery, release: clientRelease });
  installHappyClient();
});

const INPUT = {
  ownerId: 42,
  ownerUsername: 'demo_owner',
  ownerRole: 'therapist' as const,
  orgId: 7,
  tokenHash: TOKEN_HASH,
};

/** All non-transaction calls as [sql, params]. */
function seedCalls(): Array<[string, unknown[]]> {
  return clientQuery.mock.calls
    .filter(([sql]) => !/^(BEGIN|COMMIT|ROLLBACK)$/.test(String(sql)))
    .map(([sql, params]) => [String(sql), (params as unknown[]) ?? []]);
}

describe('mulberry32 / seedFromTokenHash', () => {
  it('is deterministic for the same seed and differs across seeds', () => {
    const a1 = mulberry32(123);
    const a2 = mulberry32(123);
    const b = mulberry32(456);
    const seqA1 = [a1(), a1(), a1()];
    const seqA2 = [a2(), a2(), a2()];
    const seqB = [b(), b(), b()];
    expect(seqA1).toEqual(seqA2);
    expect(seqA1).not.toEqual(seqB);
    for (const v of seqA1) expect(v).toBeGreaterThanOrEqual(0);
    for (const v of seqA1) expect(v).toBeLessThan(1);
  });

  it('derives a stable 32-bit seed from a sha256-hex token hash', () => {
    expect(seedFromTokenHash(TOKEN_HASH)).toBe(seedFromTokenHash(TOKEN_HASH));
    expect(seedFromTokenHash('ffffffff' + '0'.repeat(56))).toBe(0xffffffff);
    expect(seedFromTokenHash('not-hex!')).toBe(0);
  });
});

describe('seedSandboxCaseload', () => {
  it('runs in one committed transaction and releases the client', async () => {
    const result = await seedSandboxCaseload(INPUT);
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql));
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(sqls).not.toContain('ROLLBACK');
    expect(clientRelease).toHaveBeenCalledOnce();
    expect(result.clientIds.length).toBeGreaterThanOrEqual(6);
    expect(result.clientIds.length).toBeLessThanOrEqual(9);
    expect(result.seededUserIds).toEqual([...result.clientIds, result.counterpartId]);
    expect(result.escalationId).toBeGreaterThan(0);
  });

  it('every seeded user is is_sandbox and org-scoped; clients are participants', async () => {
    await seedSandboxCaseload(INPUT);
    const userInserts = seedCalls().filter(([sql]) => sql.includes('INSERT INTO users'));
    expect(userInserts.length).toBeGreaterThanOrEqual(7); // 6-9 clients + counterpart
    for (const [sql, params] of userInserts) {
      expect(sql).toContain('is_sandbox');
      expect(sql).toContain('TRUE');
      expect(params[3]).toBe(7); // organization_id
    }
    const participantInserts = userInserts.filter(([, params]) => params[2] === 'participant');
    expect(participantInserts.length).toBe(userInserts.length - 1);
    // Therapist owner gets a caseworker counterpart for escalation demos.
    const counterpart = userInserts.find(([, params]) => params[2] !== 'participant');
    expect(counterpart?.[1][2]).toBe('caseworker');
  });

  it('every session is is_demo=TRUE and ended; transcripts always stamp content_redacted', async () => {
    await seedSandboxCaseload(INPUT);
    const calls = seedCalls();
    const sessionInserts = calls.filter(([sql]) => sql.includes('INSERT INTO therapy_sessions'));
    expect(sessionInserts.length).toBeGreaterThan(10);
    for (const [sql] of sessionInserts) {
      expect(sql).toContain('TRUE'); // is_demo
      expect(sql).toContain("'ended'");
    }
    const messageInserts = calls.filter(([sql]) => sql.includes('INSERT INTO messages'));
    expect(messageInserts.length).toBeGreaterThan(50);
    for (const [sql] of messageInserts) {
      // content and content_redacted bound to the SAME parameter.
      expect(sql).toContain('$3, $3');
    }
  });

  it('always includes the crisis and brand-new personas, with crisis artifacts', async () => {
    await seedSandboxCaseload(INPUT);
    const calls = seedCalls();
    const usernames = calls
      .filter(([sql]) => sql.includes('INSERT INTO users'))
      .map(([, params]) => String(params[0]));
    expect(usernames).toContain(`sbx_${CRISIS_PERSONA_HANDLE}_7`);
    expect(usernames).toContain(`sbx_${BRAND_NEW_PERSONA_HANDLE}_7`);

    const crisisEvents = calls.filter(([sql]) => sql.includes('INSERT INTO crisis_events'));
    expect(crisisEvents.length).toBeGreaterThanOrEqual(4); // resolved arc + open flag
    expect(calls.some(([sql]) => sql.includes('INSERT INTO safety_plans'))).toBe(true);
    expect(calls.some(([sql]) => sql.includes('INSERT INTO escalations'))).toBe(true);
    expect(calls.some(([sql]) => sql.includes('INSERT INTO work_items'))).toBe(true);
    // The open flag also marks the session row.
    expect(calls.some(([sql]) => sql.includes('SET crisis_flagged = TRUE'))).toBe(true);
  });

  it('is deterministic per token_hash: same personas and usernames on re-run', async () => {
    await seedSandboxCaseload(INPUT);
    const first = seedCalls()
      .filter(([sql]) => sql.includes('INSERT INTO users'))
      .map(([, params]) => params[0]);
    clientQuery.mockClear();
    installHappyClient();
    await seedSandboxCaseload(INPUT);
    const second = seedCalls()
      .filter(([sql]) => sql.includes('INSERT INTO users'))
      .map(([, params]) => params[0]);
    expect(second).toEqual(first);

    // A different token hash picks a different caseload shape or membership.
    clientQuery.mockClear();
    installHappyClient();
    await seedSandboxCaseload({ ...INPUT, tokenHash: 'deadbeef'.repeat(8) });
    const third = seedCalls()
      .filter(([sql]) => sql.includes('INSERT INTO users'))
      .map(([, params]) => params[0]);
    expect(third).not.toEqual(first);
  });

  it('caseworker owner: caseworker-authored case notes and a therapist counterpart', async () => {
    await seedSandboxCaseload({ ...INPUT, ownerRole: 'caseworker' });
    const calls = seedCalls();
    const noteInserts = calls.filter(([sql]) => sql.includes('INSERT INTO care_notes'));
    expect(noteInserts.length).toBeGreaterThan(0);
    for (const [, params] of noteInserts) {
      expect(params[4]).toBe('caseworker'); // author_role
      expect(params[5]).toBe('case'); // note_type
    }
    const counterpart = calls.find(
      ([sql, params]) => sql.includes('INSERT INTO users') && params[2] !== 'participant'
    );
    expect(counterpart?.[1][2]).toBe('therapist');
  });

  it('rolls back and rethrows when any insert fails', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (/INSERT INTO therapy_sessions/.test(sql)) throw new Error('disk full');
      if (/RETURNING userid/.test(sql)) return { rows: [{ userid: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    await expect(seedSandboxCaseload(INPUT)).rejects.toThrow('disk full');
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql));
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
    expect(clientRelease).toHaveBeenCalledOnce();
  });

  it('fixture pool sanity: crisis persona exists and has a safety plan', () => {
    const crisis = SANDBOX_PERSONAS.find((p) => p.handle === CRISIS_PERSONA_HANDLE);
    expect(crisis?.crisis).toBe(true);
    expect(crisis?.safetyPlan).toBeTruthy();
    expect(SANDBOX_PERSONAS.length).toBeGreaterThanOrEqual(10);
    for (const p of SANDBOX_PERSONAS) {
      expect(p.showcase).toHaveLength(2);
      for (const transcript of p.showcase) {
        expect(transcript.length).toBeGreaterThanOrEqual(12);
        expect(transcript.length).toBeLessThanOrEqual(16);
      }
    }
  });
});
