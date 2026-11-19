// A crisis page's admin deep link carried across sign-in (sessionStorage on
// /login, restored on /admin). Times are offsets from an arbitrary epoch, not
// the real clock.
import { describe, it, expect, vi } from 'vitest';
import {
  MAX_DEEP_LINK_HASH_LENGTH,
  PENDING_DEEP_LINK_KEY,
  PENDING_DEEP_LINK_TTL_MS,
  canonicalDeepLink,
  restorePendingDeepLink,
  savePendingDeepLink,
} from './pendingDeepLink';
import { sessionFromHash } from './deepLink';

const T0 = 1_000_000;

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: vi.fn((k: string) => data.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => void data.set(k, v)),
    removeItem: vi.fn((k: string) => void data.delete(k)),
  };
}

const stored = (hash: unknown, ...savedAt: unknown[]) => ({
  [PENDING_DEEP_LINK_KEY]: JSON.stringify({ hash, savedAt: savedAt.length ? savedAt[0] : T0 }),
});

const ADMIN = { pathname: '/admin', search: '', hash: '' };

function restore(
  storage: ReturnType<typeof memoryStorage>,
  location: { pathname: string; search: string; hash: string } = ADMIN,
  now = T0 + 1000,
) {
  const replaceUrl = vi.fn();
  const restored = restorePendingDeepLink(storage, location, now, replaceUrl);
  return { restored, replaceUrl };
}

const HOSTILE = [
  '#participant=7&next=//evil',
  '#session=chat_1&next=//evil.example',
  '#javascript:alert(1)',
  '#session=javascript:alert(1)',
  '#session=../../logout',
  '#session=%2F%2Fevil',
  '#session=a#b',
  '#participant=7#x',
  '#tab#participant=7',
  '#x#session=chat_1',
  '#participant=-1',
  '#participant=0',
  '#participant=99999999999999999999',
  `#session=${'a'.repeat(129)}`,
  `#session=${'a'.repeat(MAX_DEEP_LINK_HASH_LENGTH)}`,
  `#participant=${'1'.repeat(MAX_DEEP_LINK_HASH_LENGTH)}`,
  '#tab=sessions',
  '#foo=1&session=chat_1',
  '#session=',
  '#',
  '',
  'https://evil.example/#session=chat_1',
  '//evil.example#session=chat_1',
  '/admin#session=chat_1',
];

describe('sessionFromHash', () => {
  it.each([
    ['#session=chat_1700000000000_abc12', 'chat_1700000000000_abc12'],
    ['#session=grok_123e4567-e89b-12d3-a456-426614174000', 'grok_123e4567-e89b-12d3-a456-426614174000'],
    ['#session=sbx-3-1-2&x=1', 'sbx-3-1-2'],
  ])('%s -> %s', (hash, id) => expect(sessionFromHash(hash)).toBe(id));

  it.each(['', '#session=', '#session=a/b', '#session=a%20b', `#session=${'a'.repeat(129)}`, '#xsession=a'])(
    '%s -> null',
    (hash) => expect(sessionFromHash(hash)).toBeNull(),
  );
});

describe('canonicalDeepLink', () => {
  it.each([
    ['#session=chat_1700000000000_abc12', '#session=chat_1700000000000_abc12'],
    ['#session=grok_123e4567-e89b-12d3-a456-426614174000', '#session=grok_123e4567-e89b-12d3-a456-426614174000'],
    [`#session=${'a'.repeat(128)}`, `#session=${'a'.repeat(128)}`],
    ['#participant=7', '#participant=7'],
    ['#participant=007', '#participant=7'],
  ])('%s -> %s', (hash, out) => expect(canonicalDeepLink(hash)).toBe(out));

  it.each(HOSTILE)('rejects %s', (hash) => expect(canonicalDeepLink(hash)).toBeNull());

  it.each([null, undefined, 7, {}, ['#participant=7']])('rejects non-string %s', (v) =>
    expect(canonicalDeepLink(v)).toBeNull(),
  );
});

describe('savePendingDeepLink (sign-in page)', () => {
  it('stores the canonical link with the time it was saved', () => {
    const storage = memoryStorage();
    expect(savePendingDeepLink(storage, '#session=chat_1_x', T0)).toBe('#session=chat_1_x');
    expect(JSON.parse(storage.data.get(PENDING_DEEP_LINK_KEY)!)).toEqual({ hash: '#session=chat_1_x', savedAt: T0 });
  });

  it.each(HOSTILE)('stores nothing for %s', (hash) => {
    const storage = memoryStorage();
    expect(savePendingDeepLink(storage, hash, T0)).toBeNull();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('leaves an earlier link alone when the page has no hash (Squawk returns to /login without one)', () => {
    const storage = memoryStorage(stored('#participant=7'));
    expect(savePendingDeepLink(storage, '', T0)).toBeNull();
    expect(storage.data.get(PENDING_DEEP_LINK_KEY)).toBe(stored('#participant=7')[PENDING_DEEP_LINK_KEY]);
  });

  it('survives storage that throws', () => {
    const storage = memoryStorage();
    storage.setItem.mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(savePendingDeepLink(storage, '#participant=7', T0)).toBeNull();
  });
});

describe('restorePendingDeepLink (admin page, after sign-in)', () => {
  it.each(['#session=chat_1_x', '#participant=42'])('puts %s back on /admin and uses it once', (hash) => {
    const storage = memoryStorage(stored(hash));
    const { restored, replaceUrl } = restore(storage);
    expect(restored).toBe(hash);
    expect(replaceUrl).toHaveBeenCalledWith(`/admin${hash}`);
    expect(storage.data.has(PENDING_DEEP_LINK_KEY)).toBe(false);
    expect(restore(storage).restored).toBeNull();
  });

  it('keeps the query string', () => {
    const { replaceUrl } = restore(memoryStorage(stored('#participant=42')), { ...ADMIN, search: '?a=1' });
    expect(replaceUrl).toHaveBeenCalledWith('/admin?a=1#participant=42');
  });

  it('round-trips through save', () => {
    const storage = memoryStorage();
    savePendingDeepLink(storage, '#participant=9', T0);
    expect(restore(storage, ADMIN, T0 + PENDING_DEEP_LINK_TTL_MS).restored).toBe('#participant=9');
  });

  it.each(HOSTILE)('restores nothing for a stored %s (tampered storage)', (hash) => {
    const storage = memoryStorage(stored(hash));
    const { restored, replaceUrl } = restore(storage);
    expect(restored).toBeNull();
    expect(replaceUrl).not.toHaveBeenCalled();
    expect(storage.data.has(PENDING_DEEP_LINK_KEY)).toBe(false);
  });

  it.each([
    ['older than the TTL', T0 - PENDING_DEEP_LINK_TTL_MS - 1],
    ['saved in the future', T0 + 1001],
    ['a string time', String(T0)],
    ['a missing time', undefined],
    ['null (NaN serialised)', Number.NaN],
  ])('restores nothing when savedAt is %s', (_label, savedAt) => {
    const storage = memoryStorage(stored('#participant=7', savedAt));
    const { restored, replaceUrl } = restore(storage, ADMIN, T0 + 1000);
    expect(restored).toBeNull();
    expect(replaceUrl).not.toHaveBeenCalled();
  });

  it('restores at exactly the TTL and not one millisecond after', () => {
    expect(restore(memoryStorage(stored('#participant=7')), ADMIN, T0 + PENDING_DEEP_LINK_TTL_MS).restored).toBe(
      '#participant=7',
    );
    expect(
      restore(memoryStorage(stored('#participant=7')), ADMIN, T0 + PENDING_DEEP_LINK_TTL_MS + 1).restored,
    ).toBeNull();
  });

  it.each(['not json', 'null', '"#participant=7"', '[]', '{}'])('restores nothing for stored %s', (raw) => {
    const storage = memoryStorage({ [PENDING_DEEP_LINK_KEY]: raw });
    expect(restore(storage).restored).toBeNull();
    expect(storage.data.has(PENDING_DEEP_LINK_KEY)).toBe(false);
  });

  it('a hash already on the page wins, and the stored link is dropped', () => {
    const storage = memoryStorage(stored('#participant=7'));
    const { restored, replaceUrl } = restore(storage, { ...ADMIN, hash: '#session=chat_2' });
    expect(restored).toBeNull();
    expect(replaceUrl).not.toHaveBeenCalled();
    expect(storage.data.has(PENDING_DEEP_LINK_KEY)).toBe(false);
  });

  it.each(['/', '/login', '/admin/', '/adminx'])('restores nothing on %s', (pathname) => {
    const { restored, replaceUrl } = restore(memoryStorage(stored('#participant=7')), { ...ADMIN, pathname });
    expect(restored).toBeNull();
    expect(replaceUrl).not.toHaveBeenCalled();
  });

  it('does nothing when nothing is stored', () => {
    const { restored, replaceUrl } = restore(memoryStorage());
    expect(restored).toBeNull();
    expect(replaceUrl).not.toHaveBeenCalled();
  });

  it('survives storage that throws', () => {
    const storage = memoryStorage(stored('#participant=7'));
    storage.getItem.mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(restore(storage).restored).toBeNull();
  });
});
