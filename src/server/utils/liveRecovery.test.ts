// Guards the crisis-recovery voice session.
//
// Incident 2026-09-11: a participant said "I wanna kill myself", the assistant
// began "Hey, I'm really glad you told me", and OpenAI's content filter
// terminated the GPT-Live session mid-sentence. Our crisis pipeline worked
// (risk 100, flagged, on-call paged); the harm was that the conversation
// vanished and the participant was left alone.
//
// The recovery session exists to bring the assistant straight back. These tests
// pin the properties that make it safe, because none of them can be verified at
// runtime without provoking the vendor's filter on demand.

import { describe, it, expect } from 'vitest';
import {
  buildLiveSessionConfig,
  buildLiveRecoveryInstructions,
} from './liveSessionConfig.js';

const baseInput = {
  model: 'gpt-live-1',
  voice: 'marin',
  languageName: 'English',
  systemPrompt: 'THE FULL CLINICAL PROMPT',
  toolDefs: [
    { type: 'function', name: 'end_session', description: 'end', parameters: {} },
    { type: 'function', name: 'find_worksheet', description: 'find', parameters: {} },
  ] as never,
  backendModel: 'gpt-5.6-terra',
};

describe('crisis recovery voice session', () => {
  it('carries NO conversation history', () => {
    // The single most important property. Replaying the disclosure that tripped
    // the filter into the replacement session is the most likely way to be
    // terminated a second time — which would mean hanging up on someone in
    // crisis twice.
    const config = buildLiveSessionConfig({
      ...baseInput,
      recovery: { crisisLine: '988' },
      history: [
        { role: 'user', content: 'I wanna kill myself' },
        { role: 'assistant', content: 'Hey, I am really glad you told me.' },
      ],
    });
    expect(config.input).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain('kill myself');
  });

  it('answers directly instead of delegating, so it cannot go quiet', () => {
    // A Responses round trip introduces a pause. Going silent on someone who
    // just disclosed suicidal intent is the failure we are recovering from.
    const config = buildLiveSessionConfig({ ...baseInput, recovery: { crisisLine: '988' } });
    expect(config.delegation).toEqual({ type: 'client' });
  });

  it('replaces the normal conversation prompt with the crisis prompt', () => {
    const normal = buildLiveSessionConfig(baseInput);
    const recovery = buildLiveSessionConfig({ ...baseInput, recovery: { crisisLine: '988' } });
    expect(normal.instructions).not.toEqual(recovery.instructions);
    expect(String(recovery.instructions)).toContain('988');
  });

  it('never stores the recovery session', () => {
    const config = buildLiveSessionConfig({
      ...baseInput, recovery: { crisisLine: '988' }, storable: false,
    });
    expect(config.store).toBe(false);
  });

  it('leaves the normal path completely unchanged', () => {
    // Recovery is an exceptional branch; a regression here would change every
    // ordinary therapy session.
    const config = buildLiveSessionConfig(baseInput);
    expect((config.delegation as { type: string }).type).toBe('responses');
    expect(String(config.instructions)).toContain('Delegation policy');
  });
});

describe('recovery instructions content', () => {
  const text = buildLiveRecoveryInstructions({ languageName: 'English', crisisLine: '988 or text HOME to 741741' });

  it('directs the participant to the crisis line', () => {
    expect(text).toContain('988');
    expect(text.toLowerCase()).toContain('call or text');
  });

  it('routes immediate danger to emergency services', () => {
    expect(text).toContain('911');
  });

  it('forbids discussing methods — the content most likely to re-trip the filter', () => {
    expect(text.toLowerCase()).toContain('do not discuss methods');
  });

  it('forbids going silent', () => {
    expect(text.toLowerCase()).toContain('do not go silent');
  });

  it('tells the assistant not to make them repeat the disclosure', () => {
    expect(text.toLowerCase()).toContain('do not ask them to repeat');
  });

  it('does not delegate', () => {
    expect(text.toLowerCase()).toContain('do not delegate');
  });

  it('honours the configured language', () => {
    expect(buildLiveRecoveryInstructions({ languageName: 'Spanish', crisisLine: '988' }))
      .toContain('Speak Spanish');
  });
});
