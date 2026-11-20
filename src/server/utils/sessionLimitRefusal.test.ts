import { describe, it, expect, vi } from 'vitest';

vi.mock('./sessionHelpers.js', () => ({ getSystemConfig: vi.fn() }));

import {
  buildSessionLimitRefusal,
  buildTooManyAttemptsRefusal,
  formatWait,
  resolveCrisisResources,
} from './sessionLimitRefusal.js';

const COOLDOWN = {
  allowed: false as const,
  reason: 'cooldown' as const,
  message: 'internal',
  cooldown_minutes: 30,
  minutes_remaining: 28,
};
const DAILY = { allowed: false as const, reason: 'daily_limit' as const, message: 'internal', limit: 3, current: 3 };
const CONFIGURED = {
  hotline: '988 Suicide & Crisis Lifeline',
  phone: '988',
  text: 'Text HOME to 741741',
  enabled: true,
};

describe('formatWait', () => {
  it('reads naturally at every scale', () => {
    expect(formatWait(1)).toBe('1 minute');
    expect(formatWait(28)).toBe('28 minutes');
    expect(formatWait(60)).toBe('1 hour');
    expect(formatWait(125)).toBe('2 hours and 5 minutes');
    expect(formatWait(0)).toBe('1 minute');
  });
});

describe('buildSessionLimitRefusal (ai-therapist-324)', () => {
  it('a cooldown says when they can return and offers the crisis resources', () => {
    const body = buildSessionLimitRefusal(COOLDOWN, CONFIGURED);
    expect(body.error).toBe('rate_limit_exceeded');
    expect(body.reason).toBe('cooldown');
    expect(body.minutes_remaining).toBe(28);
    expect(body.details.minutes_remaining).toBe(28);
    expect(body.retry_message).toBe(
      'You can start your next session in 28 minutes. There is a short break between sessions for everyone in the study.',
    );
    expect(body.message).toBe(
      `${body.retry_message} If you would like support before then, you can reach the 988 Suicide & Crisis Lifeline any time at 988, or text HOME to 741741.`,
    );
    expect(body.crisis_resources).toEqual({ hotline: CONFIGURED.hotline, phone: '988', text: CONFIGURED.text });
  });

  it('a daily limit says tomorrow and carries the same resources', () => {
    const body = buildSessionLimitRefusal(DAILY, CONFIGURED);
    expect(body.retry_message).toBe("You have used today's 3 sessions. You can start a new one tomorrow.");
    expect(body.message).toMatch(/988/);
    expect(body.minutes_remaining).toBeUndefined();
    expect(body.details).toMatchObject({ limit: 3, current: 3 });
  });

  it('never promises anything and never sounds alarmed', () => {
    for (const body of [buildSessionLimitRefusal(COOLDOWN, CONFIGURED), buildSessionLimitRefusal(DAILY, null)]) {
      expect(body.message).not.toMatch(/notified|will reach out|someone will|emergency|crisis team/i);
    }
  });
});

describe('resolveCrisisResources', () => {
  it('uses the configured contact when it is enabled and complete', () => {
    expect(resolveCrisisResources({ hotline: 'Local Line', phone: '555', enabled: true })).toEqual({
      hotline: 'Local Line',
      phone: '555',
      text: '',
    });
  });

  it('falls back to the shared defaults when missing or disabled, so resources are never dropped', () => {
    for (const c of [null, undefined, { ...CONFIGURED, enabled: false }, { hotline: '', phone: '' }]) {
      const r = resolveCrisisResources(c);
      expect(r.phone).toBe('988');
      expect(r.text).toMatch(/741741/);
    }
  });
});

describe('buildTooManyAttemptsRefusal', () => {
  it('answers the per-IP backstop with a readable body and resources', () => {
    const body = buildTooManyAttemptsRefusal(null);
    expect(body.reason).toBe('too_many_attempts');
    expect(body.message).toMatch(/15 minutes/);
    expect(body.message).toMatch(/988/);
  });
});

// system_config.crisis_contact.text is stored as "HOME to 741741" (migration
// 090) on some databases and "Text HOME to 741741" on others. The refusal used
// to lower-case the first letter, so the first form read "or hOME to 741741"
// (seen in the nightly eval run of 2026-11-20).
describe('the text line reads the same whichever way it is stored', () => {
  const contact = (text: string) => ({ hotline: '988 Suicide & Crisis Lifeline', phone: '988', text, enabled: true });
  const want = /any time at 988, or text HOME to 741741\.$/;

  it.each(['HOME to 741741', 'Text HOME to 741741', 'text HOME to 741741', '  TEXT  HOME to 741741 '])(
    'stored as %j',
    (text) => {
      expect(buildTooManyAttemptsRefusal(contact(text)).message).toMatch(want);
      expect(buildTooManyAttemptsRefusal(contact(text)).message).not.toMatch(/hOME|[Tt]ext\s+[Tt]ext/);
    },
  );
});
