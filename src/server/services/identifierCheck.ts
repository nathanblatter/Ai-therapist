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
    instructions:
      'Does this text still contain a specific calendar date other than a year (for example a birth date, ' +
      '"March 3rd", "12/04")? Relative or general time expressions ("tonight", "last week", a weekday, a time of ' +
      'day) are NOT dates.' +
      NOT_IDENTIFIERS,
  },
  {
    name: 'contact_or_number',
    instructions:
      'Does this text still contain a phone number, email address, URL, social media handle, or an account, ' +
      'record, licence or other number or code that identifies a specific person?' +
      NOT_IDENTIFIERS,
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

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
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
    if (answer.type !== 'predicate' || typeof answer.probability !== 'number' || !Number.isFinite(answer.probability)) {
      throw new Error(`Decisions API answer for ${kind} had no predicate probability (type: ${String(answer.type)})`);
    }
    kinds[kind] = clamp01(answer.probability);
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
