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
// Nothing is reworded by this module. A structured page (utils/pageMessage)
// carries its own short forms for SMS part 1, written by the page's builder;
// see splitPageForSms.
import { PART_ONE_ROLES, type PageFieldRole, type PageMessage } from './pageMessage.js';

/** A page up to this many GSM-7 septets is sent as one SMS: two concatenated
 *  segments of 153 (the 7 that make 160 carry the concatenation header).
 *  320 would have been three segments. */
export const SMS_SINGLE_MAX = 306;

/** Longest a numbered part may be, label included: two concatenated GSM-7
 *  segments are 306 characters. */
export const SMS_PART_MAX = 300;

/** Never more parts than this; the last one says the rest is on the dashboard. */
export const SMS_MAX_PARTS = 6;

const TRUNCATED_NOTE = ' [more on the dashboard]';

/** GSM-7 extension characters: sent as two septets each. */
const GSM_EXTENSION = new Set(['^', '{', '}', '\\', '[', '~', ']', '|']);

const REPLACEMENTS: Array<[RegExp, string]> = [
  [/[\u2018\u2019\u201A\u2032]/g, "'"],
  [/[\u201C\u201D\u201E\u2033]/g, '"'],
  [/[\u2010-\u2015\u2212]/g, '-'],
  [/\u2026/g, '...'],
  [/[\u2022\u00B7\u2023\u25E6]/g, '-'],
  [/[\u2192\u21D2]/g, '->'],
  [/[\u00A0\u2002-\u200A\u202F]/g, ' '],
  [/[\u200B-\u200D\uFEFF]/g, ''],
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
  out = out.normalize('NFKD').replace(/[\u0300-\u036F]/g, '');
  return out.replace(/[^\n\x20-\x7E]/gu, '?');
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
 * The SMS form of a plain-text page (the system alerts): one message when it
 * fits, otherwise numbered parts. Lines are kept whole where possible and
 * packed in order, so the first part starts with the headline. Participant
 * pages are structured and go through splitPageForSms, which decides what
 * part 1 carries. Every returned string is GSM-7 and at most SMS_SINGLE_MAX
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
  return labelParts(packLines(text.split('\n'), PART_BODY_MAX));
}

/** Room for the label "(n/m) ": at most "(6/6) ". */
const PART_BODY_MAX = SMS_PART_MAX - 6;

/** Normalise one field or line for SMS: GSM-7, one line, no stray spaces. */
function smsLine(text: string): string {
  return toGsm7(text)
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

/** Pack lines, in order, into bodies of at most `budget`; a line longer than
 *  that is cut at a sentence or a space. */
function packLines(lines: string[], budget: number, fillAtSentences = false): string[] {
  const pieces: string[] = [];
  for (const line of lines) {
    let rest = line;
    while (rest !== '') {
      const [head, tail] = cut(rest, budget);
      pieces.push(head);
      rest = tail;
    }
  }
  const bodies: string[] = [];
  let current = '';
  for (let piece of pieces) {
    const joined = current === '' ? piece : `${current}\n${piece}`;
    if (gsmLength(joined) <= budget) {
      current = joined;
      continue;
    }
    // With `fillAtSentences`, the whole sentences of the next line that fit
    // finish this part, so a short line does not cost a part of its own.
    if (fillAtSentences && current !== '') {
      const [head, tail] = sentencesThatFit(piece, budget - gsmLength(current) - 1);
      if (head !== '') {
        current = `${current}\n${head}`;
        piece = tail;
      }
    }
    bodies.push(current);
    current = piece;
  }
  if (current !== '') bodies.push(current);
  return bodies;
}

/** The longest run of whole sentences at the start of `text` that fits in
 *  `room`, and the rest. ['', text] when not even the first sentence fits. */
function sentencesThatFit(text: string, room: number): [string, string] {
  let at = -1;
  for (let i = text.indexOf('. '); i !== -1; i = text.indexOf('. ', i + 1)) {
    if (gsmLength(text.slice(0, i + 1)) > room) break;
    at = i + 1;
  }
  return at === -1 ? ['', text] : [text.slice(0, at), text.slice(at).trimStart()];
}

/** Number the bodies "(n/m) ", capped at SMS_MAX_PARTS (the last one then
 *  says the rest is on the dashboard). Part 1 is never cut. */
function labelParts(bodies: string[]): string[] {
  if (bodies.length > SMS_MAX_PARTS) {
    bodies.length = SMS_MAX_PARTS;
    const [head] = cut(bodies[SMS_MAX_PARTS - 1], PART_BODY_MAX - TRUNCATED_NOTE.length);
    bodies[SMS_MAX_PARTS - 1] = `${head}${TRUNCATED_NOTE}`;
  }
  return bodies.map((body, i) => `(${i + 1}/${bodies.length}) ${body}`);
}

/** The order in which part-1 fields fall back to their short form when part
 *  1 does not fit: the "Why:" line first, then the subject lines, the
 *  headline and what changed, and the link last (its short form is the
 *  instruction without the link, so it is given up only when nothing else
 *  makes room). */
const SHORTEN_ORDER: readonly PageFieldRole[] = ['why', 'subject', 'headline', 'change', 'link'];

/**
 * The SMS form of a structured page (utils/pageMessage).
 *
 * A page that fits one SMS (SMS_SINGLE_MAX) is sent as one SMS, exactly as
 * splitForSms would send its rendered text. A longer one is split so that
 * part 1 stands on its own, whatever order the parts arrive in:
 *
 *   part 1   every field with a part-1 role (headline, subject, change, why,
 *            link), in page order. If they do not fit at full length, fields
 *            take their short form one role at a time (SHORTEN_ORDER) until
 *            they do; the link is replaced by its short form (an instruction
 *            and the session reference) only as the last step. The action
 *            line ("Review the transcript ...") joins part 1 when there is
 *            room left.
 *   part 2+  the admin link, when part 1 carries only its short form; the
 *            action line, when part 1 had no room for it; then, in page
 *            order, the full Why line when part 1 carries its short form
 *            (only what the short form left out, when it is a prefix) and
 *            every detail field. A short headline, subject or change line
 *            says the same thing in fewer words and is not repeated.
 *
 * Every part is GSM-7 and at most SMS_PART_MAX long, label included.
 */
export function splitPageForSms(message: PageMessage): string[] {
  const fields = message.fields
    .map((f) => ({ role: f.role, text: smsLine(f.text), short: f.short === undefined ? undefined : smsLine(f.short) }))
    .filter((f) => f.text !== '');
  if (fields.length === 0) return [];
  const whole = fields.map((f) => f.text).join('\n');
  if (gsmLength(whole) <= SMS_SINGLE_MAX) return [whole];

  const inPartOne = (role: PageFieldRole) => PART_ONE_ROLES.includes(role);
  const shortened = new Set<PageFieldRole>();
  const partOneLines = () =>
    fields.filter((f) => inPartOne(f.role)).map((f) => (shortened.has(f.role) && f.short ? f.short : f.text));
  const fits = (lines: string[]) => gsmLength(lines.join('\n')) <= PART_BODY_MAX;

  let lines = partOneLines();
  for (const role of SHORTEN_ORDER) {
    if (fits(lines)) break;
    shortened.add(role);
    lines = partOneLines();
  }

  const later: string[] = [];
  let first: string;
  if (fits(lines)) {
    // Room left: the action line too.
    const actions = fields.filter((f) => f.role === 'action').map((f) => f.text);
    const withActions = [...lines, ...actions];
    const actionsInPartOne = actions.length > 0 && fits(withActions);
    first = (actionsInPartOne ? withActions : lines).join('\n');
    if (shortened.has('link')) later.push(...fields.filter((f) => f.role === 'link').map((f) => f.text));
    if (!actionsInPartOne) later.push(...actions);
  } else {
    // Unreachable for any page this project writes (pinned by tests); a page
    // with an unusually long field still sends, cut at a sentence or a space.
    const [head, tail] = cut(lines.join('\n'), PART_BODY_MAX);
    first = head;
    if (tail !== '') later.push(tail);
    if (shortened.has('link')) later.push(...fields.filter((f) => f.role === 'link').map((f) => f.text));
    later.push(...fields.filter((f) => f.role === 'action').map((f) => f.text));
  }

  for (const f of fields) {
    if (f.role === 'action' || f.role === 'link') continue;
    if (!inPartOne(f.role)) later.push(f.text);
    else if (f.role === 'why' && shortened.has(f.role) && f.short) {
      // The Why line's full text explains more than its short form: what the
      // short form left out, or the whole line when it is not a prefix. (A
      // short headline, subject or change line says the same thing in fewer
      // words, so it is not repeated.)
      const rest = f.text.startsWith(f.short) ? f.text.slice(f.short.length).trim() : f.text;
      if (rest !== '') later.push(rest);
    }
  }

  return labelParts([first, ...packLines(later, PART_BODY_MAX, true)]);
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
