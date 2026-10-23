// De-personalisation of a filled worksheet instance into a promotable TEMPLATE
// (ai-therapist-89). The review loop shows the researcher the filled instance
// but only ever stores the template: the structure (section types and prompt
// labels, example placeholders) plus the vetted template's rationale.
//
// Strip rule, in order of what is dropped:
//   - `responses` (the participant's answers) are never read into the text.
//   - `intro` is dropped: create_custom_worksheet instructs the model to write
//     it "referencing what they told you", so it is participant-derived by
//     contract even though the participant did not type it.
//   - section labels and placeholders are kept (they are the prompts the
//     template exists to carry); the reviewer edits them before confirming.
// findParticipantContent() is the second line of defence: the promote route
// refuses any confirmed text that still contains an answer, whole or as a
// run of SHINGLE_WORDS consecutive words, so a reviewer cannot paste one in.
import type { WorksheetSection } from '../db/worksheets.queries.js';

export interface WorksheetTemplateSource {
  title: string;
  sections: WorksheetSection[];
  template_title: string | null;
  /** Content of the vetted knowledge chunk the instance was generated from. */
  template_rationale: string | null;
}

export interface WorksheetTemplate {
  title: string;
  content: string;
}

/** Answers shorter than this are not matched: "7", "yes" or "work" would
 *  trip on ordinary template wording and carry no participant signal. */
export const MIN_ANSWER_CHARS = 12;
/** A run of this many consecutive answer words inside the template fails it. */
export const SHINGLE_WORDS = 5;

export function buildWorksheetTemplate(src: WorksheetTemplateSource): WorksheetTemplate {
  const title = src.title.trim();
  const lines: string[] = [`Worksheet template: ${title}`];
  if (src.template_title && src.template_title.trim() && src.template_title.trim() !== title) {
    lines.push(`Derived from vetted template: ${src.template_title.trim()}`);
  }
  lines.push('', `Sections (${src.sections.length}):`);
  src.sections.forEach((s, i) => {
    lines.push(`${i + 1}. [${s.type}] ${s.label.trim()}`);
    if (s.placeholder && s.placeholder.trim()) lines.push(`   Example: ${s.placeholder.trim()}`);
  });
  if (src.template_rationale && src.template_rationale.trim()) {
    lines.push('', `Rationale: ${src.template_rationale.trim()}`);
  }
  return { title, content: lines.join('\n') };
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns the key of the first participant answer that survives in `text`
 * (whole answer, or any SHINGLE_WORDS-word run of it), else null. Comparison
 * is case-, punctuation- and whitespace-insensitive.
 */
export function findParticipantContent(
  text: string,
  responses: Record<string, unknown> | null | undefined,
): { key: string } | null {
  if (!responses) return null;
  const haystack = ` ${normalize(text)} `;
  for (const [key, raw] of Object.entries(responses)) {
    if (typeof raw !== 'string') continue;
    const answer = normalize(raw);
    if (answer.length < MIN_ANSWER_CHARS) continue;
    if (haystack.includes(` ${answer} `)) return { key };
    const words = answer.split(' ');
    for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) {
      const shingle = words.slice(i, i + SHINGLE_WORDS).join(' ');
      if (haystack.includes(` ${shingle} `)) return { key };
    }
  }
  return null;
}
