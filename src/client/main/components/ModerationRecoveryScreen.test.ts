import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ModerationRecoveryScreen, { type ModerationRecoveryStage } from './ModerationRecoveryScreen';

// The screen a participant sees when the voice vendor cuts their call
// (ai-therapist-293), rendered to markup for every stage of the recovery
// ladder. This checks what the component emits, not how a browser lays it out.
const STAGES: ModerationRecoveryStage[] = ['voice', 'text', 'failed', 'unavailable'];
const CONTACT = { hotline: '988 Suicide & Crisis Lifeline', phone: '988', text: 'HOME to 741741', enabled: true };

function render(stage: ModerationRecoveryStage, crisisContact = CONTACT): string {
  return renderToStaticMarkup(createElement(ModerationRecoveryScreen, { stage, crisisContact, onRetry: () => {} }));
}

describe('ModerationRecoveryScreen', () => {
  it.each(STAGES)('stage %s: the crisis lines are on screen, as links', (stage) => {
    const html = render(stage);
    expect(html).toContain('href="tel:988"');
    expect(html).toContain('href="sms:741741"');
    expect(html).toContain('href="tel:911"');
    expect(html).toContain('HOME to 741741');
  });

  it.each(STAGES)('stage %s: says the call was cut off, never that the connection dropped', (stage) => {
    const html = render(stage);
    expect(html).toContain('The call was cut off');
    expect(html).toContain('your fault');
    expect(html).not.toMatch(/connection dropped/i);
    expect(html).not.toMatch(/technical/i);
  });

  it('no stage is a dead end: each either says what is happening next or what to do', () => {
    expect(render('voice')).toContain('coming right back');
    expect(render('text')).toContain('in writing');
    // Reconnect failed: a retry button, and the numbers are pointed at.
    const failed = render('failed');
    expect(failed).toContain('Try to reconnect');
    expect(failed).toContain('<button');
    // Nothing left to continue in: told plainly to use the numbers.
    const unavailable = render('unavailable');
    expect(unavailable).toContain('Please use one of the numbers below');
    expect(unavailable).not.toContain('<button');
  });

  it('falls back to the national lines when the configured contact is disabled or blank', () => {
    for (const contact of [
      { hotline: '', phone: '', text: '', enabled: true },
      { hotline: 'Local line', phone: '555-0100', text: 'HELP to 12345', enabled: false },
    ]) {
      const html = render('unavailable', contact);
      expect(html).toContain('href="tel:988"');
      expect(html).toContain('href="sms:741741"');
      expect(html).not.toContain('555-0100');
    }
  });

  it('uses the configured contact when it is enabled', () => {
    const html = render('voice', { hotline: 'Local line', phone: '555-0100', text: 'HELP to 12345', enabled: true });
    expect(html).toContain('href="tel:5550100"');
    expect(html).toContain('href="sms:12345"');
    expect(html).toContain('Local line');
  });
});
