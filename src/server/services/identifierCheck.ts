// "Which kinds of identifier does this text contain?" asked of the OpenAI
// Decisions API (POST /v1/decisions): five yes/no questions in one request,
// each answered with a probability. No text is generated or rewritten.
//
// Two callers:
//   - the redaction leak check (redactionVerifier.service.ts) asks it of every
//     REDACTED message, to flag an identifier redaction left in;
//   - redaction itself (redaction.service.ts) asks it of a message the
//     redaction model REFUSED to rewrite, to tell "nothing in it to redact"
//     from "still needs a person" (ai-therapist-409).
//
// One broad question was replaced by one question per kind on 2026-11-26
// (docs/redaction-shape-eval-2026-11-26.md, addendum 4). On the same stored
// outputs the single question flagged 62 of 95 messages that still held an
// organisation name and 12 of 55 clean ones; the five questions flagged 95 of
// 95 and 3 of 55, and say which kind is suspected.
//
// This module holds the wire shape and nothing else: no database, no config.
// Contract (GA reference, read 2026-11-26):
//   request   { model, input, questions: [{ type, name, instructions }] }
//   response  { model, answers: [{ type, name, probability } | { type: 'refusal', name }], usage }

import type OpenAI from 'openai';

/** The only model the Decisions API runs on. */
export const IDENTIFIER_MODEL = 'gpt-6-luna';

const NOT_IDENTIFIERS =
  ' A placeholder such as [REDACTED: NAME] or [REDACTED: ORGANIZATION] is NOT an identifier.' +
  ' A generic reference without a proper name ("my mom", "my therapist", "the university", "my ward", "work")' +
  ' is NOT an identifier.';

export const IDENTIFIER_QUESTIONS = [
  {
    name: 'person_name',
    instructions:
      "Does this text still contain a specific person's name (a first name, last name, or a nickname used as a name)?" +
      NOT_IDENTIFIERS,
  },
  {
    name: 'organization',
    instructions:
      'Does this text still contain the proper name of a specific organization or facility: a school, college or ' +
      'university (or one of its named buildings, dorms or teams), an employer or business, a hospital or clinic, ' +
      'a church, ward or congregation, an apartment complex, or a sports team or club?' +
      NOT_IDENTIFIERS,
  },
  {
    name: 'place',
    instructions:
      'Does this text still contain a street address, or the name of a city, town, county or neighbourhood (any ' +
      'named place smaller than a state)?' +
      NOT_IDENTIFIERS,
  },
  {
    name: 'date',
    // Reworded 2026-11-27 (with contact_or_number below). The first wording
    // ("Does this text still contain a specific calendar date ...") answered
    // yes to ordinary messages with no date in them ("Hi", "Yeah", "Bye."):
    // 501 of 2,442 stage messages at 0.5 or more. A statement that says most
    // messages contain none does not (2 of 2,442), and still finds every
    // dated message tried (docs/redaction-shape-eval-2026-11-26.md, addendum 5).
    instructions:
      'The text contains a calendar date that identifies a particular day: a month together with a day number, or ' +
      'a numeric date such as 12/04 or 3/14/2004. Most messages contain no date; greetings, feelings, weekdays, ' +
      'years alone, times of day and relative words ("today", "tonight", "last week", "in March") do not count, ' +
      'and neither does a placeholder such as [REDACTED: DATE].',
  },
  {
    name: 'contact_or_number',
    instructions:
      'The text contains a phone number, an email address, a web address, a social media handle, or an account, ' +
      'record, licence, plate or ID number that belongs to a specific person. Most messages contain none. Public ' +
      'crisis and emergency numbers (988, 911, 741741), ages, counts, scores, amounts, times of day and a ' +
      'placeholder such as [REDACTED: TELEPHONE NUMBER] do not count.',
  },
] as const;

export type IdentifierKind = (typeof IDENTIFIER_QUESTIONS)[number]['name'];
export const IDENTIFIER_KINDS: IdentifierKind[] = IDENTIFIER_QUESTIONS.map((q) => q.name);

export interface IdentifierAnswer {
  /** Probability, 0..1, that the text contains each kind of identifier. */
  kinds: Record<IdentifierKind, number>;
  /** The largest of them: the probability the text contains any identifier. */
  pMax: number;
  tokensIn: number | null;
  tokensOut: number | null;
}

/** No `store` field: the Decisions API has none (retention follows the org's
 *  data controls), and an unknown parameter is a 400. */
export function buildIdentifierBody(text: string): OpenAI.DecisionCreateParams {
  return {
    model: IDENTIFIER_MODEL,
    input: text,
    questions: IDENTIFIER_QUESTIONS.map((q) => ({
      type: 'predicate' as const,
      name: q.name,
      instructions: q.instructions,
    })),
  };
}

/**
 * Read one probability per question. Throws when any question is refused,
 * missing or not a predicate probability: an answer set with a hole in it is
 * not an answer, and the callers treat a throw as "unknown", never "clean".
 */
export function parseIdentifierResponse(raw: unknown): IdentifierAnswer {
  const root = (raw ?? {}) as Record<string, unknown>;
  const answers = Array.isArray(root.answers) ? (root.answers as Array<Record<string, unknown> | null>) : [];
  if (answers.length === 0) throw new Error('Decisions API response had no answers');
  const kinds = {} as Record<IdentifierKind, number>;
  IDENTIFIER_KINDS.forEach((kind, position) => {
    // Answers come back in question order and echo the question name. Prefer
    // the name; fall back to position only when the names are absent.
    const answer =
      answers.find((a) => a?.name === kind) ?? (answers[position]?.name == null ? answers[position] : null);
    if (!answer) throw new Error(`Decisions API response had no answer for ${kind}`);
    if (answer.type === 'refusal') throw new Error(`Decisions API refused the ${kind} question`);
    const p = answer.probability;
    if (answer.type !== 'predicate' || typeof p !== 'number' || !Number.isFinite(p)) {
      throw new Error(`Decisions API answer for ${kind} had no predicate probability (type: ${String(answer.type)})`);
    }
    // A probability outside 0..1 is a broken answer, not a very clean or a
    // very leaky one: clamping -0.2 to 0 would read as "certainly clean".
    if (p < 0 || p > 1) throw new Error(`Decisions API answer for ${kind} had an out-of-range probability`);
    kinds[kind] = p;
  });
  const u = root.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  return {
    kinds,
    pMax: Math.max(...IDENTIFIER_KINDS.map((k) => kinds[k])),
    tokensIn: u?.input_tokens ?? null,
    tokensOut: u?.output_tokens ?? null,
  };
}

export type DecisionsClient = { decisions: { create: (body: OpenAI.DecisionCreateParams) => Promise<unknown> } };

export async function askIdentifierKinds(client: DecisionsClient, text: string): Promise<IdentifierAnswer> {
  return parseIdentifierResponse(await client.decisions.create(buildIdentifierBody(text)));
}
