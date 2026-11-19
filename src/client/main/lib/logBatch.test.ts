import { describe, it, expect } from 'vitest';
import { requeueLogBatch, shouldRequeueLogBatch } from './logBatch';

describe('the browser keeps a transcript batch the server could not store (ai-therapist-369)', () => {
  it('re-sends after a network failure or any 5xx', () => {
    expect(shouldRequeueLogBatch(null)).toBe(true);
    expect(shouldRequeueLogBatch(500)).toBe(true);
    expect(shouldRequeueLogBatch(503)).toBe(true);
  });

  it('drops a batch the server accepted or refused for good', () => {
    expect(shouldRequeueLogBatch(200)).toBe(false);
    expect(shouldRequeueLogBatch(400)).toBe(false);
    expect(shouldRequeueLogBatch(403)).toBe(false);
  });

  it('puts the failed batch back in front, in order', () => {
    expect(requeueLogBatch(['a', 'b'], ['c'])).toEqual(['a', 'b', 'c']);
  });
});
