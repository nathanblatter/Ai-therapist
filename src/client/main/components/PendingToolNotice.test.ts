import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PendingToolNotice, { PENDING_TOOL_NOTICE_TEXT } from './PendingToolNotice';

// The pending state for a voice screener, worksheet or safety plan that the
// server has not confirmed yet (lib/voiceOverlayGate.ts), rendered to markup.
const render = (pending: boolean) => renderToStaticMarkup(createElement(PendingToolNotice, { pending }));

describe('PendingToolNotice', () => {
  it('renders nothing when nothing is pending', () => {
    expect(render(false)).toBe('');
  });

  it('announces the wait politely, with an icon and no emoji', () => {
    const html = render(true);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(PENDING_TOOL_NOTICE_TEXT);
    expect(html).toContain('<svg');
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('never blocks the screen: no dialog, no backdrop, no buttons, no pointer events', () => {
    const html = render(true);
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('<button');
    expect(html).toContain('pointer-events-none');
  });

  it('fades in late so the usual sub-second wait does not flash, and fits a phone', () => {
    const html = render(true);
    expect(html).toContain('pending-notice-in');
    expect(html).toContain('inset-x-4');
    expect(html).toContain('max-w-full');
  });
});
