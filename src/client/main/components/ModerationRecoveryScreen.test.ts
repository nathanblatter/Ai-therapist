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

  it.each(STAGES)('stage %s: says truthfully what happened, never that the connection dropped', (stage) => {
    const html = render(stage);
    expect(html).toContain('your fault');
    expect(html).toContain('nothing you said was wrong');
    expect(html).not.toMatch(/connection/i);
    expect(html).not.toMatch(/technical/i);
  });

  it('the text hand-off stages say the voice call stopped; only the voice path says "cut off"', () => {
    // ai-therapist-356: the hand-off wording does not say the call "got cut
    // off"; the recovery voice path keeps the line its spoken copy uses.
    for (const stage of ['text', 'failed', 'unavailable'] as ModerationRecoveryStage[]) {
      const html = render(stage);
      expect(html).toContain('The voice call has stopped');
      expect(html).not.toMatch(/cut off/i);
    }
    expect(render('voice')).toContain('The call was cut off');
  });

  it('no stage is a dead end: each either says what is happening next or what to do', () => {
    expect(render('voice')).toContain('coming right back');
    expect(render('text')).toContain('moving us to writing');
    // Nothing left to continue in: told plainly to use the numbers.
    const unavailable = render('unavailable');
    expect(unavailable).toContain('Please use one of the numbers below');
    expect(unavailable).not.toContain('<button');
  });

  it('chat start failure: the crisis lines and a retry button, never a blank screen', () => {
    const failed = render('failed');
    expect(failed).toContain('couldn&#x27;t open our written conversation');
    expect(failed).toContain('Try again');
    expect(failed).toContain('<button');
    expect(failed).toContain('href="tel:988"');
    expect(failed).toContain('href="sms:741741"');
    expect(failed).toContain('href="tel:911"');
    // It does not promise a call that would hang up on them again.
    expect(failed).not.toMatch(/reconnect/i);
  });

  it('promises no person and claims no notification on any stage', () => {
    for (const stage of STAGES) {
      expect(render(stage)).not.toMatch(/has been notified|have been notified|on (the|their) way|will call you/i);
    }
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
