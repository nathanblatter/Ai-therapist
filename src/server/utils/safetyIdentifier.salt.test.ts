// The OpenAI safety identifier is keyed with a per-environment salt
// (ai-therapist-306). Without it, user 7 on stage, user 7 on prod and user 7
// in a test database shared one identifier (a block is permanent), and anyone
// with a user id could compute it. These tests pin: deterministic per user and
// salt, different across salts and users, the user id not recoverable from the
// salted value, the unsalted fallback unchanged, the one startup warning, and
// that every call site that sends an identifier gets it from this module.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const { queryMock, warnMock } = vi.hoisted(() => ({ queryMock: vi.fn(), warnMock: vi.fn() }));
vi.mock('../config/db.js', () => ({ pool: { query: queryMock, on: vi.fn() } }));
vi.mock('./logger.js', () => ({
  createLogger: () => ({ warn: warnMock, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const {
  SAFETY_IDENTIFIER_SALT_ENV,
  deriveSafetyIdentifier,
  safetyIdentifierForUser,
  safetyIdentifierForParticipantCookie,
  safetyIdentifierForSession,
  warnIfSafetyIdentifierUnsalted,
  _resetSafetyIdentifierStateForTests,
} = await import('./safetyIdentifier.js');

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

beforeEach(() => {
  queryMock.mockReset();
  warnMock.mockReset();
  _resetSafetyIdentifierStateForTests();
  vi.stubEnv(SAFETY_IDENTIFIER_SALT_ENV, '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('salted derivation', () => {
  it('names the variable clearly', () => {
    expect(SAFETY_IDENTIFIER_SALT_ENV).toBe('OPENAI_SAFETY_IDENTIFIER_SALT');
  });

  it('is deterministic for one user and one salt (stable within an environment)', () => {
    vi.stubEnv(SAFETY_IDENTIFIER_SALT_ENV, 'salt-stage');
    const a = safetyIdentifierForUser(7);
    expect(safetyIdentifierForUser(7)).toBe(a);
    expect(safetyIdentifierForUser('7')).toBe(a); // numeric or string id from the session
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs across salts for the same user (stage, prod and test databases no longer collide)', () => {
    vi.stubEnv(SAFETY_IDENTIFIER_SALT_ENV, 'salt-stage');
    const stage = safetyIdentifierForUser(7);
    vi.stubEnv(SAFETY_IDENTIFIER_SALT_ENV, 'salt-prod');
    const prod = safetyIdentifierForUser(7);
    vi.stubEnv(SAFETY_IDENTIFIER_SALT_ENV, '');
    const unsalted = safetyIdentifierForUser(7);
    expect(new Set([stage, prod, unsalted]).size).toBe(3);
  });

  it('differs across users under one salt', () => {
    vi.stubEnv(SAFETY_IDENTIFIER_SALT_ENV, 'salt-stage');
    const ids = new Set(Array.from({ length: 200 }, (_, i) => safetyIdentifierForUser(i + 1)));
    expect(ids.size).toBe(200);
  });

  it('the user id cannot be recovered from the salted value by enumerating ids (it could before)', () => {
    vi.stubEnv(SAFETY_IDENTIFIER_SALT_ENV, 'salt-stage');
    const salted = safetyIdentifierForUser(1234);
    vi.stubEnv(SAFETY_IDENTIFIER_SALT_ENV, '');
    const unsalted = safetyIdentifierForUser(1234);
    const candidates = Array.from({ length: 5000 }, (_, i) => i + 1);
    // The old scheme: anyone can walk the id space and find the match.
    expect(candidates.find((id) => sha256(`user:${id}`) === unsalted)).toBe(1234);
    // The salted value matches no unsalted guess, and no guess under another salt.
    expect(candidates.find((id) => sha256(`user:${id}`) === salted)).toBeUndefined();
    vi.stubEnv(SAFETY_IDENTIFIER_SALT_ENV, 'a-guessed-salt');
    expect(candidates.find((id) => safetyIdentifierForUser(id) === salted)).toBeUndefined();
    expect(salted).not.toContain('1234');
  });

  it('a whitespace-only salt counts as unset', () => {
    vi.stubEnv(SAFETY_IDENTIFIER_SALT_ENV, '   ');
    expect(safetyIdentifierForUser(7)).toBe(sha256('user:7'));
  });
});

describe('unset salt: the previous derivation, unchanged', () => {
  it('user, participant cookie and anonymous session match the old unsalted sha256', async () => {
    expect(safetyIdentifierForUser(7)).toBe(sha256('user:7'));
    expect(safetyIdentifierForParticipantCookie('abc')).toBe(sha256('participant:abc'));
    expect(deriveSafetyIdentifier('anon-session:s1')).toBe(sha256('anon-session:s1'));
    queryMock.mockResolvedValueOnce({ rows: [{ user_id: 7 }] });
    expect(await safetyIdentifierForSession('sess-unsalted')).toBe(sha256('user:7'));
  });
});

describe('safetyIdentifierForSession', () => {
  it("a signed-in session's identifier equals safetyIdentifierForUser (the voice mint and text calls agree)", async () => {
    vi.stubEnv(SAFETY_IDENTIFIER_SALT_ENV, 'salt-stage');
    queryMock.mockResolvedValueOnce({ rows: [{ user_id: 42 }] });
    expect(await safetyIdentifierForSession('sess-1')).toBe(safetyIdentifierForUser(42));
  });

  it('an anonymous session gets a salted session-scoped value; a database error never throws', async () => {
    vi.stubEnv(SAFETY_IDENTIFIER_SALT_ENV, 'salt-stage');
    queryMock.mockResolvedValueOnce({ rows: [{ user_id: null }] });
    const anon = await safetyIdentifierForSession('sess-anon');
    expect(anon).toBe(deriveSafetyIdentifier('anon-session:sess-anon'));
    expect(anon).not.toBe(sha256('anon-session:sess-anon'));
    queryMock.mockRejectedValueOnce(new Error('db down'));
    await expect(safetyIdentifierForSession('sess-err')).resolves.toBe(deriveSafetyIdentifier('anon-session:sess-err'));
  });
});

describe('warnIfSafetyIdentifierUnsalted', () => {
  it('warns once in production when the salt is unset', () => {
    const env = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
    expect(warnIfSafetyIdentifierUnsalted(env)).toBe(true);
    expect(warnIfSafetyIdentifierUnsalted(env)).toBe(false);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(String(warnMock.mock.calls[0][0])).toContain('OPENAI_SAFETY_IDENTIFIER_SALT is not set');
  });

  it('is silent when the salt is set, and outside production', () => {
    expect(
      warnIfSafetyIdentifierUnsalted({
        NODE_ENV: 'production',
        OPENAI_SAFETY_IDENTIFIER_SALT: 'x',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(warnIfSafetyIdentifierUnsalted({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(false);
    expect(warnIfSafetyIdentifierUnsalted({} as NodeJS.ProcessEnv)).toBe(false);
    expect(warnMock).not.toHaveBeenCalled();
  });
});

// Every server file that puts a safety identifier on an OpenAI request. A new
// call site fails this test until it is added here, and each one must take
// the value from safetyIdentifier.ts rather than hashing an id itself.
describe('every call site uses the one helper', () => {
  const SERVER = path.resolve(import.meta.dirname, '..');
  const EXPECTED_SENDERS = [
    'routes/public/liveSession.routes.ts', // voice mint header
    'services/chatTherapy.service.ts', // chat reply
    'services/crisisDetection.service.ts', // crisis assessor
    'services/sidebandManager.service.ts', // sideband attach header + mid-session summary
  ];

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return sourceFiles(p);
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
    });
  }
  const files = sourceFiles(SERVER).map((p) => ({ rel: path.relative(SERVER, p), src: fs.readFileSync(p, 'utf8') }));

  it('the files that send an identifier are exactly the known call sites', () => {
    const senders = files
      .filter((f) => /safety_identifier\s*:|'OpenAI-Safety-Identifier'\s*:/.test(f.src))
      .map((f) => f.rel)
      .sort();
    expect(senders).toEqual([...EXPECTED_SENDERS].sort());
  });

  it('each call site takes the identifier from safetyIdentifier.ts', () => {
    for (const rel of EXPECTED_SENDERS) {
      const src = files.find((f) => f.rel === rel)!.src;
      expect(src, rel).toMatch(/utils\/safetyIdentifier\.js/);
      expect(src, rel).toMatch(/safetyIdentifierFor(Session|User|ParticipantCookie)\(/);
    }
  });

  it('nothing else derives an identifier from a user id or a participant cookie', () => {
    const offenders = files
      .filter((f) => f.rel !== path.join('utils', 'safetyIdentifier.ts'))
      .filter((f) => /(hashToken|sha256Hex)\(\s*`(user|participant|anon-session):/.test(f.src))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
