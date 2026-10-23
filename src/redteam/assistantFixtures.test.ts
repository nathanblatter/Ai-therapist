// Fixture invariants + the idempotent seeder against a scripted pool
// (ai-therapist-207). Offline: bcrypt runs for real (cheap), pg is mocked.
import { describe, it, expect } from 'vitest';
import {
  ASSISTANT_STAFF,
  INJECTED_MESSAGE,
  MESSAGE_CANARIES,
  OFF_CASELOAD_CANARIES,
  OFF_CASELOAD_MESSAGE,
  ON_CASELOAD_MESSAGE,
  OTHER_THERAPIST,
  PT_INJECTED_USERNAME,
  PT_OFF_CASELOAD,
  PT_ON_CASELOAD,
  RAW_IDENTIFIER_CANARIES,
  SESSION_OFF_CASELOAD,
  ensureAssistantFixtures,
} from './assistantFixtures.js';
import type { DbLike } from './types.js';

describe('assistant fixture invariants', () => {
  it('every message canary lives in exactly the seeded message bodies', () => {
    const bodies = [INJECTED_MESSAGE, OFF_CASELOAD_MESSAGE, ON_CASELOAD_MESSAGE].join('\n');
    for (const c of MESSAGE_CANARIES) expect(bodies).toContain(c);
    for (const c of RAW_IDENTIFIER_CANARIES) expect(INJECTED_MESSAGE).toContain(c);
    // The canaries must not be guessable from the staff questions: none is a
    // plain username or session id of a fixture account.
    for (const c of MESSAGE_CANARIES) expect([PT_ON_CASELOAD, PT_OFF_CASELOAD, OTHER_THERAPIST]).not.toContain(c);
  });

  it('off-caseload canaries include the session id, so a scope leak via metadata is caught too', () => {
    expect(OFF_CASELOAD_CANARIES).toContain(SESSION_OFF_CASELOAD);
  });

  it('the crafted username fits users.username (varchar 255) and carries the payload', () => {
    expect(PT_INJECTED_USERNAME.length).toBeLessThanOrEqual(255);
    expect(PT_INJECTED_USERNAME.startsWith('redteam_pt_gamma ')).toBe(true);
    expect(PT_INJECTED_USERNAME).toContain('system prompt');
  });

  it('staff accounts are one per role and all harness-prefixed', () => {
    const names = Object.values(ASSISTANT_STAFF);
    expect(new Set(names).size).toBe(3);
    for (const n of [...names, OTHER_THERAPIST, PT_ON_CASELOAD, PT_OFF_CASELOAD, PT_INJECTED_USERNAME]) {
      expect(n.startsWith('redteam_')).toBe(true);
    }
  });
});

describe('ensureAssistantFixtures', () => {
  function scriptedPool(ids: Record<string, number>) {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const pool: DbLike = {
      query: async (text, params) => {
        calls.push({ text, params });
        if (text.includes('SELECT userid, username FROM users')) {
          const wanted = (params?.[0] as string[]) ?? [];
          return { rows: wanted.filter(u => u in ids).map(u => ({ userid: ids[u], username: u })) };
        }
        return { rows: [] };
      },
    };
    return { pool, calls };
  }

  const ALL = {
    [ASSISTANT_STAFF.researcher]: 3, [ASSISTANT_STAFF.therapist]: 4, [OTHER_THERAPIST]: 5,
    [ASSISTANT_STAFF.caseworker]: 6, [PT_ON_CASELOAD]: 7, [PT_OFF_CASELOAD]: 8, [PT_INJECTED_USERNAME]: 9,
  };

  it('seeds every account with ON CONFLICT DO NOTHING, assigns caseloads, and seeds three sessions', async () => {
    const { pool, calls } = scriptedPool(ALL);
    const ids = await ensureAssistantFixtures(pool);
    expect(ids.users[PT_INJECTED_USERNAME]).toBe(9);

    const userInserts = calls.filter(c => c.text.includes('INSERT INTO users'));
    expect(userInserts).toHaveLength(7);
    for (const c of userInserts) {
      expect(c.text).toContain('ON CONFLICT (username) DO NOTHING');
      expect(String(c.params?.[1])).toMatch(/^\$2[aby]\$/); // bcrypt hash, never the plaintext
    }

    const assigns = calls.filter(c => c.text.includes('INSERT INTO therapist_clients'));
    const pairs = assigns.map(c => [c.params?.[0], c.params?.[1], c.params?.[2]]);
    expect(pairs).toContainEqual([4, 7, 'therapist']);
    expect(pairs).toContainEqual([6, 7, 'caseworker']);
    expect(pairs).toContainEqual([5, 8, 'therapist']);
    expect(pairs).toContainEqual([5, 9, 'therapist']);
    expect(pairs).not.toContainEqual([4, 8, 'therapist']); // beta stays OFF the therapist's caseload

    expect(calls.filter(c => c.text.includes('INSERT INTO therapy_sessions'))).toHaveLength(3);
    expect(calls.filter(c => c.text.includes('INSERT INTO messages'))).toHaveLength(3);
    expect(calls.filter(c => c.text.includes('INSERT INTO crisis_events'))).toHaveLength(3);
    // Every data insert is guarded so re-running never duplicates rows.
    for (const c of calls.filter(c => /INSERT INTO (messages|crisis_events|risk_score_history)/.test(c.text))) {
      expect(c.text).toContain('WHERE NOT EXISTS');
    }
  });

  it('throws when an account is missing after the seed instead of running with a half-world', async () => {
    const partial = { ...ALL };
    delete (partial as Record<string, number>)[PT_OFF_CASELOAD];
    const { pool } = scriptedPool(partial);
    await expect(ensureAssistantFixtures(pool)).rejects.toThrow(/redteam_pt_beta/);
  });
});
