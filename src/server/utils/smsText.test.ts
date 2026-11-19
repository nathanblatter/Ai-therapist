// SMS shaping for on-call pages (ai-therapist-355), and the guarantee that
// every page this project writes is carrier-safe: plain 7-bit text, one SMS
// or deliberately numbered parts, the "Why:" line in the first part.
import { describe, it, expect } from 'vitest';
import { toGsm7, gsmLength, splitForSms, toE164, SMS_SINGLE_MAX, SMS_PART_MAX, SMS_MAX_PARTS } from './smsText.js';
import {
  buildRiskPageMessage,
  buildVendorCutMessage,
  buildVendorCutSilenceMessage,
  buildVendorCeilingMessage,
} from '../services/crisisPaging.service.js';
import { buildTestPageMessage } from '../services/crisisAlert.service.js';

describe('toGsm7', () => {
  it('leaves plain text alone', () => {
    const text = 'URGENT: risk 82/100 (a_b) #1 & <ok>\nhttps://x.example/admin#session=live_u7_A-b';
    expect(toGsm7(text)).toBe(text);
  });

  it('replaces typographic punctuation, drops accents, and never lets a UCS-2 character through', () => {
    expect(toGsm7('\u201Cit\u2019s\u201D \u2013 wait\u2026 caf\u00E9 \u2192 ok\u00A0now `x`')).toBe(
      "\"it's\" - wait... cafe -> ok now 'x'",
    );
    expect(toGsm7('alert \u{20000} \u4E2D')).toBe('alert ? ?');
    expect(/^[\n\x20-\x7E]*$/.test(toGsm7('\u00DF\u0416\u0429\r\n\ttab'))).toBe(true);
  });

  it('counts extension characters twice', () => {
    expect(gsmLength('abc')).toBe(3);
    expect(gsmLength('a[b]')).toBe(6);
  });
});

describe('splitForSms', () => {
  it('a page that fits goes as one message, unlabelled', () => {
    const text = 'x'.repeat(SMS_SINGLE_MAX);
    expect(splitForSms(text)).toEqual([text]);
    expect(splitForSms('  short\n')).toEqual(['short']);
    expect(splitForSms('   ')).toEqual([]);
  });

  it('one character over is split into labelled parts that fit two segments', () => {
    const text = `${'word '.repeat(64)}x`;
    expect(text.length).toBe(SMS_SINGLE_MAX + 1);
    const parts = splitForSms(text);
    expect(parts.length).toBe(2);
    parts.forEach((part, i) => {
      expect(part.startsWith(`(${i + 1}/2) `)).toBe(true);
      expect(gsmLength(part)).toBeLessThanOrEqual(SMS_PART_MAX);
    });
  });

  it('keeps lines whole and in order, and loses no words', () => {
    const lines = [
      'HEADLINE of the page',
      `Why: ${'reason '.repeat(30).trim()}.`,
      `Detail one. ${'More detail here. '.repeat(12).trim()}`,
      'https://ai-therapist.example.org/admin#session=live_u7_Eloycp3oMNHnVh9M',
    ];
    const parts = splitForSms(lines.join('\n'));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]).toContain('HEADLINE of the page\nWhy: reason');
    // A URL is never broken across parts.
    expect(parts.filter((p) => p.includes('https://')).length).toBe(1);
    expect(parts[parts.length - 1].endsWith(lines[3])).toBe(true);
    const rejoined = parts.map((p) => p.replace(/^\(\d+\/\d+\) /, '')).join(' ');
    expect(rejoined.replace(/\s+/g, ' ')).toBe(lines.join(' ').replace(/\s+/g, ' '));
  });

  it('a single unbreakable run is cut hard rather than dropped', () => {
    const parts = splitForSms('z'.repeat(700));
    expect(parts.map((p) => p.replace(/^\(\d+\/\d+\) /, '')).join('')).toBe('z'.repeat(700));
    for (const part of parts) expect(gsmLength(part)).toBeLessThanOrEqual(SMS_PART_MAX);
  });

  it(`never more than ${SMS_MAX_PARTS} parts: the last one says the rest is on the dashboard`, () => {
    const parts = splitForSms('Sentence number one is here. '.repeat(200));
    expect(parts.length).toBe(SMS_MAX_PARTS);
    expect(parts[SMS_MAX_PARTS - 1].endsWith('[more on the dashboard]')).toBe(true);
    for (const part of parts) expect(gsmLength(part)).toBeLessThanOrEqual(SMS_PART_MAX);
  });
});

describe('toE164', () => {
  it('accepts the forms an on-call phone is stored in', () => {
    expect(toE164('+18015550142')).toBe('+18015550142');
    expect(toE164(' +1 (801) 555-0142 ')).toBe('+18015550142');
    expect(toE164('801-555-0142')).toBe('+18015550142');
    expect(toE164('1.801.555.0142')).toBe('+18015550142');
    expect(toE164('+447700900123')).toBe('+447700900123');
  });

  it('returns null rather than guess', () => {
    for (const bad of ['', 'on-call@example.org', '555-0142', '0015550142', '+0123456789', '+1', '12345678901234567']) {
      expect(toE164(bad), bad).toBeNull();
    }
  });
});

// Every page the paging policy can write, at its longest: a full-length
// session id, three-digit scores, a follow-up line and an unpaged-cut line.
describe('every on-call page is carrier-safe as written', () => {
  const SESSION = 'live_u1234567_ElovAp3oMAnCoQLKWeqEZIendoORid6Q';
  const now = Date.parse('2026-11-19T12:00:00Z');
  const previousPage = {
    actionId: 1,
    sessionId: SESSION,
    at: now - 14 * 60_000,
    level: 2 as const,
    kinds: ['risk' as const, 'vendor_cut' as const],
    riskScore: 75,
  };
  const full = { previousPage, unpagedCut: { sessionId: SESSION, at: now - 80_000 }, now };
  const bare = { previousPage: null, unpagedCut: null, now };

  const pages: Record<string, string> = {
    'risk (first)': buildRiskPageMessage(SESSION, 82, bare),
    'risk (escalated follow-up, after an unpaged cut)': buildRiskPageMessage(SESSION, 100, full),
    'risk (escalate tool)': buildRiskPageMessage(SESSION, 80, full, 'model_escalation'),
    'vendor cut, high': buildVendorCutMessage(SESSION, { severity: 'high', riskScore: 100 }, full),
    'vendor cut, medium': buildVendorCutMessage(SESSION, { severity: 'medium', riskScore: 64 }, full),
    'vendor cut, unknown': buildVendorCutMessage(SESSION, { severity: 'unknown', riskScore: null }, full),
    'silence, none': buildVendorCutSilenceMessage(SESSION, 14 * 60_000, full),
    'silence, medium': buildVendorCutSilenceMessage(SESSION, 180_000, full, { severity: 'medium', riskScore: 55 }),
    'silence, high': buildVendorCutSilenceMessage(SESSION, 180_000, full, { severity: 'high', riskScore: 100 }),
    'silence, unknown': buildVendorCutSilenceMessage(SESSION, 180_000, full, { severity: 'unknown', riskScore: null }),
    'vendor ceiling': buildVendorCeilingMessage(SESSION, full),
    'test page (SMS)': buildTestPageMessage('aws_sms', new Date(now)),
    'test page (bridge)': buildTestPageMessage('imessage', new Date(now)),
  };

  for (const [name, text] of Object.entries(pages)) {
    it(`${name}: 7-bit as written, at most 3 SMS parts, "Why:" in the first`, () => {
      // Already plain: the SMS copy is the bridge copy, not a transliteration of it.
      expect(toGsm7(text)).toBe(text);
      const parts = splitForSms(text);
      expect(parts.length).toBeGreaterThanOrEqual(1);
      expect(parts.length).toBeLessThanOrEqual(3);
      for (const part of parts) {
        expect(gsmLength(part)).toBeLessThanOrEqual(parts.length === 1 ? SMS_SINGLE_MAX : SMS_PART_MAX);
      }
      if (!name.startsWith('test page')) {
        expect(parts[0]).toMatch(/\nWhy: /);
        // The link to the session survives intact, in one part.
        expect(parts.filter((p) => p.includes(`/admin#session=${SESSION}`)).length).toBe(1);
      } else {
        expect(parts).toHaveLength(1);
      }
      // Identical in meaning across channels: the same words, in the same order.
      const rejoined = parts.map((p) => p.replace(/^\(\d+\/\d+\) /, '')).join(' ');
      expect(rejoined.replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
    });
  }

  it('no page carries a participant name or anything beyond a session id prefix, scores and the admin link', () => {
    for (const text of Object.values(pages)) {
      expect(text).not.toMatch(/participant (name|email)|@|username/i);
    }
  });
});
