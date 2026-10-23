// Practice-assignment vocabulary shared by the server validators, the AI's
// assign_practice tool, and the clinician Homework panel (ai-therapist-200),
// so the kind/frequency options cannot drift between the two sides.

export const PRACTICE_KINDS = ['worksheet', 'exercise', 'observation', 'custom'] as const;
export type PracticeKind = (typeof PRACTICE_KINDS)[number];

/** Clinician-selectable frequencies. The column stays free text because the
 *  AI tool records whatever the participant agreed to ("when the worry shows
 *  up"); the clinician form offers these fixed, participant-readable values. */
export const PRACTICE_FREQUENCIES = [
  'daily',
  'twice daily',
  'several times a week',
  'weekly',
  'as needed',
  'once before next session',
] as const;
export type PracticeFrequency = (typeof PRACTICE_FREQUENCIES)[number];

export const PRACTICE_TITLE_MAX = 200;
export const PRACTICE_DESCRIPTION_MAX = 1000;
export const PRACTICE_CANCEL_REASON_MAX = 500;

export function isPracticeKind(value: unknown): value is PracticeKind {
  return typeof value === 'string' && (PRACTICE_KINDS as readonly string[]).includes(value);
}

export function isPracticeFrequency(value: unknown): value is PracticeFrequency {
  return typeof value === 'string' && (PRACTICE_FREQUENCIES as readonly string[]).includes(value);
}
