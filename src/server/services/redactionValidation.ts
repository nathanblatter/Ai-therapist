// Redaction output validation (ai-therapist-382).
//
// Redaction is a generative rewrite, and the model does not always do the job
// it was given. On crisis content gpt-5 often answers the transcript instead
// of redacting it ("I'm really sorry you're going through this... call
// 988"). The one-message path used to store whatever came back, so a refusal
// could become a message's content_redacted: the redacted transcript of
// exactly the sessions that matter most would then hold the model's words
// instead of the participant's, and the content wipe would delete the only
// true copy.
//
// Every redaction output now passes through validateRedaction() before it is
// stored. The rule is structural: a redaction is the input with some spans
// replaced by "[REDACTED: ...]" placeholders. So, comparing word tokens with
// placeholders removed,
//   - almost every word in the output must come from the input (a reply,
//     refusal or added crisis resource brings in words the input never had);
//   - the words that went missing must be explainable by the placeholders the
//     model added (at most PLACEHOLDER_SPAN words each), so a message cannot
//     shrink to a fragment or vanish;
//   - empty input gives empty output, and non-empty input never gives empty
//     output;
//   - an output that opens like a refusal, or names a crisis line, when the
//     input does not, is rejected outright (the token rules catch these too;
//     the explicit checks give staff a plain reason).
// This module is pure (no model, no database) so the list-only script in
// src/database/scripts/findInvalidRedactions.ts can use it offline.

/** Matches one redaction placeholder, e.g. "[REDACTED: NAME]" or "[REDACTED]". */
const PLACEHOLDER_RE = /\[\s*REDACTED\b[^\]\n]{0,80}\]/gi;

/** Max input words one added placeholder may stand in for (an address or a
 *  "uniquely identifying characteristic" can run several words). */
export const PLACEHOLDER_SPAN = 10;

/** Openings of a model refusal or an assistant-style reply. */
const REFUSAL_OPENING_RE =
  /^(?:i['’]?m (?:really |so |very |truly )?sorry|i am (?:really |so |very |truly )?sorry|sorry[,.!]|i can(?:['’]?t|not)\b|i['’]?m (?:not able|unable)|i am (?:not able|unable)|i won['’]?t\b|as an ai\b)/i;

/** A crisis resource the model may append when it treats the text as a person in distress. */
const CRISIS_RESOURCE_RE =
  /\b988\b|crisis (?:line|lifeline|text line)|suicide (?:&|and) crisis|lifeline|hotline|741741/i;

export type RedactionRejectReason =
  | 'not_text'
  | 'text_for_empty_input'
  | 'empty_output'
  | 'refusal'
  | 'added_crisis_resource'
  | 'words_not_in_input'
  | 'words_missing'
  | 'unparseable_reply'
  | 'model_refusal'
  | 'call_cap';

export interface RedactionVerdict {
  ok: boolean;
  reason?: RedactionRejectReason;
  /** Short numeric detail for logs and the stored error (never message text). */
  detail?: string;
}

// Curly and straight apostrophes need no mapping: tokens split on them, and
// the refusal pattern accepts both.
function normalize(s: string): string {
  return s.normalize('NFKC');
}

/** Leading quote marks and whitespace the model may wrap an answer in. */
function stripLeadingQuotes(s: string): string {
  return s.replace(/^[\s"'“”‘’]+/, '');
}

export function countPlaceholders(s: string): number {
  return (normalize(s).match(PLACEHOLDER_RE) ?? []).length;
}

/** Lower-cased word tokens with every placeholder removed. */
export function wordTokens(s: string): string[] {
  return (
    normalize(s)
      .replace(PLACEHOLDER_RE, ' ')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function counts(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** Sum over tokens of max(0, count in a - count in b). */
function excess(a: Map<string, number>, b: Map<string, number>): number {
  let n = 0;
  for (const [t, c] of a) n += Math.max(0, c - (b.get(t) ?? 0));
  return n;
}

/** True when the text opens like a refusal or an assistant reply. */
export function looksLikeRefusal(s: string): boolean {
  return REFUSAL_OPENING_RE.test(stripLeadingQuotes(normalize(s)));
}

export function mentionsCrisisResource(s: string): boolean {
  return CRISIS_RESOURCE_RE.test(normalize(s));
}

/**
 * Is `output` a redaction of `input`? Pure and deterministic. `input` may
 * itself be redacted (the second pass), in which case its placeholders are
 * not counted as new.
 */
export function validateRedaction(input: string, output: unknown): RedactionVerdict {
  if (typeof output !== 'string') return { ok: false, reason: 'not_text' };
  const inputBlank = input.trim() === '';
  const outputBlank = output.trim() === '';
  if (inputBlank) {
    return outputBlank ? { ok: true } : { ok: false, reason: 'text_for_empty_input' };
  }
  if (outputBlank) return { ok: false, reason: 'empty_output' };

  if (looksLikeRefusal(output) && !looksLikeRefusal(input)) return { ok: false, reason: 'refusal' };
  if (mentionsCrisisResource(output) && !mentionsCrisisResource(input)) {
    return { ok: false, reason: 'added_crisis_resource' };
  }

  const inTokens = wordTokens(input);
  const outTokens = wordTokens(output);
  const inCounts = counts(inTokens);
  const outCounts = counts(outTokens);

  // Words the output has that the input does not. A redaction only removes.
  // A little slack for the model normalising a word or two.
  const novel = excess(outCounts, inCounts);
  const novelAllowed = Math.max(2, Math.floor(outTokens.length * 0.1));
  if (novel > novelAllowed) {
    return { ok: false, reason: 'words_not_in_input', detail: `${novel}/${outTokens.length}` };
  }

  // Words the input had that the output dropped: each must be covered by a
  // placeholder the model added.
  const missing = excess(inCounts, outCounts);
  const newPlaceholders = Math.max(0, countPlaceholders(output) - countPlaceholders(input));
  const missingAllowed = newPlaceholders * PLACEHOLDER_SPAN + Math.max(1, Math.floor(inTokens.length * 0.05));
  if (missing > missingAllowed) {
    return {
      ok: false,
      reason: 'words_missing',
      detail: `${missing}/${inTokens.length} missing, ${newPlaceholders} placeholders`,
    };
  }
  return { ok: true };
}

/** The text stored in metadata.redaction_error for a rejected output. Never
 *  contains message text: a reason code and counts only. */
export function rejectionError(verdict: RedactionVerdict): string {
  const detail = verdict.detail ? ` (${verdict.detail})` : '';
  return `Redaction output rejected: ${verdict.reason ?? 'unknown'}${detail}`;
}
