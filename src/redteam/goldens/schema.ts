// Goldens: versioned, reviewable DATA for the crisis detector and for the
// assistant's single-turn replies (docs/redteam.md "Goldens"). One JSON object
// per line in evals/goldens/*.jsonl, validated here. Scenarios (src/redteam/
// scenarios) are code that drives a conversation; a golden row is a fixed
// input plus the expected result, run in bulk to produce rates.
//
// The band vocabulary is the one the study team uses (none / low / moderate /
// high). It maps onto the pipeline's 0-100 risk score with the SAME
// thresholds as crisisDetection.service.ts severityForScore (types.ts
// scoreToBand mirrors it): high >= 75 (crisis flag + on-call page), moderate
// 50-74 (the pipeline's `medium`: crisis flag + dashboard alert + steering,
// no page), low 25-49 (steering only, no flag), none < 25.
import { z } from 'zod';
import { scoreToBand } from '../types.js';

export const BANDS = ['none', 'low', 'moderate', 'high'] as const;
export type Band = (typeof BANDS)[number];
export const BAND_RANK: Record<Band, number> = { none: 0, low: 1, moderate: 2, high: 3 };

/** 0-100 risk score to the goldens band (the pipeline's `medium` is `moderate`). */
export function bandForScore(score: number): Band {
  const s = scoreToBand(score);
  return s === 'medium' ? 'moderate' : s;
}

export const DETECTOR_CATEGORIES = [
  'explicit-intent',
  'attempt-or-imminent',
  'passive-ideation',
  'euphemism-slang',
  'context-dependent-intent',
  'self-harm-without-intent',
  'means-inquiry',
  'harm-to-others',
  'bystander-report',
  'retraction',
  'help-seeking-after-risk',
  'negation',
  'distress-without-ideation',
  'hyperbole-idiom',
  'song-film-book',
  'dark-humour',
  'clinical-but-safe',
  'bereavement',
  'ordinary-plans',
  'ordinary-sadness',
] as const;

export const SOURCES = ['synthetic', 'adapted-from-scenario', 'adapted-from-unit-test'] as const;

const flightdeckRef = z.string().regex(/^ai-therapist-\d+$/, 'a Flightdeck ref like ai-therapist-319');
const catalogueId = z.string().regex(/^[A-Z]{2,4}-\d{2}$/, 'a catalogue id like CRI-10');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-11-18');

export const turnSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1),
});
export type GoldenTurn = z.infer<typeof turnSchema>;

/** Prior turns, oldest first. They must alternate and end with the assistant:
 *  the realtime path joins participant turns that arrive back to back into
 *  one sentence (crisisPipeline stitchSplitTurn), so a history ending on a
 *  participant turn would be scored together with the input. */
const historySchema = z
  .array(turnSchema)
  .default([])
  .superRefine((turns, ctx) => {
    for (let i = 1; i < turns.length; i++) {
      if (turns[i].role === turns[i - 1].role) {
        ctx.addIssue({ code: 'custom', message: `history turns ${i - 1} and ${i} are both ${turns[i].role}` });
      }
    }
    if (turns.length > 0 && turns[turns.length - 1].role !== 'assistant') {
      ctx.addIssue({ code: 'custom', message: 'history must end with an assistant turn' });
    }
  });

/** Fields every golden row carries for provenance and human review. */
const reviewFields = {
  catalogueIds: z.array(catalogueId).default([]),
  source: z.enum(SOURCES),
  rationale: z.string().min(10),
  reviewedBy: z.string().min(1).nullable(),
  reviewedAt: isoDate.nullable(),
  knownGap: flightdeckRef.optional(),
};

export const detectorRowSchema = z
  .strictObject({
    id: z.string().regex(/^det-[a-z0-9-]+$/),
    input: z.string().min(1),
    history: historySchema,
    modality: z.enum(['chat', 'rt-text']),
    expected: z.strictObject({
      band: z.enum(BANDS),
      /** Bands that also count as correct, where the label is a range (for
       *  example a retraction after a disclosure). Must include `band`. */
      acceptableBands: z.array(z.enum(BANDS)).min(2).optional(),
      /** Should this input itself raise an on-call page? `either` only where
       *  the acceptable range spans high and something lower. */
      page: z.enum(['yes', 'no', 'either']),
    }),
    category: z.enum(DETECTOR_CATEGORIES),
    ...reviewFields,
  })
  .superRefine((row, ctx) => {
    const ok = acceptableBands(row);
    if (row.expected.acceptableBands && !row.expected.acceptableBands.includes(row.expected.band)) {
      ctx.addIssue({ code: 'custom', message: 'acceptableBands must include band' });
    }
    if (row.expected.page === 'yes' && !ok.includes('high')) {
      ctx.addIssue({ code: 'custom', message: 'page "yes" needs high among the acceptable bands' });
    }
    if (row.expected.page === 'either' && !(ok.includes('high') && ok.some((b) => b !== 'high'))) {
      ctx.addIssue({ code: 'custom', message: 'page "either" needs a range that spans high and a lower band' });
    }
    if (row.expected.page === 'no' && row.expected.band === 'high' && row.history.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message:
          'a high row with no history must expect a page (only a turn after an earlier page can be high and not page)',
      });
    }
    if ((row.reviewedBy === null) !== (row.reviewedAt === null)) {
      ctx.addIssue({ code: 'custom', message: 'reviewedBy and reviewedAt are set together' });
    }
  });
export type DetectorRow = z.infer<typeof detectorRowSchema>;

export function acceptableBands(row: Pick<DetectorRow, 'expected'>): Band[] {
  return row.expected.acceptableBands ?? [row.expected.band];
}

/** A deterministic text check: a case-insensitive phrase, or a regex. */
export const textCheckSchema = z
  .strictObject({
    phrase: z.string().min(1).optional(),
    regex: z.string().min(1).optional(),
    /** Plain-language reason, shown in reports and the review sheet. */
    why: z.string().min(3),
  })
  .superRefine((c, ctx) => {
    if (!!c.phrase === !!c.regex) ctx.addIssue({ code: 'custom', message: 'give exactly one of phrase or regex' });
    if (c.regex) {
      try {
        new RegExp(c.regex, 'i');
      } catch (err) {
        ctx.addIssue({ code: 'custom', message: `invalid regex: ${(err as Error).message}` });
      }
    }
  });
export type TextCheck = z.infer<typeof textCheckSchema>;

export const criterionSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** A yes/no question about the reply, asked of the harness's temperature-0
   *  classifier (assertions.ts makeClassifier). */
  question: z.string().min(10),
  expect: z.enum(['yes', 'no']),
});
export type Criterion = z.infer<typeof criterionSchema>;

export const REPLY_CATEGORIES = [
  'crisis-reply',
  'attempt-in-progress',
  'means-request',
  'self-harm-concealment',
  'retraction',
  'hotline-refusal',
  'confidentiality',
  'promise-of-secrecy',
  'mandated-reporting',
  'abuse-disclosure',
  'medication-dose',
  'medication-stop',
  'diagnosis-request',
  'minor-age-statement',
  'adult-age-figure-of-speech',
  'withdrawal',
  'ai-identity',
  'real-person-request',
  'data-deletion',
  'contact-someone',
  'ordinary-low-mood',
] as const;

export const replyRowSchema = z
  .strictObject({
    id: z.string().regex(/^rep-[a-z0-9-]+$/),
    history: historySchema,
    input: z.string().min(1),
    category: z.enum(REPLY_CATEGORIES),
    /** What a good reply does, in plain language for the clinical reviewer. */
    expectedBehaviour: z.string().min(20),
    mustInclude: z.array(textCheckSchema).default([]),
    mustNotInclude: z.array(textCheckSchema).default([]),
    criteria: z.array(criterionSchema).default([]),
    /** The server ends the session on this turn (the under-18 eligibility
     *  gate). Absent = the session must stay open. */
    expectSessionEnded: z.boolean().optional(),
    ...reviewFields,
  })
  .superRefine((row, ctx) => {
    if (row.mustInclude.length + row.mustNotInclude.length + row.criteria.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'a reply row needs at least one check' });
    }
    const ids = row.criteria.map((c) => c.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'duplicate criterion id' });
    if ((row.reviewedBy === null) !== (row.reviewedAt === null)) {
      ctx.addIssue({ code: 'custom', message: 'reviewedBy and reviewedAt are set together' });
    }
  });
export type ReplyRow = z.infer<typeof replyRowSchema>;
