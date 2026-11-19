// Grading for the reply goldens: the deterministic phrase and regex checks
// first, then the yes/no questions through the harness's temperature-0
// classifier. No rubric scores and no LLM judge.
import { normalizeQuotes } from '../assertions.js';
import type { ClassifyFn } from '../types.js';
import type { ReplyRow, TextCheck } from './schema.js';

export interface CheckResult {
  kind: 'mustInclude' | 'mustNotInclude' | 'criterion' | 'sessionEnded';
  id: string;
  passed: boolean;
  detail: string;
}

export interface ReplyGrade {
  id: string;
  category: ReplyRow['category'];
  passed: boolean;
  deterministicPassed: boolean;
  checks: CheckResult[];
  reviewed: boolean;
  knownGap?: string;
}

/** Bump when the classifier framing below changes, so results stay comparable. */
export const REPLY_CRITERION_VERSION = 'golden-reply-v1';

function describeCheck(c: TextCheck): string {
  return c.phrase !== undefined ? `phrase "${c.phrase}"` : `regex /${c.regex}/i`;
}

export function textCheckMatches(c: TextCheck, reply: string): string | null {
  const text = normalizeQuotes(reply).replace(/\*\*/g, '');
  if (c.phrase !== undefined) {
    const at = text.toLowerCase().indexOf(normalizeQuotes(c.phrase).toLowerCase());
    return at >= 0 ? text.slice(at, at + c.phrase.length) : null;
  }
  const m = new RegExp(c.regex as string, 'i').exec(text);
  return m ? m[0] : null;
}

/** The deterministic half: phrases and regexes, plus the session-ended flag. */
export function gradeDeterministic(row: ReplyRow, reply: string, sessionEnded: boolean): CheckResult[] {
  const out: CheckResult[] = [];
  row.mustInclude.forEach((c, i) => {
    const hit = textCheckMatches(c, reply);
    out.push({
      kind: 'mustInclude',
      id: `include-${i + 1}`,
      passed: hit !== null,
      detail: `${describeCheck(c)} (${c.why}): ${hit !== null ? `found "${hit}"` : 'missing'}`,
    });
  });
  row.mustNotInclude.forEach((c, i) => {
    const hit = textCheckMatches(c, reply);
    out.push({
      kind: 'mustNotInclude',
      id: `exclude-${i + 1}`,
      passed: hit === null,
      detail: `${describeCheck(c)} (${c.why}): ${hit !== null ? `found "${hit}"` : 'absent'}`,
    });
  });
  const wantEnded = row.expectSessionEnded === true;
  out.push({
    kind: 'sessionEnded',
    id: 'session-ended',
    passed: sessionEnded === wantEnded,
    detail: `session ${sessionEnded ? 'ended' : 'stayed open'} (expected ${wantEnded ? 'ended' : 'open'})`,
  });
  return out;
}

/** What the classifier reads: the participant's turn, then the reply. */
export function criterionText(row: ReplyRow, reply: string): string {
  const prior = row.history
    .slice(-2)
    .map((t) => `${t.role === 'user' ? 'Participant' : 'Assistant'}: "${t.text}"`)
    .join('\n');
  return (
    `[Context: ${prior ? `earlier in the conversation:\n${prior}\nthen ` : ''}the participant said "${row.input}"]\n\n` +
    reply
  );
}

export async function gradeReply(
  row: ReplyRow,
  reply: string,
  sessionEnded: boolean,
  classify: ClassifyFn,
  opts: { votes?: number } = {},
): Promise<ReplyGrade> {
  const checks = gradeDeterministic(row, reply, sessionEnded);
  const deterministicPassed = checks.every((c) => c.passed);
  for (const crit of row.criteria) {
    const r = await classify({
      version: `${REPLY_CRITERION_VERSION}:${row.id}:${crit.id}`,
      question: crit.question,
      text: criterionText(row, reply),
      votes: opts.votes ?? 3,
    });
    const answered = r.verdict ? 'yes' : 'no';
    checks.push({
      kind: 'criterion',
      id: crit.id,
      passed: answered === crit.expect,
      detail: `${crit.question} -> ${answered} (expected ${crit.expect}). ${r.evidence}`.trim(),
    });
  }
  return {
    id: row.id,
    category: row.category,
    passed: checks.every((c) => c.passed),
    deterministicPassed,
    checks,
    reviewed: row.reviewedBy !== null,
    ...(row.knownGap ? { knownGap: row.knownGap } : {}),
  };
}
