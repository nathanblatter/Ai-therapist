// ai-therapist-373 item 5: the database-unavailable message uses the configured
// crisis contact when this process already holds it, and never reads.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { cached } = vi.hoisted(() => ({ cached: { value: null as unknown } }));
vi.mock('./sessionHelpers.js', () => ({ peekCachedSystemConfig: () => cached.value }));

const { buildDatabaseRetryMessage, databaseRetryMessage } = await import('./databaseRetryMessage.js');
const { DATABASE_RETRY_MESSAGE } = await import('./dbErrors.js');

beforeEach(() => {
  cached.value = null;
});

describe('buildDatabaseRetryMessage', () => {
  it('the configured contact, with its text line', () => {
    expect(
      buildDatabaseRetryMessage({
        hotline: '988 Suicide & Crisis Lifeline',
        phone: '988',
        text: 'Text HOME to 741741',
      }),
    ).toBe(
      'We could not reach our system just now. Please wait a moment and try again. ' +
        'If you are in crisis, contact the 988 Suicide & Crisis Lifeline at 988, or text HOME to 741741, or call 911.',
    );
  });

  it('without a text line', () => {
    expect(buildDatabaseRetryMessage({ hotline: 'Campus Line', phone: '801-555-0100', text: '  ' })).toBe(
      'We could not reach our system just now. Please wait a moment and try again. ' +
        'If you are in crisis, contact the Campus Line at 801-555-0100, or call 911.',
    );
  });

  it.each([
    ['no contact', null],
    ['disabled', { hotline: 'Campus Line', phone: '801', enabled: false }],
    ['no hotline', { phone: '801' }],
    ['no phone', { hotline: 'Campus Line', phone: ' ' }],
  ])('%s: the fixed text', (_label, contact) => {
    expect(buildDatabaseRetryMessage(contact as never)).toBe(DATABASE_RETRY_MESSAGE);
  });
});

describe('databaseRetryMessage', () => {
  it('nothing held in process: the fixed text', () => {
    expect(databaseRetryMessage()).toBe(DATABASE_RETRY_MESSAGE);
  });

  it('the contact held in process', () => {
    cached.value = { crisis_contact: { hotline: 'Campus Line', phone: '801-555-0100', enabled: true } };
    expect(databaseRetryMessage()).toContain('contact the Campus Line at 801-555-0100');
  });

  it('a cache that cannot be read: the fixed text, never a throw', () => {
    cached.value = {
      get crisis_contact() {
        throw new Error('broken');
      },
    };
    expect(databaseRetryMessage()).toBe(DATABASE_RETRY_MESSAGE);
  });
});
