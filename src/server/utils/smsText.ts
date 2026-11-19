// Text shaping for carrier SMS (on-call paging, services/crisisAlert.service).
// Pure functions, no I/O.
//
// A page is written once and sent on every channel. The iMessage bridge takes
// it as it is. A carrier SMS has two constraints the bridge does not:
//
//   - Alphabet. A message made only of GSM-7 characters is billed and
//     delivered in 160-character segments (153 when concatenated). ONE
//     character outside that alphabet (a curly quote, a long dash) switches
//     the whole message to UCS-2 and 70-character segments. So the SMS copy is
//     reduced to plain ASCII, all of which is GSM-7.
//   - Length. Long concatenated messages are where carriers reorder and drop
//     parts. A page that fits SMS_SINGLE_MAX goes as one message; a longer one
//     is DELIBERATELY split, at line and sentence boundaries, into numbered
//     parts ("(1/2) ...") that each fit two segments, so every part reads on
//     its own and the on-call can see if one is missing.
//
// Nothing is reworded: the SMS says exactly what the other channel says.

/** A page up to this many characters is sent as one SMS (two segments). */
export const SMS_SINGLE_MAX = 320;

/** Longest a numbered part may be, label included: two concatenated GSM-7
 *  segments are 306 characters. */
export const SMS_PART_MAX = 300;

/** Never more parts than this; the last one says the rest is on the dashboard. */
export const SMS_MAX_PARTS = 6;

const TRUNCATED_NOTE = ' [more on the dashboard]';

/** GSM-7 extension characters: sent as two septets each. */
const GSM_EXTENSION = new Set(['^', '{', '}', '\\', '[', '~', ']', '|']);

const REPLACEMENTS: Array<[RegExp, string]> = [
  [/[‘’‚′]/g, "'"],
  [/[“”„″]/g, '"'],
  [/[‐-―−]/g, '-'],
  [/…/g, '...'],
  [/[•·‣◦]/g, '-'],
  [/[→⇒]/g, '->'],
  [/[  -  ]/g, ' '],
  [/[​-‍﻿]/g, ''],
  [/\r\n?/g, '\n'],
  [/\t/g, ' '],
  // Not in GSM-7 although it is ASCII.
  [/`/g, "'"],
];

/**
 * The text reduced to characters every carrier delivers in the 7-bit
 * alphabet: printable ASCII (minus the backtick) and newlines. Typographic
 * punctuation is replaced by its plain form, accents are dropped, and
 * anything else becomes '?'. Meaning is unchanged for the page copy this
 * project writes, which is ASCII already (pinned by a test).
 */
export function toGsm7(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REPLACEMENTS) out = out.replace(pattern, replacement);
  out = out.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return out.replace(/[^\n\x20-\x7E]/g, '?');
}

/** Length in GSM-7 septets (extension characters count twice). */
export function gsmLength(text: string): number {
  let n = 0;
  for (const ch of text) n += GSM_EXTENSION.has(ch) ? 2 : 1;
  return n;
}

/** Cut `text` so its GSM length is at most `max`, preferring to end after a
 *  sentence, then at a space. Returns [head, rest]. */
function cut(text: string, max: number): [string, string] {
  if (gsmLength(text) <= max) return [text, ''];
  let end = 0;
  let used = 0;
  for (const ch of text) {
    const w = GSM_EXTENSION.has(ch) ? 2 : 1;
    if (used + w > max) break;
    used += w;
    end += ch.length;
  }
  const window = text.slice(0, end);
  const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('; '), window.lastIndexOf(': '));
  const space = window.lastIndexOf(' ');
  // Only break at a sentence if that does not waste most of the part.
  const at = sentence >= max * 0.4 ? sentence + 1 : space > 0 ? space : end;
  return [text.slice(0, at).trimEnd(), text.slice(at).trimStart()];
}

/**
 * The SMS form of a page: one message when it fits, otherwise numbered parts.
 * Lines are kept whole where possible and packed in order, so the first part
 * is always the headline and what follows it (for a participant page: the
 * "Why:" line). Every returned string is GSM-7 and at most SMS_SINGLE_MAX
 * (single) or SMS_PART_MAX (part) long.
 */
export function splitForSms(message: string): string[] {
  const text = toGsm7(message)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text === '') return [];
  if (gsmLength(text) <= SMS_SINGLE_MAX) return [text];

  // Room for the label "(n/m) ": at most "(6/6) ".
  const budget = SMS_PART_MAX - 6;
  const pieces: string[] = [];
  for (const line of text.split('\n')) {
    let rest = line;
    if (rest === '') continue;
    while (rest !== '') {
      const [head, tail] = cut(rest, budget);
      pieces.push(head);
      rest = tail;
    }
  }

  const bodies: string[] = [];
  let current = '';
  for (const piece of pieces) {
    const joined = current === '' ? piece : `${current}\n${piece}`;
    if (gsmLength(joined) <= budget) current = joined;
    else {
      bodies.push(current);
      current = piece;
    }
  }
  if (current !== '') bodies.push(current);

  if (bodies.length > SMS_MAX_PARTS) {
    bodies.length = SMS_MAX_PARTS;
    const [head] = cut(bodies[SMS_MAX_PARTS - 1], budget - TRUNCATED_NOTE.length);
    bodies[SMS_MAX_PARTS - 1] = `${head}${TRUNCATED_NOTE}`;
  }
  return bodies.map((body, i) => `(${i + 1}/${bodies.length}) ${body}`);
}

/**
 * A phone number in E.164 (what the SMS API requires), from the forms the
 * on-call phone is stored in: "+18015551234", "(801) 555-1234",
 * "1-801-555-1234". Ten digits are taken as a US/Canada number. Null when it
 * cannot be read as a phone number; the caller reports that, it does not
 * guess.
 */
export function toE164(phone: string): string | null {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null;
  if (/^\d{10}$/.test(digits) && /^[2-9]/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return null;
}
