import { describe, it, expect } from 'vitest';
import { sessionLimitNotice, sessionLimitTitle } from './sessionLimitNotice';

describe('sessionLimitNotice (ai-therapist-324)', () => {
  it('prefers the server retry sentence (the screen lists the resources itself)', () => {
    const n = sessionLimitNotice({
      reason: 'cooldown',
      minutes_remaining: 28,
      retry_message: 'You can start your next session in 28 minutes.',
      message: 'You can start your next session in 28 minutes. If you would like support before then, ...',
    });
    expect(n).toEqual({ reason: 'cooldown', retryText: 'You can start your next session in 28 minutes.' });
  });

  it('derives the time from minutes_remaining when an older body has no text', () => {
    expect(sessionLimitNotice({ reason: 'cooldown', minutes_remaining: 1 }).retryText).toBe(
      'You can start your next session in 1 minute.',
    );
  });

  it('never shows an empty screen, even for a body that was not JSON', () => {
    for (const body of [null, undefined, 'Too many requests', {}]) {
      const n = sessionLimitNotice(body);
      expect(n.reason).toBe('unknown');
      expect(n.retryText.length).toBeGreaterThan(10);
    }
  });

  it('has a plain title per reason', () => {
    expect(sessionLimitTitle('cooldown')).toBe('Your next session opens soon');
    expect(sessionLimitTitle('daily_limit')).toMatch(/today/);
    expect(sessionLimitTitle('unknown')).toBeTruthy();
  });
});
