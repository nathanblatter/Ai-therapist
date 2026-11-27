// The signed-out screen covers everything on the page, a crisis-resources
// screen included, and the session under it may have been cut short. It must
// always name 988 and 911 itself (review of #147: the whole crisis paragraph
// used to vanish when the study had no crisis line configured).
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AccountSignedOutScreen, { studyCrisisLine } from './AccountSignedOutScreen';
import { toAccountSignedOutNotice } from '../lib/accountSignedOut';

const notice = toAccountSignedOutNotice({ reason: 'role_changed' });

function render(crisisLine?: { hotline: string; phone: string } | null): string {
  return renderToStaticMarkup(createElement(AccountSignedOutScreen, { notice, crisisLine }));
}

/** The crisis paragraph as plain text. */
function crisisText(html: string): string {
  const match = /<p[^>]*data-testid="signed-out-crisis-help"[^>]*>(.*?)<\/p>/s.exec(html);
  expect(match).not.toBeNull();
  return match![1]
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('the signed-out screen always offers crisis help', () => {
  it.each([
    ['no crisis line passed', undefined],
    ['null', null],
    ['an empty phone', { hotline: 'Campus line', phone: '' }],
    ['a blank phone', { hotline: 'Campus line', phone: '   ' }],
  ])('988 and 911 with %s', (_label, crisisLine) => {
    const html = render(crisisLine);
    expect(html).toContain('href="tel:988"');
    expect(html).toContain('href="tel:911"');
    expect(crisisText(html)).toBe(
      'If you need support right now, call or text 988 (Suicide and Crisis Lifeline). In an emergency, call 911.',
    );
  });

  it("adds the study's own line beside them when one is configured", () => {
    const html = render({ hotline: 'Campus Counseling', phone: '801-555-0100' });
    expect(html).toContain('href="tel:988"');
    expect(html).toContain('href="tel:911"');
    expect(html).toContain('href="tel:801-555-0100"');
    expect(crisisText(html)).toBe(
      'If you need support right now, call or text 988 (Suicide and Crisis Lifeline), or call 801-555-0100 ' +
        '(Campus Counseling). In an emergency, call 911.',
    );
  });

  it('does not list 988 twice when it is the configured line', () => {
    expect(studyCrisisLine({ hotline: '988 Lifeline', phone: '988' })).toBeNull();
    expect(render({ hotline: '988 Lifeline', phone: '988' }).match(/tel:988/g)).toHaveLength(1);
  });

  it('still says why and offers the way back to sign-in', () => {
    const html = render(null);
    expect(html).toContain('You have been signed out');
    expect(html).toContain(notice.message);
    expect(html).toContain('href="/login"');
  });
});
