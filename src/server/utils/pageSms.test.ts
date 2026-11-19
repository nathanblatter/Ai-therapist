// SMS part 1 of every on-call page stands on its own. Carriers do not
// guarantee the order the parts of a split SMS arrive in, so part 1 must carry
// the headline, who is at risk, what changed, the Why line and the admin link
// (or, when the link cannot fit, "Open Crisis Management" and the session
// reference), whatever else the page says. Pure: no database, no network.
import { describe, it, expect } from 'vitest';
import { splitPageForSms, gsmLength, toGsm7, SMS_SINGLE_MAX, SMS_PART_MAX, SMS_MAX_PARTS } from './smsText.js';
import { field, page, renderPage, PART_ONE_ROLES, type PageMessage } from './pageMessage.js';
import {
  composeRiskPage,
  composeVendorCutPage,
  composeVendorCutSilencePage,
  composeVendorCeilingPage,
  composeMinimalPage,
  buildRiskPageMessage,
  buildVendorCutMessage,
  type IncidentPeak,
  type PageKind,
  type PageSubject,
} from '../services/crisisPaging.service.js';
import { composeTestPage } from '../services/crisisAlert.service.js';

const NOW = Date.parse('2026-11-19T12:00:00Z');
// A short id, the longest the tests elsewhere use, and one longer than any
// the app mints: the link's length must never decide what part 1 carries.
const SESSIONS = ['grok_1', 'live_u1234567_ElovAp3oMAnCoQLKWeqEZIendoORid6Q', `live_u99999999_${'Z'.repeat(64)}`];
const SUBJECTS: PageSubject[] = ['own', 'third_party', 'harm_to_others'];
const LABEL = /^\(\d\/\d\) /;

function previous(sessionId: string, subject: PageSubject, kinds: PageKind[]) {
  return {
    actionId: 1,
    sessionId,
    at: NOW - 14 * 60_000,
    level: 2 as const,
    kinds,
    riskScore: 75,
    subject,
    stage: 0 as const,
  };
}

/** Every page the paging policy can build, in every combination of the lines
 *  it may carry. */
function everyPage(): Array<[string, PageMessage, string]> {
  const out: Array<[string, PageMessage, string]> = [];
  for (const sessionId of SESSIONS) {
    for (const subject of SUBJECTS) {
      for (const escalation of [null, 'plan_or_time', 'attempt'] as const) {
        for (const alsoSubject of [null, 'third_party', 'harm_to_others'] as const) {
          for (const prior of [null, ...SUBJECTS]) {
            for (const kinds of [['risk'], ['vendor_cut'], ['risk', 'vendor_cut']] as PageKind[][]) {
              if (prior === null && kinds.length > 1) continue;
              for (const cut of [false, true]) {
                for (const source of ['participant_turn', 'model_escalation'] as const) {
                  for (const score of [65, 89, 90, 100]) {
                    const ctx = {
                      previousPage: prior ? previous(sessionId, prior, kinds) : null,
                      unpagedCut: cut ? { sessionId, at: NOW - 80_000 } : null,
                      now: NOW,
                    };
                    out.push([
                      `risk ${subject} ${escalation} also=${alsoSubject} prior=${prior}:${kinds} cut=${cut} ${source} ${score}`,
                      composeRiskPage(sessionId, score, ctx, source, subject, { escalation, alsoSubject }),
                      sessionId,
                    ]);
                  }
                }
              }
            }
          }
        }
      }
    }
    for (const prior of [null, previous(sessionId, 'own', ['risk', 'vendor_cut'])]) {
      const ctx = { previousPage: prior, now: NOW };
      for (const severity of ['high', 'medium', 'unknown', 'none'] as const) {
        for (const subject of SUBJECTS) {
          for (const ownSeverity of ['none', 'medium', 'high'] as const) {
            for (const riskScore of severity === 'high' || severity === 'medium' ? [55, 100] : [null]) {
              const peak: IncidentPeak = { severity, riskScore, subject, ownSeverity };
              const name = `${severity} ${subject} own=${ownSeverity} ${riskScore} prior=${!!prior}`;
              if (severity !== 'none')
                out.push([`vendor cut ${name}`, composeVendorCutPage(sessionId, peak, ctx), sessionId]);
              for (const silentMs of [180_000, 14 * 60_000]) {
                out.push([
                  `silence ${silentMs} ${name}`,
                  composeVendorCutSilencePage(sessionId, silentMs, ctx, peak),
                  sessionId,
                ]);
              }
            }
          }
        }
      }
      out.push([`vendor ceiling prior=${!!prior}`, composeVendorCeilingPage(sessionId, ctx), sessionId]);
    }
    for (const kind of ['risk', 'vendor_cut', 'vendor_ceiling'] as const) {
      out.push([`minimal ${kind}`, composeMinimalPage(sessionId, kind), sessionId]);
    }
  }
  out.push(['test page (SMS)', composeTestPage('aws_sms', new Date(NOW)), '']);
  out.push(['test page (bridge)', composeTestPage('imessage', new Date(NOW)), '']);
  return out;
}

const PAGES = everyPage();
const unlabel = (part: string) => part.replace(LABEL, '');
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

describe('SMS part 1 of every page, in every combination of its lines', () => {
  it(`covers the combinations (${PAGES.length} pages)`, () => {
    expect(PAGES.length).toBeGreaterThan(3000);
  });

  it('part 1 carries every part-1 field (full or short) and is one SMS: at most 306 GSM-7 characters', () => {
    const failures: string[] = [];
    for (const [name, message] of PAGES) {
      const parts = splitPageForSms(message);
      const first = parts[0];
      if (gsmLength(first) > SMS_SINGLE_MAX) failures.push(`${name}: part 1 is ${gsmLength(first)} long`);
      if (parts.length > 1 && gsmLength(first) > SMS_PART_MAX) failures.push(`${name}: part 1 over SMS_PART_MAX`);
      const firstLines = unlabel(first).split('\n');
      for (const f of message.fields.filter((x) => PART_ONE_ROLES.includes(x.role))) {
        if (!firstLines.includes(f.text) && !(f.short && firstLines.includes(f.short))) {
          failures.push(`${name}: part 1 lacks its ${f.role} line`);
        }
      }
      // A split page's part 1 is part-1 fields (and the action line) only.
      if (parts.length === 1) continue;
      const roles = firstLines.map((line) => message.fields.find((f) => f.text === line || f.short === line)?.role);
      if (roles.some((r) => r === undefined || r === 'detail')) failures.push(`${name}: part 1 carries a detail line`);
    }
    expect(failures.slice(0, 10)).toEqual([]);
  });

  it('in words: headline, who is at risk, what changed, a Why line and the link or the instruction to open it', () => {
    for (const [name, message, sessionId] of PAGES) {
      if (name.startsWith('test page')) continue;
      const first = splitPageForSms(message)[0];
      expect(first, name).toMatch(/^(\(1\/\d\) )?(URGENT: )?AI-Therapist/);
      if (!name.startsWith('minimal')) expect(first, name).toMatch(/\nWhy: /);
      if (/^risk third_party/.test(name)) expect(first, name).toContain('THIRD PARTY AT RISK');
      if (/^risk harm_to_others/.test(name)) expect(first, name).toContain('RISK TO OTHERS');
      if (/^risk own \S+ also=third_party/.test(name))
        expect(first, name).toMatch(/ALSO: (the same message reports )?someone else's crisis/);
      if (/^risk own \S+ also=harm_to_others/.test(name))
        expect(first, name).toMatch(/ALSO: (the same message describes thoughts of )?harming another person/);
      if (/^risk own .* prior=(third_party|harm_to_others):risk/.test(name)) {
        expect(first, name).toContain("PARTICIPANT'S OWN RISK");
      }
      if (/^risk \S+ plan_or_time/.test(name)) expect(first, name).toMatch(/WHAT (CHANGED|IT SAYS): STATED INTENT/);
      if (/^risk \S+ attempt/.test(name)) expect(first, name).toMatch(/WHAT (CHANGED|IT SAYS): ATTEMPT IN PROGRESS/);
      if (/^(vendor cut|silence \d+) high (third_party|harm_to_others)/.test(name)) {
        expect(first, name).toMatch(/SOMEONE ELSE|HARMING ANOTHER PERSON/);
      }
      const link = `/admin#session=${encodeURIComponent(sessionId)}`;
      if (!first.includes(link)) {
        expect(first, name).toContain(`Open Crisis Management: session ${sessionId.substring(0, 16)}...`);
      }
    }
  });

  it('the short forms are used only when the full lines do not fit, and the link last of all', () => {
    for (const [name, message, sessionId] of PAGES) {
      const parts = splitPageForSms(message);
      if (parts.length === 1) continue;
      const fullFirst = message.fields
        .filter((f) => PART_ONE_ROLES.includes(f.role))
        .map((f) => toGsm7(f.text))
        .join('\n');
      if (gsmLength(fullFirst) <= SMS_PART_MAX - 6) expect(unlabel(parts[0]).startsWith(fullFirst), name).toBe(true);
      // A page whose own-risk first page has room for its link keeps it.
      if (/^risk own null also=null prior=null/.test(name) && sessionId.length < 60) {
        expect(parts[0], name).toContain('/admin#session=');
      }
    }
  });

  it('every part is plain 7-bit, within two segments, numbered, and never more than the cap', () => {
    for (const [name, message] of PAGES) {
      const parts = splitPageForSms(message);
      expect(parts.length, name).toBeGreaterThanOrEqual(1);
      expect(parts.length, name).toBeLessThanOrEqual(4);
      expect(parts.length).toBeLessThanOrEqual(SMS_MAX_PARTS);
      for (const [i, part] of parts.entries()) {
        expect(/^[\n\x20-\x7E]*$/.test(part), name).toBe(true);
        expect(gsmLength(part), name).toBeLessThanOrEqual(parts.length === 1 ? SMS_SINGLE_MAX : SMS_PART_MAX);
        if (parts.length > 1) expect(part.startsWith(`(${i + 1}/${parts.length}) `), name).toBe(true);
        expect(part, name).not.toContain('[more on the dashboard]');
      }
    }
  });

  it('nothing is lost: the SMS carries every line of the bridge text, the link intact in exactly one part', () => {
    for (const [name, message, sessionId] of PAGES) {
      const parts = splitPageForSms(message);
      const sms = squash(parts.map(unlabel).join(' '));
      for (const f of message.fields) {
        const carried = sms.includes(squash(toGsm7(f.text))) || (!!f.short && sms.includes(squash(toGsm7(f.short))));
        expect(carried, `${name}: ${f.role}`).toBe(true);
      }
      // The Why line's full explanation, the details and the action line are
      // all there in full, even when part 1 carries a short Why line.
      for (const f of message.fields.filter((x) => x.role === 'detail' || x.role === 'action' || x.role === 'why')) {
        expect(sms, `${name}: full ${f.role}`).toContain(squash(toGsm7(f.text)).slice(-40));
      }
      if (sessionId !== '') {
        const link = `/admin#session=${encodeURIComponent(sessionId)}`;
        expect(parts.filter((p) => p.includes(link)).length, name).toBe(1);
        // When part 1 carries only the instruction, the link opens part 2.
        if (!parts[0].includes(link)) expect(unlabel(parts[1]).startsWith('https://'), name).toBe(true);
      }
    }
  });

  it('a page that fits one SMS is sent whole, exactly as the bridge text', () => {
    let singles = 0;
    for (const [name, message] of PAGES) {
      const text = renderPage(message);
      if (gsmLength(text) > SMS_SINGLE_MAX) continue;
      singles++;
      expect(splitPageForSms(message), name).toEqual([text]);
    }
    expect(singles).toBeGreaterThan(0);
  });

  it('the bridge text is the page whole, every field once, in order (build*Message is renderPage)', () => {
    const ctx = { previousPage: null, unpagedCut: null, now: NOW };
    const risk = composeRiskPage('live_u1_x', 82, ctx);
    expect(buildRiskPageMessage('live_u1_x', 82, ctx)).toBe(risk.fields.map((f) => f.text).join('\n'));
    expect(buildRiskPageMessage('live_u1_x', 82, ctx)).toBe(
      'URGENT: AI-Therapist HIGH crisis flag\n' +
        'Why: RISK SCORE 82/100 from what the participant said.\n' +
        'Session live_u1_x...\n' +
        'https://ai-therapist.nathanblatter.com/admin#session=live_u1_x',
    );
  });
});

describe('the longest real page', () => {
  // A vendor cut during a high third-party flag, as a follow-up: the longest
  // bridge text any builder produces.
  const sessionId = 'live_u1234567_ElovAp3oMAnCoQLKWeqEZIendoORid6Q';
  const peak: IncidentPeak = { severity: 'high', riskScore: 100, subject: 'third_party', ownSeverity: 'medium' };
  const ctx = { previousPage: previous(sessionId, 'own', ['risk', 'vendor_cut']), now: NOW };
  const message = composeVendorCutPage(sessionId, peak, ctx);

  it('is the longest page of all the combinations', () => {
    const longest = Math.max(...PAGES.filter(([, , id]) => id === sessionId).map(([, m]) => renderPage(m).length));
    expect(buildVendorCutMessage(sessionId, peak, ctx).length).toBe(longest);
  });

  it('splits into four parts with the headline, whose risk, the Why line and the link in part 1', () => {
    const parts = splitPageForSms(message);
    expect(parts).toEqual([
      '(1/4) URGENT: AI-Therapist voice session CUT BY VENDOR FILTER at a HIGH flag (third party)\n' +
        'Why: VENDOR CUT, not a new risk score. HIGH flag (100/100) was about SOMEONE ELSE; own risk: MEDIUM.\n' +
        `https://ai-therapist.nathanblatter.com/admin#session=${sessionId}`,
      '(2/4) Review the transcript and consider reaching out.\n' +
        'Why: VENDOR CUT, not a new risk score. The participant lost the assistant mid-conversation; the HIGH ' +
        'flag (100/100) was about SOMEONE ELSE the participant was reporting on (third party at risk), not the ' +
        'participant.',
      "(3/4) The participant's own assessed risk was MEDIUM.\n" +
        'Session live_u1234567_El.... The app moves them to typed chat (a new voice call if chat is off) under a ' +
        'new session id; further cuts in the next 15 minutes are recorded, not paged.',
      '(4/4) Follow-up for the same participant: you were paged 14 min ago (high risk score + vendor filter ' +
        'ended a session). This is new or more serious.',
    ]);
  });

  it('a risk page with every extra line keeps all of them in part 1, with the instruction in place of the link', () => {
    const parts = splitPageForSms(
      composeRiskPage(
        sessionId,
        100,
        {
          previousPage: previous(sessionId, 'third_party', ['risk']),
          unpagedCut: { sessionId, at: NOW - 80_000 },
          now: NOW,
        },
        'model_escalation',
        'own',
        { escalation: 'attempt', alsoSubject: 'harm_to_others' },
      ),
    );
    expect(parts[0]).toBe(
      `(1/${parts.length}) URGENT: AI-Therapist HIGH crisis flag\n` +
        'WHAT IT SAYS: ATTEMPT IN PROGRESS or act taken.\n' +
        'ALSO: harming another person.\n' +
        "PARTICIPANT'S OWN RISK (earlier page: someone else).\n" +
        'Why: ASSISTANT asked for a human (escalate tool); fixed score 100/100.\n' +
        'Open Crisis Management: session live_u1234567_El...',
    );
    expect(parts[1]).toMatch(/^\(2\/\d\) https:\/\/ai-therapist\.nathanblatter\.com\/admin#session=live_u1234567_/);
  });
});

describe('characters outside GSM-7, and the septet count', () => {
  it('typographic punctuation and other non-GSM characters become plain 7-bit in every part', () => {
    const message = page(
      field('headline', 'URGENT: AI‑Therapist “HIGH” flag — test 中'),
      field('why', `Why: it’s ${'long words '.repeat(30)}…`, 'Why: it’s short…'),
      field('detail', `Detail éè ${'more text here. '.repeat(20)}`),
      field('link', 'https://x.example/admin#session=a', 'Open Crisis Management: session a...'),
    );
    const parts = splitPageForSms(message);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(/^[\n\x20-\x7E]*$/.test(part)).toBe(true);
    expect(parts[0]).toContain('URGENT: AI-Therapist "HIGH" flag - test ?');
    expect(parts[0]).toContain("Why: it's short...");
    expect(parts[0]).toContain('https://x.example/admin#session=a');
    expect(parts.join(' ')).toContain('Detail ee');
  });

  it('extension characters count twice toward the limit', () => {
    const message = page(
      field('headline', `URGENT ${'[x]'.repeat(40)}`),
      field('why', 'Why: test.'),
      field('detail', 'd '.repeat(100)),
      field('link', 'https://x.example/admin#session=a', 'Open Crisis Management: session a...'),
    );
    const parts = splitPageForSms(message);
    // 120 characters, 200 septets: with the rest it no longer fits one SMS.
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(gsmLength(part)).toBeLessThanOrEqual(SMS_PART_MAX);
    expect(parts[0]).toContain('https://x.example/admin#session=a');
  });

  it('a page whose part-1 fields cannot fit even in short form still sends, cut, within the limits', () => {
    const message = page(
      field('headline', `URGENT ${'word '.repeat(80)}`),
      field('why', `Why: ${'reason '.repeat(30)}`),
      field('link', 'https://x.example/admin#session=abc', 'Open Crisis Management: session abc...'),
      field('action', 'Review the transcript.'),
    );
    const parts = splitPageForSms(message);
    for (const part of parts) expect(gsmLength(part)).toBeLessThanOrEqual(SMS_PART_MAX);
    expect(parts.join('\n')).toContain('https://x.example/admin#session=abc');
    expect(parts.join('\n')).toContain('Review the transcript.');
  });

  it('an empty page is no SMS at all', () => {
    expect(splitPageForSms(page())).toEqual([]);
    expect(splitPageForSms(page(field('detail', '   ')))).toEqual([]);
  });
});
