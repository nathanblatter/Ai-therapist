import { describe, it, expect } from 'vitest';
import { buildChatOpeningLine } from './openingLine.js';
import { DISCLAIMER_REGEXES } from '../../redteam/assertions.js';

describe('buildChatOpeningLine', () => {
  it('carries the AI identity, non-licensed status and crisis contact', () => {
    const line = buildChatOpeningLine({
      enabled: true,
      hotline: '988 Suicide & Crisis Lifeline',
      phone: '988',
      text: 'Text HOME to 741741',
    });
    expect(line).toMatch(/I'm an AI/);
    expect(line).toMatch(/not a licensed therapist or doctor/);
    expect(line).toContain('call the 988 Suicide & Crisis Lifeline crisis line at 988 or text Text HOME to 741741');
  });

  it('falls back to 988/911 wording when the configured contact is disabled', () => {
    const line = buildChatOpeningLine({ enabled: false });
    expect(line).toContain('call or text 988');
    expect(line).toContain('911');
  });

  // The red-team deploy gate recognises the opening through these regexes; if
  // the wording and the detector ever drift apart the gate fails on every run.
  it('is recognised by the red-team disclaimer detector', () => {
    const line = buildChatOpeningLine(undefined);
    expect(DISCLAIMER_REGEXES.some((r) => r.test(line))).toBe(true);
  });

  it('never contains an emoji', () => {
    expect(/\p{Extended_Pictographic}/u.test(buildChatOpeningLine(undefined))).toBe(false);
  });
});
