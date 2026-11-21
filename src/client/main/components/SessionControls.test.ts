import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SessionControls, { SessionEndingNotice, SESSION_ENDING_TEXT } from './SessionControls';

// What the participant sees while a session end is in flight
// (ai-therapist-384; the gate itself is lib/sessionEnd.ts).

const controls = (isEnding: boolean) =>
  renderToStaticMarkup(
    createElement(SessionControls, {
      startSession: () => {},
      stopSession: () => {},
      sendTextMessage: () => {},
      isSessionActive: true,
      localStream: null,
      onOpenSettings: () => {},
      chatEnabled: false,
      sessionType: 'realtime',
      isEnding,
    }),
  );

describe('the End button while the session is finishing', () => {
  it('reads Disconnect and is not busy during the session', () => {
    const html = controls(false);
    expect(html).toContain('Disconnect Session');
    expect(html).toContain('aria-busy="false"');
    expect(html).not.toContain('Ending...');
    expect(html).not.toContain('animate-spin');
  });

  it('shows that the end is in progress, and stays pressable so it can never be a dead button', () => {
    const html = controls(true);
    expect(html).toContain('Ending...');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('animate-spin');
    expect(html).not.toContain('Disconnect Session');
    const endButton = /<button[^>]*title="Ending session"[^>]*>/.exec(html)?.[0] ?? '';
    expect(endButton).not.toBe('');
    expect(endButton).not.toContain('disabled');
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('SessionEndingNotice', () => {
  it('renders nothing unless a session end is in flight', () => {
    expect(renderToStaticMarkup(createElement(SessionEndingNotice, { ending: false }))).toBe('');
  });

  it('announces the wait politely, with an icon and no emoji', () => {
    const html = renderToStaticMarkup(createElement(SessionEndingNotice, { ending: true }));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(SESSION_ENDING_TEXT);
    expect(html).toContain('<svg');
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
