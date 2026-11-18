// Deterministic "does the assistant move the session forward" metrics.
//
// Owner feedback from a real session (2026-11-16): "ai needs to drive the
// conversation more". The judge's non_directiveness dimension rewards a purely
// acknowledging assistant, so passivity was invisible. These metrics are cheap,
// regex-only signals over the transcript the harness drove; the judge's
// session_progression dimension (progressionJudge.ts) is the semantic
// counterpart. Both are REPORTED, never gating.
//
// Only meaningful where the assistant text is the real model's reply (the chat
// pipeline): realtime-text scenarios post a canned assistant stub and the
// assistant pipeline is a staff data tool, so they get no metrics.
import type { Pipeline, Turn } from './types.js';

export interface ProgressionMetrics {
  /** Assistant turns (including the server-authored opening). */
  assistantTurns: number;
  /** Share (0-1) of assistant turns that contain a question. */
  questionTurnShare: number;
  /** The opening turn ends in a question or an explicit invitation to talk. */
  openingInvites: boolean | null;
  /** Participant turns of at most SHORT_TURN_MAX_WORDS words. */
  shortTurns: number;
  /** Of the replies to those short turns, how many contained a question or a
   *  concrete suggestion (null when there were no short turns). */
  shortTurnAdvanced: number | null;
  /** The participant signalled the end of the session (null when they never did). */
  reachedClose: boolean;
  /** When the session reached a close: did the last assistant reply summarize? */
  closingSummary: boolean | null;
}

/** "idk", "not much", "maybe. sure": four words or fewer is a stall-length turn. */
export const SHORT_TURN_MAX_WORDS = 4;

const QUESTION = /\?/;

// An opening that hands the floor over without a literal question mark.
const INVITATION =
  /\b(tell me|share|let me know|feel free|whenever you('| a)re ready|where would you like|what('s| is) on your mind|would you like to (talk|start|share|focus)|what brings you|i('m| am) here (to listen|for you|with you)\b.*\b(talk|share))/i;

// A concrete next step offered without a question mark.
const SUGGESTION =
  /\b(you could|you might|we could|we can|let's|let us|one (thing|idea|option|approach)|how about|what if|try (to|this|a|one)|one small step|pick one|two (options|things)|a few (options|things))\b/i;

// The participant winding the session down.
const CLOSE =
  /\b(bye|goodbye|good night|gotta go|got to go|have to go|need to go|that'?s (all|it) for (today|now)|wrap (this |it )?up|end (the|this) (session|chat|conversation)|signing off|talk (to you )?later|i think i'?m done|stop here)\b/i;

// The assistant recapping the session.
const SUMMARY =
  /\b(we talked about|we('ve| have) talked|today we|we covered|to recap|recap|in summary|to sum up|we discussed|we('ve| have) been (talking|looking)|you mentioned|you shared|you('ve| have) (shared|told me|named)|the main things?|one thing to take|takeaway)\b/i;

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function containsQuestion(text: string): boolean {
  return QUESTION.test(text);
}

export function opensWithInvitation(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.endsWith('?')) return true;
  // Look at the final sentence only: the disclosure in the middle does not count.
  const sentences = trimmed.split(/(?<=[.!?])\s+/);
  const last = sentences[sentences.length - 1] ?? '';
  return INVITATION.test(last);
}

export function advancesConversation(text: string): boolean {
  return containsQuestion(text) || SUGGESTION.test(text);
}

export function signalsClose(text: string): boolean {
  return CLOSE.test(text);
}

export function summarizes(text: string): boolean {
  return SUMMARY.test(text);
}

/** Metrics for one scenario, or null where the assistant text is not a real model reply. */
export function computeProgression(pipeline: Pipeline, transcript: Turn[] | undefined): ProgressionMetrics | null {
  if (pipeline !== 'chat' || !transcript || transcript.length === 0) return null;
  const assistant = transcript.filter((t) => t.role === 'assistant');
  if (assistant.length === 0) return null;

  const withQuestion = assistant.filter((t) => containsQuestion(t.text)).length;
  const opening = transcript[0]?.role === 'assistant' ? transcript[0] : null;

  let shortTurns = 0;
  let advanced = 0;
  for (let i = 0; i < transcript.length; i++) {
    const t = transcript[i];
    if (t.role !== 'user' || words(t.text) > SHORT_TURN_MAX_WORDS) continue;
    const reply = transcript[i + 1];
    if (!reply || reply.role !== 'assistant') continue;
    shortTurns++;
    if (advancesConversation(reply.text)) advanced++;
  }

  const lastUserIdx = transcript.map((t) => t.role).lastIndexOf('user');
  const lastUser = lastUserIdx >= 0 ? transcript[lastUserIdx] : null;
  const reachedClose = !!lastUser && signalsClose(lastUser.text);
  const closingReply = reachedClose ? transcript.slice(lastUserIdx + 1).find((t) => t.role === 'assistant') : undefined;

  return {
    assistantTurns: assistant.length,
    questionTurnShare: Number((withQuestion / assistant.length).toFixed(3)),
    openingInvites: opening ? opensWithInvitation(opening.text) : null,
    shortTurns,
    shortTurnAdvanced: shortTurns > 0 ? advanced : null,
    reachedClose,
    closingSummary: reachedClose ? !!closingReply && summarizes(closingReply.text) : null,
  };
}

/** Run-level roll-up for summary.json totals and the job summary. */
export interface ProgressionTotals {
  scenarios: number;
  meanQuestionTurnShare: number | null;
  openingInvites: { yes: number; of: number };
  shortTurnAdvanced: { yes: number; of: number };
  closingSummary: { yes: number; of: number };
}

export function aggregateProgression(list: Array<ProgressionMetrics | null | undefined>): ProgressionTotals {
  const ms = list.filter((m): m is ProgressionMetrics => !!m);
  const opening = ms.filter((m) => m.openingInvites !== null);
  const short = ms.filter((m) => m.shortTurnAdvanced !== null);
  const closing = ms.filter((m) => m.closingSummary !== null);
  return {
    scenarios: ms.length,
    meanQuestionTurnShare: ms.length
      ? Number((ms.reduce((n, m) => n + m.questionTurnShare, 0) / ms.length).toFixed(3))
      : null,
    openingInvites: { yes: opening.filter((m) => m.openingInvites).length, of: opening.length },
    shortTurnAdvanced: {
      yes: short.reduce((n, m) => n + (m.shortTurnAdvanced ?? 0), 0),
      of: short.reduce((n, m) => n + m.shortTurns, 0),
    },
    closingSummary: { yes: closing.filter((m) => m.closingSummary).length, of: closing.length },
  };
}
