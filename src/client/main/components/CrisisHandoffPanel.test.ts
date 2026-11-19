import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { crisisLineActions, HandoffReplyBar, PinnedCrisisCard } from './CrisisHandoffPanel';
import type { HandoffKind } from '../../../shared/textHandoff';

// The parts of the chat view that exist only after a text hand-off
// (ai-therapist-356), rendered to markup. This checks what the components
// emit, not how a browser lays them out.
const CONTACT = { hotline: '988 Suicide & Crisis Lifeline', phone: '988', text: 'HOME to 741741', enabled: true };
const KINDS: HandoffKind[] = ['crisis', 'ceiling', 'neutral'];

const card = (kind: HandoffKind, crisisContact = CONTACT) =>
  renderToStaticMarkup(createElement(PinnedCrisisCard, { crisisContact, kind }));

const bar = (over: Partial<Parameters<typeof HandoffReplyBar>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(HandoffReplyBar, {
      quickReplies: [],
      onQuickReply: () => {},
      awaitingReply: false,
      voiceReturnAllowed: false,
      onReturnToVoice: () => {},
      returningToVoice: false,
      ...over,
    }),
  );

describe('PinnedCrisisCard', () => {
  it.each(KINDS)('%s: one-tap Call 988, Text 988 and Call 911, as plain links', (kind) => {
    const html = card(kind);
    expect(html).toContain('href="tel:988"');
    expect(html).toContain('href="sms:988"');
    expect(html).toContain('href="tel:911"');
    expect(html).toContain('Call 988');
    expect(html).toContain('Text 988');
    expect(html).toContain('Call 911');
    // Links only: nothing in the card needs a script, a model or the network.
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<form');
  });

  it.each(KINDS)('%s: every action is a 44px touch target', (kind) => {
    const anchors = card(kind).match(/<a [^>]*>/g) ?? [];
    expect(anchors).toHaveLength(3);
    for (const anchor of anchors) expect(anchor).toContain('min-h-[44px]');
  });

  it('the neutral card is still on screen, without the alert colours or the crisis caption', () => {
    const neutral = card('neutral');
    expect(neutral).toContain('Crisis lines');
    expect(neutral).not.toContain('bg-red-50');
    expect(neutral).not.toMatch(/right now/);
    expect(card('crisis')).toContain('bg-red-50');
  });

  it('asks nothing: the suicide question is the first message, never the card', () => {
    for (const kind of KINDS) expect(card(kind)).not.toMatch(/suicid|ending your life|\?/i);
  });

  it('offers the full resource card only when given a way to open it', () => {
    expect(card('crisis')).not.toContain('More');
    const withMore = renderToStaticMarkup(
      createElement(PinnedCrisisCard, { crisisContact: CONTACT, kind: 'crisis', onMoreResources: () => {} }),
    );
    expect(withMore).toContain('More');
    expect(withMore).toContain('href="tel:988"');
  });
});

describe('crisisLineActions', () => {
  it('never builds a card without numbers: defaults stand in for a blank or disabled contact', () => {
    for (const contact of [
      null,
      undefined,
      { hotline: '', phone: '', text: '', enabled: true },
      { hotline: 'Local line', phone: '555-0100', text: 'HELP to 12345', enabled: false },
    ]) {
      expect(crisisLineActions(contact)).toEqual({
        call: { label: 'Call 988', href: 'tel:988' },
        text: { label: 'Text 988', href: 'sms:988' },
        emergency: { label: 'Call 911', href: 'tel:911' },
      });
    }
  });

  it('a configured local line is called, and its own text line is texted', () => {
    expect(crisisLineActions({ hotline: 'Local', phone: '555-0100', text: 'HELP to 12345', enabled: true })).toEqual({
      call: { label: 'Call 555-0100', href: 'tel:5550100' },
      text: { label: 'Text HELP to 12345', href: 'sms:12345' },
      emergency: { label: 'Call 911', href: 'tel:911' },
    });
  });
});

describe('HandoffReplyBar', () => {
  it('quick replies are buttons with 44px targets, in the order given', () => {
    const html = bar({ quickReplies: ['Yes', 'No', 'Not sure'] });
    const buttons = html.match(/<button[^>]*>[^<]*<\/button>/g) ?? [];
    expect(buttons.map((b) => b.replace(/<[^>]+>/g, ''))).toEqual(['Yes', 'No', 'Not sure']);
    for (const button of buttons) expect(button).toContain('min-h-[44px]');
  });

  it('renders nothing when there is nothing to offer', () => {
    expect(bar()).toBe('');
  });

  it('while a reply is on its way: says so, and takes the quick replies away', () => {
    const html = bar({ quickReplies: ['Yes', 'No', 'Not sure'], awaitingReply: true });
    expect(html).toContain('Writing a reply');
    expect(html).not.toContain('Not sure');
  });

  it('the way back to voice is absent until the server allows it', () => {
    expect(bar({ quickReplies: ['Yes', 'No', 'Not sure'] })).not.toMatch(/voice/i);
    const html = bar({ voiceReturnAllowed: true });
    expect(html).toContain('Go back to voice');
    expect(html).toContain('This starts a new voice call');
    expect(html).toContain('min-h-[44px]');
  });

  it('the voice button is disabled while a reply is pending or a call is starting', () => {
    expect(bar({ voiceReturnAllowed: true, awaitingReply: true })).toMatch(/<button[^>]*disabled/);
    const starting = bar({ voiceReturnAllowed: true, returningToVoice: true });
    expect(starting).toMatch(/<button[^>]*disabled/);
    expect(starting).toContain('Starting a voice call');
  });
});
