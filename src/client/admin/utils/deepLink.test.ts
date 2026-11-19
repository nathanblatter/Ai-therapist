// ai-therapist-373: the participant deep link a crisis page carries when its
// session was never stored.
import { describe, it, expect } from 'vitest';
import { participantFromHash } from './deepLink';

describe('participantFromHash', () => {
  it.each([
    ['#participant=7', 7],
    ['#foo=1&participant=2147483647', 2147483647],
    ['#participant=12&other=x', 12],
  ])('%s -> %s', (hash, id) => {
    expect(participantFromHash(hash)).toBe(id);
  });

  it.each([
    '',
    '#session=chat_1',
    '#participant=',
    '#participant=abc',
    '#participant=0',
    '#participant=7x',
    '#xparticipant=7',
  ])('%s -> null', (hash) => {
    expect(participantFromHash(hash)).toBeNull();
  });
});
