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
  OTHER_ORG_CANARIES,
  OTHER_ORG_MESSAGE,
  OTHER_ORG_SLUG,
  OTHER_THERAPIST,
  PT_INJECTED_USERNAME,
  PT_OFF_CASELOAD,
  PT_ON_CASELOAD,
  PT_OTHER_ORG,
  RAW_IDENTIFIER_CANARIES,
  SESSION_OFF_CASELOAD,
  SESSION_OTHER_ORG,
  ensureAssistantFixtures,
} from './assistantFixtures.js';
import type { DbLike } from './types.js';

describe('assistant fixture invariants', () => {
  it('every message canary lives in exactly the seeded message bodies', () => {
    const bodies = [INJECTED_MESSAGE, OFF_CASELOAD_MESSAGE, ON_CASELOAD_MESSAGE, OTHER_ORG_MESSAGE].join('\n');
    for (const c of MESSAGE_CANARIES) expect(bodies).toContain(c);
    for (const c of RAW_IDENTIFIER_CANARIES) expect(INJECTED_MESSAGE).toContain(c);
    // The canaries must not be guessable from the staff questions: none is a
    // plain username or session id of a fixture account.
    for (const c of MESSAGE_CANARIES) expect([PT_ON_CASELOAD, PT_OFF_CASELOAD, PT_OTHER_ORG, OTHER_THERAPIST]).not.toContain(c);
  });

  it('off-caseload canaries include the session id, so a scope leak via metadata is caught too', () => {
    expect(OFF_CASELOAD_CANARIES).toContain(SESSION_OFF_CASELOAD);
  });

  it('other-org canaries cover the username, the session id and the message body (ai-therapist-277)', () => {
    expect(OTHER_ORG_CANARIES).toContain(PT_OTHER_ORG);
    expect(OTHER_ORG_CANARIES).toContain(SESSION_OTHER_ORG);
    // The username must not collide with the irb-study participants' prefixes
    // as a substring, or an in-scope row would trip the canary.
    for (const n of [PT_ON_CASELOAD, PT_OFF_CASELOAD, PT_INJECTED_USERNAME]) expect(n).not.toContain(PT_OTHER_ORG);
    expect(OTHER_ORG_SLUG).not.toBe('irb-study');
  });

  it('the crafted username fits users.username (varchar 255) and carries the payload', () => {
    expect(PT_INJECTED_USERNAME.length).toBeLessThanOrEqual(255);
    expect(PT_INJECTED_USERNAME.startsWith('redteam_pt_gamma ')).toBe(true);
    expect(PT_INJECTED_USERNAME).toContain('system prompt');
  });

  it('staff accounts are one per role and all harness-prefixed', () => {
    const names = Object.values(ASSISTANT_STAFF);
    expect(new Set(names).size).toBe(3);
    for (const n of [...names, OTHER_THERAPIST, PT_ON_CASELOAD, PT_OFF_CASELOAD, PT_INJECTED_USERNAME, PT_OTHER_ORG]) {
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
    [PT_OTHER_ORG]: 10,
  };

  it('seeds every account with ON CONFLICT DO NOTHING, assigns caseloads, and seeds four sessions', async () => {
    const { pool, calls } = scriptedPool(ALL);
    const ids = await ensureAssistantFixtures(pool);
    expect(ids.users[PT_INJECTED_USERNAME]).toBe(9);
    expect(ids.users[PT_OTHER_ORG]).toBe(10);

    const orgInserts = calls.filter(c => c.text.includes('INSERT INTO organizations'));
    expect(orgInserts).toHaveLength(1);
    expect(orgInserts[0].text).toContain('ON CONFLICT (slug) DO NOTHING');
    expect(orgInserts[0].params).toEqual([OTHER_ORG_SLUG]);

    const userInserts = calls.filter(c => c.text.includes('INSERT INTO users'));
    expect(userInserts).toHaveLength(8);
    for (const c of userInserts) {
      expect(c.text).toContain('ON CONFLICT (username) DO NOTHING');
      expect(String(c.params?.[1])).toMatch(/^\$2[aby]\$/); // bcrypt hash, never the plaintext
    }
    // Only the cross-org participant lands outside irb-study (ai-therapist-277).
    const orgOf = Object.fromEntries(userInserts.map(c => [c.params?.[0], c.params?.[3]]));
    expect(orgOf[PT_OTHER_ORG]).toBe(OTHER_ORG_SLUG);
    for (const [name, slug] of Object.entries(orgOf)) if (name !== PT_OTHER_ORG) expect(slug).toBe('irb-study');
    const orgFix = calls.filter(c => c.text.includes('UPDATE users SET organization_id'));
    expect(orgFix).toHaveLength(1);
    expect(orgFix[0].params).toEqual([PT_OTHER_ORG, OTHER_ORG_SLUG]);

    const assigns = calls.filter(c => c.text.includes('INSERT INTO therapist_clients'));
    const pairs = assigns.map(c => [c.params?.[0], c.params?.[1], c.params?.[2]]);
    expect(pairs).toContainEqual([4, 7, 'therapist']);
    expect(pairs).toContainEqual([6, 7, 'caseworker']);
    expect(pairs).toContainEqual([5, 8, 'therapist']);
    expect(pairs).toContainEqual([5, 9, 'therapist']);
    expect(pairs).not.toContainEqual([4, 8, 'therapist']); // beta stays OFF the therapist's caseload
    expect(pairs.some(p => p[1] === 10)).toBe(false); // delta is on nobody's caseload

    expect(calls.filter(c => c.text.includes('INSERT INTO therapy_sessions'))).toHaveLength(4);
    expect(calls.filter(c => c.text.includes('INSERT INTO messages'))).toHaveLength(4);
    expect(calls.filter(c => c.text.includes('INSERT INTO crisis_events'))).toHaveLength(4);
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
