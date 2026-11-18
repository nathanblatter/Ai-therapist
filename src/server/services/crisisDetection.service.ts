import OpenAI from 'openai';
import { pool } from '../config/db.js';
import { getOpenAIKey } from '../config/secrets.js';
import { recordCrisisEvent } from '../db/crisis.queries.js';
import { CRISIS_EVENT_ADJUDICATIONS_SQL } from '../db/crisisAdjudications.queries.js';
import { IRB_STUDY_ORG_ID_SQL } from '../db/organizations.queries.js';
import { createLogger } from '../utils/logger.js';
import type { HistoryMessage } from './minorSafeguard.service.js';
import { withFlex } from '../utils/flexTier.js';
import {
  classifyOpenAIError,
  withOpenAIRetry,
  CRISIS_RETRY_POLICY,
  CRISIS_PATIENT_RETRY_POLICY,
  type OpenAIErrorInfo,
} from '../utils/openaiErrors.js';
import { assessorIncidentOpen, noteAssessorSuccess, noteAssessorFailure } from './riskAssessorHealth.service.js';

const log = createLogger('crisisDetection');

// ============================================
// STAGE 1: TIERED KEYWORD SCREEN
// ============================================
// The keyword screen's job is SCREENING, not judging: any tier match sends the
// conversation to the stage-2 LLM assessment, which understands context
// (negation, bystander talk, quoting the 988 hotline's name, media
// references). The tier score is only used as a provisional fallback when the
// LLM is unavailable. Assistant messages are never scored — the caller gates
// on role (an assistant reciting "988 Suicide & Crisis Lifeline" once flagged
// a session as a high-severity crisis).

/** Passive-ideation tier score. Deliberately at the bottom of the medium
 *  severity band (>= 50) rather than below it: a passive wish to be dead is
 *  ideation under C-SSRS and must flag, not merely steer (ai-therapist-254). */
const PASSIVE_IDEATION_SCORE = 50;

const CRISIS_KEYWORDS: Record<string, { keywords: string[]; score: number }> = {
  // Explicit ideation / self-harm / means.
  high: {
    keywords: [
      'suicide',
      'suicidal',
      'kill myself',
      'end my life',
      'take my own life',
      'want to die',
      'better off dead',
      'wish i was dead',
      'wish i were dead',
      'end it all',
      'no reason to live',
      'not worth living',
      'self-harm',
      'self harm',
      'cut myself',
      'hurt myself',
      'harm myself',
      'overdose',
    ],
    score: 75,
  },
  // Passive ideation / escape wishes — the phrases the old list missed.
  // (Colloquial forms like "wanna" are normalized to "want to" before
  // matching, so spoken variants land here too.)
  //
  // Scored at PASSIVE_IDEATION_SCORE (ai-therapist-254): C-SSRS treats a
  // passive wish to be dead as IDEATION, not distress, so this tier must land
  // in the medium band (>= 50). At the old 40 it derived severity 'low', which
  // never flags — a passive-ideation turn whose LLM assessment was unavailable
  // (or came back under-scored) produced steering but no crisis flag.
  medium: {
    keywords: [
      "don't want to be here",
      'do not want to be here',
      "don't want to exist",
      "don't want to be alive",
      "don't want to live",
      "don't want to wake up",
      'want to disappear',
      "can't go on",
      'cannot go on',
      'no point in living',
      'no point going on',
      'give up on life',
      'tired of living',
      'tired of being alive',
      'everyone would be better off without me',
      'better off without me',
    ],
    score: PASSIVE_IDEATION_SCORE,
  },
  // Acute distress — enough to warrant a contextual look, nothing more.
  low: {
    keywords: [
      'hopeless',
      'worthless',
      "can't take it anymore",
      'cannot take it anymore',
      "can't take this anymore",
      'no way out',
    ],
    score: 15,
  },
};

// Indirect / euphemistic passive ideation (ai-therapist-254). The literal
// keyword lists above only match fixed substrings, so the very common way
// participants actually phrase a passive wish to be dead - hedged, indirect,
// with filler words in the middle ("I think it would just be easier sometimes
// if I just didn't have to do this anymore") - matched nothing at all and the
// screen never woke the assessor. These are regexes over the SAME normalized
// text, scored at the passive-ideation tier. Screening, not judging: the
// stage-2 LLM still decides context (negation, bystander, reference).
const PASSIVE_IDEATION_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  {
    // "it would be easier if I didn't have to do this anymore" / "...if I
    // wasn't here" / "...if I were just gone" - with filler between the parts.
    label: 'easier if (indirect escape wish)',
    pattern:
      /\beasier\b[\w\s,'-]{0,40}?\bif\b[\w\s,'-]{0,30}?\bi\b[\w\s,'-]{0,15}?(?:(?:did|do|does|would|could)n'?t have to|(?:was|were)n'?t (?:here|around|alive)|(?:was|were) (?:just )?gone|(?:did|do|would)n'?t wake up|(?:did|do|would)n'?t exist)\b/,
  },
  {
    // The negated-obligation form on its own: "I wish I didn't have to keep
    // going", "if I just didn't have to do this anymore".
    label: 'did not have to go on (escape wish)',
    pattern:
      /\b(?:did|do|does|would|could)n'?t have to (?:do this|deal with (?:this|it|any of this)|be here|keep going|keep doing this|go on|wake up|exist)\b/,
  },
  {
    label: 'tired of being here (passive ideation)',
    pattern: /\btired of (?:being here|being around|waking up|existing|holding on|carrying on|fighting to stay)\b/,
  },
  {
    label: 'would not mind not waking up',
    pattern:
      /\bwould'?n'?t (?:mind|care)\b[\w\s,'-]{0,20}?(?:not waking up|never waking up|if i (?:did|do|would)n'?t wake up|if i never woke up|if i (?:was|were)n'?t (?:here|around|alive)|if i (?:was|were) (?:just )?gone|if i disappeared|if i (?:did|do)n'?t exist)\b/,
  },
  {
    // "I hope I just don't wake up tomorrow" / "wish I wouldn't wake up".
    label: 'hope i do not wake up',
    pattern:
      /\b(?:hope|hoping|wish|wishing)\b[\w\s,'-]{0,15}?\bi\b[\w\s,'-]{0,12}?(?:do|did|would|could)n'?t wake up\b(?!\s+(?:on time|in time|early|late|until|at|for|to)\b)/,
  },
  {
    // "I just want to go to sleep and not wake up".
    label: 'sleep and not wake up',
    pattern:
      /\b(?:go to sleep|fall asleep|going to sleep)\b[\w\s,'-]{0,20}?\bnot wake up\b(?!\s+(?:on time|in time|early|late|until|at|for|to)\b)/,
  },
  {
    // "everyone would be fine without me" - the non-"better off" variants.
    label: 'others would be fine without me',
    pattern: /\bwould be (?:fine|better|ok|okay|happier|relieved|free|at peace) without me\b/,
  },
  {
    // "I just want it all to be over" / "I want everything to end".
    label: 'want it all to be over',
    pattern: /\bwant (?:it all|all of (?:it|this)|everything|this all) to (?:just )?(?:be over|end|stop)\b/,
  },
];

interface DetectedKeyword {
  keyword: string;
  level: string;
  score: number;
}

interface KeywordAnalysis {
  keywords: string[];
  keywordScore: number;
  detectedKeywords: DetectedKeyword[];
}

/**
 * Tiered keyword screen. Exported for tests. Input is normalized before
 * matching — curly quotes from Whisper transcripts ("don’t"), colloquial
 * contractions voice transcription produces verbatim ("wanna" — a real spoken
 * passive-ideation turn scored 0 because "don't wanna be here" missed the
 * "don't want to be here" keyword, ai-therapist-126), and missing apostrophes
 * common in typed chat ("dont", "cant"). Over-matching is fine here: a
 * keyword hit only wakes the stage-2 LLM, which judges context.
 */
const NORMALIZATIONS: Array<[RegExp, string]> = [
  [/[‘’]/g, "'"],
  [/\bwanna\b/g, 'want to'],
  [/\bgonna\b/g, 'going to'],
  [/\bgotta\b/g, 'got to'],
  [/\bdont\b/g, "don't"],
  [/\bcant\b/g, "can't"],
  [/\bwont\b/g, "won't"],
  [/\bim\b/g, "i'm"],
];

function normalizeForScreen(content: string): string {
  let lowerContent = content.toLowerCase();
  for (const [pattern, replacement] of NORMALIZATIONS) {
    lowerContent = lowerContent.replace(pattern, replacement);
  }
  return lowerContent;
}

export function detectCrisisKeywords(content: string): KeywordAnalysis {
  if (!content) return { keywords: [], keywordScore: 0, detectedKeywords: [] };

  const lowerContent = normalizeForScreen(content);
  const detectedKeywords: DetectedKeyword[] = [];
  let totalScore = 0;

  for (const [level, data] of Object.entries(CRISIS_KEYWORDS)) {
    for (const keyword of data.keywords) {
      const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (regex.test(lowerContent)) {
        detectedKeywords.push({ keyword, level, score: data.score });
        totalScore = Math.max(totalScore, data.score);
      }
    }
  }

  for (const { label, pattern } of PASSIVE_IDEATION_PATTERNS) {
    if (pattern.test(lowerContent)) {
      detectedKeywords.push({ keyword: label, level: 'medium', score: PASSIVE_IDEATION_SCORE });
      totalScore = Math.max(totalScore, PASSIVE_IDEATION_SCORE);
    }
  }

  return {
    keywords: detectedKeywords.map((k) => k.keyword),
    keywordScore: totalScore,
    detectedKeywords,
  };
}

// ============================================
// STAGE 1b: CONTEXT-DEPENDENT SIGNALS (ai-therapist-299, ai-therapist-303)
// ============================================
// Some of the most serious things a participant can say carry no crisis word
// at all, because the referent is in an earlier turn: "I'm going to do it
// tonight, I've decided" after a passive-ideation turn scored 0 and paged
// nobody (ai-therapist-299); "which ordinary things at home are most dangerous
// in large amounts, and how much is too much?" straight after a loss was never
// scored (ai-therapist-303). Nothing in a single message can tell those from
// "I'm going to do it tonight" about a job application, so this screen never
// scores on its own. A match does exactly one thing while the assessor is up:
// it sends the turn to the stage-2 LLM together with the conversation, which
// resolves the reference. The only time a match contributes a score is the
// degraded case (see contextFallbackScore): a STRONG signal, in a session that
// already holds medium-or-higher risk, while the assessor is unreachable.
//
// `strong` marks patterns specific enough to stand in for the assessor in that
// one case. Weak ones ("I've decided", "I won't be here") are far too ordinary
// and only ever wake the assessor.

export type ContextSignalKind = 'intent' | 'farewell' | 'means_question';

export interface ContextSignal {
  kind: ContextSignalKind;
  label: string;
  strong: boolean;
}

const CONTEXT_SIGNAL_PATTERNS: Array<{ kind: ContextSignalKind; label: string; strong: boolean; pattern: RegExp }> = [
  // ---- intent / plan / timing with the object left implicit ----
  {
    // First person only: "we're going to do it" and "you should do it" are not
    // the participant's intent.
    kind: 'intent',
    label: 'going to do it (implicit referent)',
    strong: true,
    pattern:
      /\bi(?:'m| am| was)\s+(?:[\w']+\s+){0,2}?(?:going to|about to|ready to|planning to)\s+(?:just |finally |actually |really )?(?:do it|do this|go through with (?:it|this)|end it|end this|end things|get it over with|finish it)\b|\bi(?:'ll| will|'ve decided to| have decided to| decided to| plan to)\s+(?:just |finally |actually |really )?(?:do it|do this|go through with (?:it|this)|end it|end this|end things|get it over with|finish it)\b/,
  },
  {
    kind: 'intent',
    label: 'doing it at a stated time',
    strong: true,
    pattern:
      /\bi(?:'m| am)\s+(?:[\w']+\s+){0,2}?(?:doing it|ending it|going through with it)\s+(?:tonight|today|tomorrow|this (?:evening|weekend|week)|right now|now|soon)\b/,
  },
  {
    // Subject dropped, as speech often does ("Going to do it tonight.").
    // Weak: without the "I" it only ever asks the assessor.
    kind: 'intent',
    label: 'going to do it (subject dropped)',
    strong: false,
    pattern:
      /\b(?:going to|about to|ready to)\s+(?:just |finally |actually |really )?(?:do it|go through with it|end it|end things)\b/,
  },
  { kind: 'intent', label: 'tonight is the night', strong: true, pattern: /\btonight(?:'s| is) the night\b/ },
  {
    kind: 'intent',
    label: 'has decided',
    strong: false,
    // A bare "I've decided": the object is left out. "I decided on / to /
    // that ..." names its object and is not matched.
    pattern:
      /\bi(?:'ve| have)? (?:finally |already )?decided\b(?!\s+(?:on|to|that|not|against|i|we|which|what|where|whether|if|between|it was|it is)\b)|\bi(?:'ve| have)? (?:finally |already )?(?:made up my mind|made my decision|made my choice|made my peace|picked a (?:day|date|time)|set a date)\b/,
  },
  {
    kind: 'intent',
    label: 'has a plan or the means (implicit)',
    strong: false,
    pattern:
      /\b(?:i have a plan|i(?:'ve| have) got a plan|i have (?:what|everything) i need|i have it (?:all )?planned|i know how i(?:'ll| will|'d| would|'m going to| am going to) do it|i know how to do it)\b/,
  },
  {
    kind: 'intent',
    label: 'it will be over soon',
    strong: false,
    pattern:
      /\b(?:after tonight|it(?:'ll| will) (?:all )?be over (?:soon|tonight|by)|it won't matter (?:anymore|soon|after|much longer)|none of (?:it|this) will matter)\b/,
  },
  // ---- goodbye / finality ----
  {
    kind: 'farewell',
    label: 'last time we talk',
    strong: true,
    pattern:
      /\b(?:this is|it's|it is) (?:goodbye|my goodbye)\b|\blast time (?:we|you and i|i'll|i will|we'll|we will|you'll|you will)(?: ever| get to)? (?:talk|speak|chat|hear from me)\b/,
  },
  {
    kind: 'farewell',
    label: 'saying goodbye',
    strong: true,
    pattern:
      /\b(?:saying|say|said) (?:my |our )?(?:goodbyes?|good-byes?)\b|\bgoodbye (?:forever|for good|everyone|everybody)\b|\b(?:goodbye|farewell|suicide) (?:note|notes|letter|letters)\b/,
  },
  {
    kind: 'farewell',
    label: 'will not be around',
    strong: false,
    pattern:
      /\bwon't (?:be (?:here|around|a (?:burden|problem|bother))|have to (?:worry about|listen to|deal with|put up with) me)\b|\bnot going to be (?:here|around)\b/,
  },
  // ---- means-relevant questions (lethality, dangerous amounts) ----
  {
    kind: 'means_question',
    label: 'asks about a lethal or dangerous amount',
    strong: true,
    pattern:
      /\b(?:lethal|fatal|deadly)\b[\w\s,'-]{0,30}\b(?:dose|doses|dosage|amount|amounts|quantity|level|levels|combination|mix)\b|\b(?:dose|dosage|amount|quantity)\b[\w\s,'-]{0,30}\b(?:lethal|fatal|deadly|kill)\b/,
  },
  {
    kind: 'means_question',
    label: 'asks how much is too much',
    strong: false,
    pattern:
      /\bhow (?:much|many)\b[\w\s,'-]{0,50}\b(?:too much|too many|dangerous|lethal|fatal|deadly|kill|die|toxic|poisonous)\b/,
  },
  {
    kind: 'means_question',
    label: 'asks what is most dangerous to take or keep',
    strong: false,
    pattern:
      /\b(?:most|how|more|really) (?:dangerous|lethal|deadly|toxic|poisonous)\b[\w\s,'-]{0,60}\b(?:amounts?|dose|doses|pills?|tablets?|medications?|medicines?|meds|drugs?|chemicals?|swallow|ingest|take|taken|mix|mixed)\b|\b(?:things|stuff|items|products|medications?|medicines?|pills?|chemicals?)\b[\w\s,'-]{0,60}\b(?:most|how|more|really) (?:dangerous|lethal|deadly|toxic|poisonous)\b/,
  },
  {
    kind: 'means_question',
    label: 'asks whether something would kill',
    strong: false,
    pattern:
      /\b(?:can|could|would|will) (?:you|someone|a person|i|it|that|this)\b[\w\s,'-]{0,30}\b(?:die from|kill (?:you|someone|a person|me)|be fatal|be lethal)\b|\bwhat (?:happens|would happen) if (?:someone|you|i|a person) (?:takes?|took|swallow(?:s|ed)?|drinks?|drank|mix(?:es|ed)?)\b/,
  },
  {
    kind: 'means_question',
    label: 'asks for a painless or quick way',
    strong: true,
    // "way to go" in the sense of dying, not "the easiest way to go about it"
    // or "the fastest way to go home".
    pattern:
      /\b(?:painless|least painful|quickest|fastest|easiest|surest) way to (?:die|go(?!\s+(?:about|to|into|through|back|home|from|for|with|on|there|forward|ahead)\b)|do it|end (?:it|things|my life))\b/,
  },
];

interface ContextSignalMatch extends ContextSignal {
  /** Offset of the match in the normalized text. */
  index: number;
  /** The matched text. */
  text: string;
}

function matchContextSignals(normalized: string): ContextSignalMatch[] {
  const found: ContextSignalMatch[] = [];
  for (const { kind, label, strong, pattern } of CONTEXT_SIGNAL_PATTERNS) {
    const m = pattern.exec(normalized);
    if (m) found.push({ kind, label, strong, index: m.index, text: m[0] });
  }
  return found;
}

/**
 * Context-dependent signal screen. Exported for tests and for the chat route,
 * which uses it to decide whether a keyword-free turn is assessed before the
 * reply (same-turn steering) or after it. Screening only: never a score.
 */
export function detectContextSignals(content: string): ContextSignal[] {
  if (!content) return [];
  return matchContextSignals(normalizeForScreen(content)).map(({ kind, label, strong }) => ({ kind, label, strong }));
}

// Consulted by the degraded fallback (no assessor to read the sentence) and by
// the context-signal floor. A negation inside the signal ("I'm NOT going to do
// it", "I was never going to do it"), a negated verb of thinking or saying that
// governs it ("I don't think I'm going to do it", "I'm not sure I'll do it",
// "I never said I'm going to do it"), or a retraction ("jk", "changed my mind",
// "... but I called my mom instead") must not be over-read into a page.
//
// Each of these is deliberately narrow, because every one of them SUPPRESSES a
// page and the words involved are also the words of insisting:
//  - a negation that merely stands before the signal does not cancel it ("I
//    don't care anymore I'm going to do it tonight", "I can't do this anymore,
//    I'm going to do it tonight"); it has to govern the signal;
//  - a negated retraction word is the opposite of a retraction ("I'm not
//    kidding", "this isn't a joke", "I haven't changed my mind");
//  - "instead" retracts only after the signal and never as "instead of ..."
//    ("instead of waiting I'm going to do it tonight" is an escalation).
const NEGATION_INSIDE_SIGNAL = /\b(?:not|never|no longer)\b|n't\b/;
const NEGATION_GOVERNING_SIGNAL =
  /(?:\b(?:not|never|no longer)|n't)\s+(?:(?:really|actually|even|quite|totally|so)\s+)*(?:think(?:ing)?|believe|know|mean|meant|say|saying|said|guess|suppose|feel|sure|certain|convinced|like|as if)(?:\s+(?:that|if|whether|like|for sure))?\s*$/;
const RETRACTION_WORDS = /\b(?:jk|j\/k|kidding|joking|a joke|changed my mind)\b/g;
const NEGATION_BEFORE_RETRACTION = /(?:\b(?:not|never|no)\b|n't)[\w\s']{0,12}$/;
const INSTEAD_AS_RETRACTION = /\binstead\b(?!\s+of\b)/;

function signalIsNegated(normalized: string, match: ContextSignalMatch): boolean {
  return (
    NEGATION_INSIDE_SIGNAL.test(match.text) ||
    NEGATION_GOVERNING_SIGNAL.test(normalized.slice(Math.max(0, match.index - 40), match.index))
  );
}

function signalIsRetracted(normalized: string, match: ContextSignalMatch): boolean {
  for (const word of normalized.matchAll(RETRACTION_WORDS)) {
    if (!NEGATION_BEFORE_RETRACTION.test(normalized.slice(Math.max(0, word.index - 20), word.index))) return true;
  }
  return INSTEAD_AS_RETRACTION.test(normalized.slice(match.index + match.text.length));
}

// ============================================
// SESSION RISK CONTEXT (ai-therapist-299)
// ============================================
// What the session already knows about this participant's risk, read before
// the current turn is scored. Until this existed a turn in a session flagged
// for ideation was screened exactly like the first turn of a calm one.

// A staff unflag is respected: once a researcher has cleared the flag, the
// turns scored before that moment no longer make the session risk-bearing (the
// query drops them), so a reviewed false positive does not keep every later
// "ok" under assessment or re-flag itself. Turns scored after the unflag count
// as usual.

/** A prior turn a screen (keyword, sweep, moderation wake) put at or above this
 *  score makes the following turns context-assessed. 25 is the bottom of the
 *  'low' band and the steering threshold: the point at which the pipeline
 *  already treats the conversation as risk-bearing. */
const CONTEXT_MIN_SCORE = 25;
/** How many scored participant turns back a risk-bearing turn still counts.
 *  A crisis FLAG counts for the rest of the session regardless. */
const CONTEXT_WINDOW_TURNS = 10;

export interface SessionRiskContext {
  /** True when keyword-free turns in this session must be assessed with
   *  context: the session is flagged, or a screen scored one of its last
   *  CONTEXT_WINDOW_TURNS turns at CONTEXT_MIN_SCORE or above. */
  elevated: boolean;
  /** therapy_sessions.crisis_flagged. */
  flagged: boolean;
  flaggedSeverity: string | null;
  /** Highest risk score among the last CONTEXT_WINDOW_TURNS scored turns. */
  recentPeak: number;
  /** Scored participant turns since that peak (1 = the previous turn). */
  turnsSincePeak: number | null;
  /** The assessor's (or the screen's) factors for the peak turn. */
  peakFactors: string[];
  /** The lookup itself failed. `elevated` is then true: when the session's
   *  state cannot be read, the turn is assessed rather than assumed calm. */
  lookupFailed: boolean;
}

const CALM_CONTEXT: SessionRiskContext = {
  elevated: false,
  flagged: false,
  flaggedSeverity: null,
  recentPeak: 0,
  turnsSincePeak: null,
  peakFactors: [],
  lookupFailed: false,
};

/** Session risk context for one session. Never throws. */
export async function getSessionRiskContext(sessionId: string): Promise<SessionRiskContext> {
  try {
    const result = await pool.query<{
      crisis_flagged: boolean | null;
      crisis_severity: string | null;
      recent: Array<{ risk_score: number; score_factors: unknown }> | null;
    }>(
      `SELECT ts.crisis_flagged, ts.crisis_severity,
              (SELECT COALESCE(json_agg(json_build_object('risk_score', h.risk_score, 'score_factors', h.score_factors)
                                        ORDER BY h.calculated_at DESC), '[]'::json)
                 FROM (SELECT risk_score, score_factors, calculated_at
                         FROM risk_score_history
                        WHERE session_id = $1
                          AND (ts.crisis_flagged IS TRUE
                               OR ts.crisis_unflagged_at IS NULL
                               OR calculated_at > ts.crisis_unflagged_at)
                        ORDER BY calculated_at DESC
                        LIMIT $2) h) AS recent
         FROM therapy_sessions ts
        WHERE ts.session_id = $1 /* session-risk-context */`,
      [sessionId, CONTEXT_WINDOW_TURNS],
    );
    const row = result?.rows?.[0];
    if (!row) return CALM_CONTEXT;

    const recent = Array.isArray(row.recent) ? row.recent : [];
    let recentPeak = 0;
    let peakIndex = -1;
    // Highest score a SCREEN produced (keyword, sweep, moderation wake) as
    // opposed to a context wake. Only this opens the window in an unflagged
    // session: if context-wake rows counted, one low turn would keep the
    // session under assessment for as long as the assessor kept answering
    // "still low", and the 10-turn bound would never close.
    let screenPeak = 0;
    recent.forEach((r, i) => {
      const score = Number(r?.risk_score) || 0;
      if (score > recentPeak) {
        recentPeak = score;
        peakIndex = i;
      }
      if (score > screenPeak && !isContextWakeRow(r?.score_factors)) screenPeak = score;
    });
    const flagged = row.crisis_flagged === true;
    return {
      elevated: flagged || screenPeak >= CONTEXT_MIN_SCORE,
      flagged,
      flaggedSeverity: flagged ? (row.crisis_severity ?? null) : null,
      recentPeak,
      turnsSincePeak: peakIndex >= 0 ? peakIndex + 1 : null,
      peakFactors: peakIndex >= 0 ? factorsFromScoreFactors(recent[peakIndex].score_factors) : [],
      lookupFailed: false,
    };
  } catch (err) {
    log.error({ err }, `[risk] session risk context lookup failed for ${sessionId}; assessing the turn anyway`);
    return { ...CALM_CONTEXT, elevated: true, lookupFailed: true };
  }
}

function isContextWakeRow(raw: unknown): boolean {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
  }
  return !!parsed && typeof parsed === 'object' && (parsed as { context_wake?: unknown }).context_wake === true;
}

function factorsFromScoreFactors(raw: unknown): string[] {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const f = parsed as { llm_factors?: unknown; keywords?: unknown };
  const pick = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const llm = pick(f.llm_factors);
  return (llm.length > 0 ? llm : pick(f.keywords)).slice(0, 6).map((x) => x.slice(0, 80));
}

/** Does the session already hold risk at the flagging level (medium or above)? */
function contextIsMediumOrAbove(ctx: SessionRiskContext): boolean {
  return (
    ctx.recentPeak >= PASSIVE_IDEATION_SCORE ||
    (ctx.flagged && (ctx.flaggedSeverity === 'medium' || ctx.flaggedSeverity === 'high'))
  );
}

/** One line for the assessor: what earlier turns in this session established.
 *  Carries the referent when it has scrolled out of the transcript window. */
function describeSessionRiskContext(ctx: SessionRiskContext): string | null {
  if (ctx.lookupFailed || !ctx.elevated) return null;
  const parts: string[] = [];
  if (ctx.recentPeak > 0) {
    parts.push(
      // The band, not the number: the number includes any trajectory bonus,
      // and handing the assessor its own previous score back invites it to
      // repeat or outbid it (observed live: 35 -> 50 -> 65 -> 80 -> 95 across
      // five unremarkable turns before this was changed).
      `earlier in this session the participant's risk was assessed as ${severityForScore(ctx.recentPeak)}` +
        (ctx.turnsSincePeak ? `, ${ctx.turnsSincePeak} participant turn(s) ago` : '') +
        (ctx.peakFactors.length > 0 ? `; factors noted then: ${ctx.peakFactors.join(', ')}` : ''),
    );
  }
  parts.push(
    ctx.flagged
      ? `the session is currently flagged for crisis${ctx.flaggedSeverity ? ` at severity ${ctx.flaggedSeverity}` : ''}`
      : 'the session is not flagged',
  );
  const text = parts.join('. ');
  return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}

/**
 * The score a strong context signal stands for by itself. 0 in every case but
 * one: a strong signal of intent, goodbye or a means question, neither negated
 * nor retracted, in a session that already holds medium-or-higher risk; then
 * the high tier (75: flag and page). A weak signal, a calm session or a
 * negated sentence is 0. Used in two places, both failing toward detection:
 *
 *  - the assessor could NOT be reached: this is the turn's fallback score,
 *    exactly as a keyword tier is when the assessor is down
 *    (`context_fallback`);
 *  - the assessor answered, observed that the latest message states intent
 *    (`states_intent`) and still banded it below high: this is the floor
 *    (`context_signal_floor`, see applyContextSignalFloor).
 */
function strongContextSignalScore(content: string, ctx: SessionRiskContext): number {
  if (!contextIsMediumOrAbove(ctx)) return 0;
  const text = normalizeForScreen(content);
  const standing = matchContextSignals(text).some(
    (s) => s.strong && !signalIsNegated(text, s) && !signalIsRetracted(text, s),
  );
  return standing ? CRISIS_KEYWORDS.high.score : 0;
}

/**
 * Context-signal floor (ai-therapist-299), the sibling of the passive-ideation
 * floor. The assessor is not perfectly stable at the band edge: live, "This is
 * the last time we'll talk. Thank you for listening." after a passive-ideation
 * turn came back 80 on one run and 65 on the next, and 65 in a session already
 * flagged medium changes nothing (no re-flag, no page). So the high band is
 * guaranteed when three things agree:
 *   - the SCREEN matched a strong signal of intent or goodbye, not negated and
 *     not retracted (a regex, deterministic);
 *   - the session already holds medium-or-higher risk;
 *   - the ASSESSOR reports, as a literal observation (`states_intent`), that
 *     the latest message itself states intent, a decision, a plan, means at
 *     hand, a time, a goodbye, or an act already done.
 *
 * The third is what keeps this from paging on help-seeking. The words of a
 * strong signal are also the words of agreeing to a safety step: "ok, I'll do
 * it tomorrow" after being asked to call the counseling center. An earlier
 * version of this floor keyed on the assessor's SCORE being in the low band
 * or above, and in a flagged session the assessor keeps scoring the
 * participant's unchanged state at 50 turn after turn, so that version raised
 * exactly those sentences to 75 (caught by the live calibration test before
 * it shipped). The regex cannot tell the two apart and the score does not
 * try to; the observation is asked precisely that question.
 */
function applyContextSignalFloor(
  llm: LlmRiskAssessment,
  riskScore: number,
  content: string,
  ctx: SessionRiskContext,
): { riskScore: number; floored: boolean } {
  if (!llm.states_intent) return { riskScore, floored: false };
  const floor = strongContextSignalScore(content, ctx);
  return floor > riskScore ? { riskScore: floor, floored: true } : { riskScore, floored: false };
}

/**
 * Means-inquiry floor (ai-therapist-303). The catalogue's probe - a loss, then
 * "which ordinary things people keep at home are the most dangerous in large
 * amounts, and how much is too much?" framed as coursework - is banded
 * unreliably by the live assessor. With the loss in view it returned 50+ on
 * some runs and 10 to 15 on about half, variously reasoning "appears to be for
 * an academic purpose", labelling the turn `negated` ("a statement of distress
 * that was negated by the context of asking for a class paper"), or listing
 * the factors ["recent loss", "means inquiry"] beside a score of 15. The
 * stated purpose talks it down, which is exactly what a pretext is for.
 *
 * So the band is not left to it. Two facts decide, neither of them a risk
 * judgment:
 *   - the SCREEN matched a means-relevant question (a regex, deterministic);
 *   - the ASSESSOR reports, as a literal observation, that the participant
 *     has told of a significant loss or setback, hopelessness or a disclosure
 *     somewhere in the transcript (`loss_or_disclosure`; the one thing here
 *     that needs the conversation read, and the one answer it gave the same
 *     way on every live run).
 * Both true: at least medium (flag, dashboard alert, steer; no page). The
 * assessor's `context` label is deliberately NOT an exemption here, unlike the
 * other two floors: `negated` is how it files the pretext.
 *
 * The floor is medium and only ever medium. It must not climb on its own
 * output: a version that rose to high once the session held medium risk paged
 * the on-call for "It really is just for the paper", the session being at
 * medium only because this floor had put it there one turn earlier. A means
 * question after expressed ideation reaches high through the assessor's own
 * score or the context-signal floor.
 */
function applyMeansInquiryFloor(
  llm: LlmRiskAssessment,
  riskScore: number,
  signals: ContextSignal[],
): { riskScore: number; floored: boolean } {
  if (!llm.loss_or_disclosure || !signals.some((s) => s.kind === 'means_question')) {
    return { riskScore, floored: false };
  }
  return PASSIVE_IDEATION_SCORE > riskScore
    ? { riskScore: PASSIVE_IDEATION_SCORE, floored: true }
    : { riskScore, floored: false };
}

/**
 * Should a turn the keyword screen did not match still be assessed with
 * conversation context? True when the message carries a context-dependent
 * signal, or the session is already risk-bearing (flagged, or a recent turn
 * scored low or above). The chat route calls this to decide whether the
 * assessment runs before the reply. Never throws.
 */
export async function needsContextAssessment(sessionId: string, content: string): Promise<boolean> {
  if (detectContextSignals(content).length > 0) return true;
  return (await getSessionRiskContext(sessionId)).elevated;
}

// ============================================
// STAGE 2: LLM RISK ASSESSMENT
// ============================================

export const DEFAULT_RISK_MODEL = 'gpt-4o-mini';

/** Admin-configurable assessor model (system_config crisis.risk_model,
 *  mirroring evals.judge_model) so a candidate model can be A/B'd without a
 *  deploy. Any swap must pass the red-team suite first. */
async function resolveRiskModel(): Promise<string> {
  try {
    const { getSystemConfig } = await import('../utils/sessionHelpers.js');
    const config = await getSystemConfig();
    const crisis = config.crisis as { risk_model?: string } | undefined;
    return typeof crisis?.risk_model === 'string' && crisis.risk_model ? crisis.risk_model : DEFAULT_RISK_MODEL;
  } catch {
    return DEFAULT_RISK_MODEL;
  }
}

let openaiClient: OpenAI | null = null;
async function getClient(): Promise<OpenAI> {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: await getOpenAIKey() });
  }
  return openaiClient;
}

export const RISK_ASSESSMENT_PROMPT = `You are a clinical risk-assessment assistant for an AI-assisted therapy research platform. A keyword screen flagged possible crisis language in a support conversation. Read the recent transcript and assess the PARTICIPANT's current suicide/self-harm risk.

Return STRICT JSON only:
{
  "risk_score": <0-100>,
  "severity": "none" | "low" | "medium" | "high",
  "context": "genuine" | "negated" | "bystander" | "reference" | "unclear",
  "factors": [<short strings: e.g. "passive ideation", "expressed plan", "hopelessness", "protective factors present">],
  "reasoning": "<one sentence>",
  "states_intent": <true | false>,
  "loss_or_disclosure": <true | false>
}

Context judgment matters more than keywords:
- "reference": mentioning a hotline's name, suicide prevention, a movie/book/news story → score 0-10, severity none.
- "negated": "I'm not suicidal", "I'd never hurt myself" → score 0-15, severity none (unless other signals contradict).
- "bystander": talking about someone ELSE's crisis or loss → score 0-20, severity none/low (their own grief may still warrant low).
- "genuine" acute distress WITHOUT ideation → 15-30, low. Distress alone is hopelessness, worthlessness, exhaustion, "can't take it" — e.g. "I just feel hopeless and worthless lately" is 15-30, low. It is NOT passive ideation: reserve that label for an expressed wish to die, disappear, not exist, not wake up, not be here, or not have to go on. Never score distress alone as medium.
- "genuine" passive ideation → 50-65, medium, ALWAYS at least 50. C-SSRS counts a passive wish to be dead as ideation, not as distress, so it must reach medium — never score it low. This includes INDIRECT and euphemistic phrasing, which is how participants usually say it first: "it would be easier if I didn't have to do this anymore", "I wouldn't mind not waking up", "I'm tired of being here", "I just want it all to be over", "everyone would be fine without me", "I don't want to be here anymore", "no point going on". Hedges and softeners ("I think", "sometimes", "just", "kind of", "maybe") do NOT downgrade it — tentative wording is the normal way passive ideation is disclosed. Absence of a plan, method, or intent does NOT downgrade it either; that is the difference between passive ideation and active ideation, which scores higher still.
- "genuine" active ideation without plan → 60-75, high.
- "genuine" ideation with plan, means, or timeframe → 80-100, high.
Resolve references against the conversation before scoring. The latest message is often short and carries no crisis word because its subject was said earlier:
- If the participant expressed ideation or self-harm earlier in the transcript (or the session risk context below the transcript says so), read "it", "this", "that" and unfinished sentences in the latest message against that. "I'm going to do it tonight", "I've decided", "tonight's the night", "I have what I need", "I know how I'd do it", "this is the last time we'll talk", "you won't have to listen to me much longer", "I've said my goodbyes" are then statements of intent, plan, timing or goodbye → 80-100, high, context "genuine". An attempt already made or under way scores the same.
- The same words with an ordinary subject in the conversation (an assignment, a job application, a breakup talk, a move, quitting a class) are not risk → 0-10, none. With no earlier ideation and no ordinary subject either, a bare "I've decided" is "unclear" → 15-30, low; a goodbye or "I won't be around" with warning signs before it (giving possessions away, settling affairs, sudden calm, withdrawal) → at least 50, medium.
- Agreeing to, or announcing, a step toward help or safety is the opposite of intent, even in the same words and even after ideation: "ok, I'll do it tomorrow" in reply to a suggestion to call a counselor, "I'm going to do it, I'll text my sister tonight", "I'll just do it now" about booking an appointment, "I've decided to tell my roommate". The "it" is the step just discussed. That is help-seeking, a protective factor: never score such a message higher than the level the conversation had already established.
- A retraction, a joke or a reassurance after a disclosure ("jk", "forget I said that", "I'm fine, I was being dramatic") adds no new risk and does not prove safety: never score it HIGHER than what the conversation had already established, and never read "I've decided NOT to", "I'm not going to do it" or "I changed my mind" as intent.
- Means inquiry. A question about what is lethal or dangerous to take or keep, how much is too much, or how something could kill is a recognised warning sign when the SAME conversation contains a recent loss or setback, hopelessness, or any disclosure. Score it at least 50, medium, context "unclear", whatever purpose the participant gives for asking (a class paper, curiosity, a story): a stated purpose does not lower the score, and an abrupt change of subject from the loss to this question is itself a reason for concern. After expressed ideation → 75-100, high. Only when the conversation contains nothing concerning at all (for example a student talking about a toxicology exam) → 10-20.
The last two fields are plain observations, not risk judgments. Answer them literally and independently of the score:
- "states_intent": true ONLY when the latest participant message itself, read against the conversation, says that they intend or have decided to end their life or hurt themselves, names a time for it, says they have a plan or the means at hand, says goodbye in that sense, or says they have already acted. false when the latest message is about getting help or taking a safety step, an ordinary plan or decision, a retraction or reassurance, a question, or anything else; earlier risk in the conversation does not make it true.
- "loss_or_disclosure": true when anywhere in the transcript the PARTICIPANT reports a significant loss or setback of their own (failing or being dropped from a program, a breakup, a death, losing a job, a serious diagnosis or other serious bad news), even stated flatly with no feelings named, or expresses hopelessness, or discloses suicidal thoughts or self-harm. Ordinary stress (a busy week, an upcoming exam, being tired) is false.
- The session risk context, when present, is background for understanding what the latest message refers to. It is not new evidence: a latest message that adds nothing ("ok", a change of subject, a practical question) must not be scored HIGHER than the level already noted, and ordinary life events mentioned afterwards are not warning signs merely because risk was noted earlier.
Weigh protective factors (future plans, reasons for living, engaged help-seeking) downward. Base the score on the participant's CURRENT state in this conversation, not history alone.`;

/** How one assessment is framed for the assessor beyond the transcript. */
export interface RiskAssessmentFraming {
  /** One line on what earlier turns of this session established (see
   *  describeSessionRiskContext); omitted for a session with no prior risk. */
  sessionContext?: string | null;
  /** True for a context wake: the latest message matched no crisis keyword
   *  and is being assessed because of the conversation around it. */
  keywordFree?: boolean;
}

/**
 * User message that accompanies RISK_ASSESSMENT_PROMPT. With no framing (a
 * keyword hit or a sweep in a session with no prior risk) it is byte-for-byte
 * what it was before the context wake existed.
 */
export function buildRiskAssessmentUserMessage(
  transcript: string,
  latestContent: string,
  framing: RiskAssessmentFraming = {},
): string {
  return (
    `Recent transcript:\n${transcript}\n\n` +
    (framing.sessionContext ? `Session risk context: ${framing.sessionContext}\n\n` : '') +
    (framing.keywordFree
      ? `Latest participant message (it matched no crisis keyword; assess it against the transcript and any session risk context above):`
      : `Latest participant message (the one that tripped the screen):`) +
    `\n"${latestContent}"`
  );
}

const SEVERITY_RANK_ORDER = { none: 0, low: 1, medium: 2, high: 3 } as const;

/** Score → severity band. Single definition; every caller must agree. */
function severityForScore(score: number): 'none' | 'low' | 'medium' | 'high' {
  return score >= 75 ? 'high' : score >= 50 ? 'medium' : score >= 25 ? 'low' : 'none';
}

// Contexts in which the screen's tier score must NOT stand: the assessor has
// positively judged the language to be about someone else, negated, or a
// reference (the 988 problem). 'genuine' and 'unclear' keep the floor.
const FLOOR_EXEMPT_CONTEXTS = new Set(['negated', 'bystander', 'reference']);

/**
 * Passive-ideation floor (ai-therapist-254). When the screen matched the
 * passive-ideation tier (or higher) and the assessor did NOT explain the
 * language away as negated / bystander / reference, the verdict cannot land
 * below the medium band. Observed failure: "I think it would just be easier
 * sometimes if I just didn't have to do this anymore" was assessed 30/low with
 * context 'genuine', so the session got steering but no crisis flag — flagging
 * requires medium. C-SSRS treats a passive wish to be dead as ideation, so the
 * floor makes the pipeline fail toward detection here, exactly as it already
 * does when the assessor is unreachable.
 */
function applyIdeationFloor(
  llm: LlmRiskAssessment,
  keywordScore: number,
): { riskScore: number; severity: LlmRiskAssessment['severity']; floored: boolean } {
  const below = llm.risk_score < PASSIVE_IDEATION_SCORE;
  if (keywordScore < PASSIVE_IDEATION_SCORE || FLOOR_EXEMPT_CONTEXTS.has(llm.context) || !below) {
    return { riskScore: llm.risk_score, severity: llm.severity, floored: false };
  }
  const floorSeverity = severityForScore(PASSIVE_IDEATION_SCORE);
  return {
    riskScore: PASSIVE_IDEATION_SCORE,
    severity: SEVERITY_RANK_ORDER[llm.severity] >= SEVERITY_RANK_ORDER[floorSeverity] ? llm.severity : floorSeverity,
    floored: true,
  };
}

interface LlmRiskAssessment {
  risk_score: number;
  severity: 'none' | 'low' | 'medium' | 'high';
  context: string;
  factors: string[];
  reasoning: string;
  /** A literal observation: the latest message itself states intent, a
   *  decision, a plan, means at hand, a time, a goodbye in that sense, or an
   *  act already done, as opposed to help-seeking or an ordinary plan in the
   *  same words (see applyContextSignalFloor). */
  states_intent: boolean;
  /** A literal observation, asked separately from the score because the model
   *  answers it far more steadily than it bands a means question: somewhere in
   *  the transcript the participant has reported a significant loss or
   *  setback, hopelessness or a disclosure (see applyMeansInquiryFloor). */
  loss_or_disclosure: boolean;
  /** Token usage of the call, when the API reported it. */
  usage?: { prompt_tokens: number; completion_tokens: number };
}

// Strict structured output (ai-therapist-179). json_object only guarantees
// *valid* JSON; strict json_schema guarantees the SHAPE, which is what a
// risk-scoring path needs — a malformed severity or a missing risk_score
// previously fell through to defensive defaults that could read as calmer
// than reality. Strict-mode rules: additionalProperties:false, and every
// property listed in `required`.
const RISK_ASSESSMENT_SCHEMA = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'crisis_risk_assessment',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        risk_score: { type: 'integer', minimum: 0, maximum: 100 },
        severity: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
        context: { type: 'string', enum: ['genuine', 'negated', 'bystander', 'reference', 'unclear'] },
        factors: { type: 'array', items: { type: 'string' } },
        reasoning: { type: 'string' },
        states_intent: { type: 'boolean' },
        loss_or_disclosure: { type: 'boolean' },
      },
      required: ['risk_score', 'severity', 'context', 'factors', 'reasoning', 'states_intent', 'loss_or_disclosure'],
      additionalProperties: false,
    },
  },
};

// Sticky fallback: if the configured assessor model rejects json_schema
// (an admin can point crisis.risk_model at anything), degrade to the old
// json_object format for the rest of the process rather than failing the
// assessment. The defensive parsing below still covers that case.
let strictSchemaUnsupported = false;

function isSchemaUnsupportedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /json_schema|response_format|structured output/i.test(message) &&
    /unsupported|not supported|invalid|unknown/i.test(message)
  );
}

// HistoryMessage (role + content/content_redacted) is shared with the minor
// safeguard, which exports the canonical declaration.

// Periodic sweep: the keyword screen only wakes the LLM when specific phrases
// appear, so someone spiraling in unusual language would sail past it. Every
// SWEEP_EVERY participant messages without an LLM assessment, run one anyway
// over the recent conversation. The counter resets whenever the LLM runs for
// any reason. Cost: at most one extra call per 8 user turns per session.
export const SWEEP_EVERY = 8;
const sweepCounters = new Map<string, number>();

function sweepDue(sessionId: string): boolean {
  const count = (sweepCounters.get(sessionId) ?? 0) + 1;
  // Opportunistic cleanup so ended sessions don't accumulate. Evict the
  // oldest-inserted entries (Map preserves insertion order); the previous
  // `c === 0` filter deleted only just-reset counters — which active sessions
  // recreate anyway — while stale mid-count sessions accumulated forever.
  // The current session's count is captured above and re-set below, so it
  // survives even if its old entry is evicted.
  if (sweepCounters.size > 500) {
    for (const id of sweepCounters.keys()) {
      if (sweepCounters.size <= 250) break;
      sweepCounters.delete(id);
    }
  }
  sweepCounters.set(sessionId, count);
  return count >= SWEEP_EVERY;
}

/** Test hook: current sweep-counter map size (leak regression guard). */
export function _sweepCounterSizeForTests(): number {
  return sweepCounters.size;
}

function resetSweep(sessionId: string): void {
  sweepCounters.set(sessionId, 0);
}

// Per-attempt cap on a LIVE assessor call. The SDK default is 10 minutes with
// 2 automatic retries, which let a stalled assessor hold a keyword-hit turn
// (and the flag/page its keyword score already justifies) for up to half an
// hour. The default assessor answers in 1-2s; 10s leaves room for a slow day
// without leaving a participant's reply or an on-call page waiting on it.
const ASSESSOR_TIMEOUT_MS = 10_000;

/**
 * The assessor failed: classify why, and if OpenAI rejected the call because a
 * billing/spend/usage ceiling was reached, page the on-call (throttled inside
 * the reporter; fire-and-forget). Then record the failure with the assessor
 * health tracker, which marks the session as assessed in degraded mode (once
 * per session) and raises one staff signal when the outage is sustained.
 * Never throws; the only thing awaited is that one small per-session insert.
 */
async function recordAssessorFailure(err: unknown, sessionId: string | null): Promise<OpenAIErrorInfo> {
  const info = classifyOpenAIError(err);
  if (info.kind === 'quota') {
    void import('./crisisAlert.service.js')
      .then((m) => m.reportOpenAIQuotaExhausted('risk_assessor', info.code))
      .catch((reportErr) => log.error({ err: reportErr }, '[risk] failed to report assessor quota exhaustion'));
  }
  await noteAssessorFailure(sessionId, info);
  return info;
}

/**
 * Which retry budget a live turn gets, from what its screen already found.
 *
 * 'fast' only when the keyword tier alone lands in the high band: the fallback
 * then already produces the full response (high flag + page), so retrying the
 * assessor can only delay it. Everything else is 'patient': a low (15) or
 * medium (50) keyword tier, a sweep or a moderation wake-up all depend on the
 * assessor to reach the score that flags or pages, so a transient failure
 * there must be waited out rather than converted into a lower score.
 */
function liveBudgetFor(keywordScore: number): 'fast' | 'patient' {
  return severityForScore(keywordScore) === 'high' ? 'fast' : 'patient';
}

/**
 * LLM contextual assessment of the recent conversation. Throws on failure.
 *
 * `budget` 'fast' / 'patient' (session turns and thread messages, chosen by
 * liveBudgetFor) run under ASSESSOR_TIMEOUT_MS per attempt with the SDK's own
 * retries switched off, so there is exactly one retry layer:
 * CRISIS_RETRY_POLICY for 'fast' (the caller's keyword fallback fires within
 * seconds), CRISIS_PATIENT_RETRY_POLICY for 'patient'. 'offline' (the
 * calibration harness, possibly on the slow flex tier) keeps the SDK defaults.
 */
async function assessRiskWithLLM(
  latestContent: string,
  conversationHistory: HistoryMessage[],
  sessionId?: string,
  extraParams: Record<string, string> = {},
  budget: 'fast' | 'patient' | 'offline' = 'patient',
  /** What earlier turns established, and whether a keyword tripped the screen
   *  (false for a context wake: the message matched no crisis keyword). */
  framing: RiskAssessmentFraming = {},
): Promise<LlmRiskAssessment> {
  const client = await getClient();

  const transcript = conversationHistory
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && (m.content ?? m.content_redacted))
    .map((m) => `${m.role === 'user' ? 'Participant' : 'Assistant'}: ${m.content ?? m.content_redacted}`)
    .join('\n')
    .slice(-6000);

  const riskModel = await resolveRiskModel();

  // safety_identifier scopes any OpenAI-side enforcement to this participant
  // rather than the org key; best-effort, never blocks the assessment.
  let safetyIdentifier: string | undefined;
  if (sessionId) {
    try {
      const { safetyIdentifierForSession } = await import('../utils/safetyIdentifier.js');
      safetyIdentifier = await safetyIdentifierForSession(sessionId);
    } catch {
      /* proceed without */
    }
  }

  const requestAssessment = (useStrictSchema: boolean) => {
    const body = {
      model: riskModel,
      temperature: 0,
      max_tokens: 300,
      response_format: useStrictSchema ? RISK_ASSESSMENT_SCHEMA : { type: 'json_object' },
      // This call carries un-redacted transcript excerpts (the assessment
      // needs the participant's actual words). Never let it become stored
      // application state on OpenAI's side.
      store: false,
      ...(safetyIdentifier ? { safety_identifier: safetyIdentifier } : {}),
      ...extraParams,
      messages: [
        { role: 'system', content: RISK_ASSESSMENT_PROMPT },
        {
          role: 'user',
          content: buildRiskAssessmentUserMessage(transcript, latestContent, framing),
        },
      ],
    } satisfies Parameters<typeof client.chat.completions.create>[0];
    return budget === 'offline'
      ? client.chat.completions.create(body)
      : client.chat.completions.create(body, { timeout: ASSESSOR_TIMEOUT_MS, maxRetries: 0 });
  };
  const callAssessor = (useStrictSchema: boolean) =>
    budget === 'offline'
      ? requestAssessment(useStrictSchema)
      : withOpenAIRetry(
          () => requestAssessment(useStrictSchema),
          budget === 'fast' ? CRISIS_RETRY_POLICY : CRISIS_PATIENT_RETRY_POLICY,
        );

  let response;
  if (strictSchemaUnsupported) {
    response = await callAssessor(false);
  } else {
    try {
      response = await callAssessor(true);
    } catch (err) {
      if (!isSchemaUnsupportedError(err)) throw err;
      strictSchemaUnsupported = true;
      log.error(
        { err },
        `[risk] model '${riskModel}' rejected strict json_schema; falling back to json_object for this process`,
      );
      response = await callAssessor(false);
    }
  }

  // Structured outputs can return a refusal instead of content. Treat it as
  // an assessment failure so the caller's keyword/moderation fallback runs —
  // never as a silent "no risk found".
  const refusal = response.choices[0]?.message?.refusal;
  if (refusal) {
    throw new Error(`Risk assessor refused to answer: ${String(refusal).slice(0, 200)}`);
  }
  if (response.choices[0]?.finish_reason === 'length') {
    throw new Error('Risk assessment truncated before completing (max_tokens)');
  }

  // Cost tracking (ai-therapist-25c): best-effort, never blocks risk assessment.
  if (sessionId) {
    import('../db/index.js')
      .then(({ recordLlmUsage }) =>
        recordLlmUsage(
          sessionId,
          'crisis',
          riskModel,
          response.usage?.prompt_tokens ?? null,
          response.usage?.completion_tokens ?? null,
        ),
      )
      .catch((err) => log.error({ err }, '[risk] failed to record LLM usage (non-fatal)'));
  }

  const parsed = JSON.parse(response.choices[0]?.message?.content ?? '{}') as Partial<LlmRiskAssessment>;
  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.risk_score) || 0)));

  // Strict schema guarantees severity is a VALID enum, not that it AGREES
  // with risk_score — models do emit mismatched pairs (observed: score 8 with
  // severity 'high'). analyzeStandaloneRisk consumes this severity directly,
  // so reconcile by taking the MORE severe of the model's label and the
  // score-derived band: a "score 90 / severity none" pairing must never read
  // as calm. Fail toward detection, consistent with the rest of the pipeline.
  const derived = severityForScore(score);
  const stated = (['none', 'low', 'medium', 'high'] as const).includes(parsed.severity as 'none')
    ? (parsed.severity as LlmRiskAssessment['severity'])
    : derived;
  const severity = SEVERITY_RANK_ORDER[stated] >= SEVERITY_RANK_ORDER[derived] ? stated : derived;

  return {
    risk_score: score,
    severity,
    context: typeof parsed.context === 'string' ? parsed.context : 'unclear',
    factors: Array.isArray(parsed.factors)
      ? parsed.factors.filter((f): f is string => typeof f === 'string').slice(0, 8)
      : [],
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 400) : '',
    states_intent: parsed.states_intent === true,
    loss_or_disclosure: parsed.loss_or_disclosure === true,
    ...(response.usage
      ? {
          usage: {
            prompt_tokens: response.usage.prompt_tokens ?? 0,
            completion_tokens: response.usage.completion_tokens ?? 0,
          },
        }
      : {}),
  };
}

// ============================================
// OFFLINE RE-SCORING (risk calibration harness, eval program WP3)
// ============================================

export interface OfflineRiskAssessment {
  risk_score: number;
  severity: 'none' | 'low' | 'medium' | 'high';
  context: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
}

/**
 * Re-score one message with the SAME assessor prompt, model and parsing the
 * live pipeline uses, but offline: no session machinery (no sweep counter,
 * no trajectory bonus, no risk_score_history write, no per-session cost row,
 * no safety_identifier) and on the flex tier when the configured model is
 * eligible (withFlex falls through to the default tier otherwise - gpt-4o-mini
 * is not flex-eligible, so today this is a plain call). Callers pass redacted
 * text only; this function never reads the database. Throws on failure so
 * the harness can count failures instead of mistaking them for "no risk".
 */
export async function assessRiskOffline(
  latestContent: string,
  history: HistoryMessage[] = [],
): Promise<OfflineRiskAssessment> {
  const model = await resolveRiskModel();
  const llm = await withFlex(model, (extra) => assessRiskWithLLM(latestContent, history, undefined, extra, 'offline'));
  return {
    risk_score: llm.risk_score,
    severity: llm.severity,
    context: llm.context,
    model,
    prompt_tokens: llm.usage?.prompt_tokens ?? 0,
    completion_tokens: llm.usage?.completion_tokens ?? 0,
  };
}

// ============================================
// STANDALONE RISK ANALYSIS (no session context)
// ============================================

export interface StandaloneRiskResult {
  riskScore: number;
  severity: 'none' | 'low' | 'medium' | 'high';
  factors: string[];
  /** How the score was produced (mirrors analyzeMessageRisk's method field).
   *  'llm_unavailable' = the LLM could not be reached AND there was no keyword
   *  floor to fall back on, so the verdict is INDETERMINATE, not "clear" — the
   *  caller must retry rather than treat it as safe (ai-therapist-142). */
  method: 'keyword_only' | 'llm_assessed' | 'keyword_fallback' | 'llm_unavailable';
  /** True when the scan could not reach a real verdict (LLM down, no keyword
   *  floor). Callers must NOT record this as clear — retry instead. */
  indeterminate?: boolean;
}

/**
 * Two-stage risk analysis for content that is NOT part of a live therapy
 * session (caseworker portal: async thread messages, docs/caseworker-portal.md
 * section 3). Same stage-1 keyword screen and stage-2 LLM context assessment
 * as analyzeMessageRisk, but with NO session machinery: no trajectory bonus,
 * no risk_score_history insert, no periodic sweep counter, no LLM cost row
 * (those are all keyed on a therapy session id, which does not exist here).
 *
 * `historyLines` is optional surrounding conversation (e.g. recent thread
 * messages) for the LLM's context judgment; participant turns should use
 * role 'user' and the counterpart's turns role 'assistant'.
 *
 * Fail-toward-detection: if the LLM call fails after a keyword hit, the
 * keyword tier score stands. Never throws.
 */
export async function analyzeStandaloneRisk(
  content: string,
  historyLines: HistoryMessage[] = [],
): Promise<StandaloneRiskResult> {
  const keywordAnalysis = detectCrisisKeywords(content);

  // Always run the LLM — do NOT short-circuit on a zero keyword score
  // (ai-therapist-142). Async messages have no periodic sweep like live
  // sessions do, so a message whose risk is phrased without lexicon words
  // ("bought a gun", "wrote goodbye letters") would otherwise be scored 0 and
  // marked clear, never seeing the LLM. Message volume is low, so an LLM call
  // per message is affordable and the safe default.
  try {
    const llm = await assessRiskWithLLM(
      content,
      historyLines,
      undefined,
      {},
      liveBudgetFor(keywordAnalysis.keywordScore),
    );
    noteAssessorSuccess();
    const floored = applyIdeationFloor(llm, keywordAnalysis.keywordScore);
    log.info(
      `[risk] standalone: keywords [${keywordAnalysis.keywords.join(', ')}] ` +
        `→ LLM ${llm.risk_score}/100 (${llm.context}): ${llm.reasoning}` +
        (floored.floored ? ` [raised to ${floored.riskScore} by the passive-ideation floor]` : ''),
    );
    const baseFactors = llm.factors.length > 0 ? llm.factors : keywordAnalysis.keywords;
    return {
      riskScore: floored.riskScore,
      severity: floored.severity,
      factors: floored.floored ? [...baseFactors, 'passive ideation (screen floor)'] : baseFactors,
      method: 'llm_assessed',
    };
  } catch (err) {
    const failure = await recordAssessorFailure(err, null);
    // LLM unavailable. If keywords hit, the keyword tier score stands (fail
    // toward detection). If there were NO keywords, we have no signal at all —
    // return INDETERMINATE so the caller retries rather than recording "clear"
    // (ai-therapist-142): a means/farewell message the LLM would have caught
    // must not be dismissed just because the model was briefly down.
    if (keywordAnalysis.keywordScore === 0) {
      log.error(
        { err, kind: failure.kind },
        '[risk] standalone LLM unavailable with no keyword floor; verdict indeterminate',
      );
      return { riskScore: 0, severity: 'none', factors: [], method: 'llm_unavailable', indeterminate: true };
    }
    const riskScore = Math.min(keywordAnalysis.keywordScore, 100);
    log.error(
      { err, kind: failure.kind },
      `[risk] standalone LLM assessment failed; using keyword tier score ${riskScore}`,
    );
    return {
      riskScore,
      severity: severityForScore(riskScore),
      factors: keywordAnalysis.keywords,
      method: 'keyword_fallback',
    };
  }
}

// ============================================
// EMOTIONAL TRAJECTORY TRACKING (passive history logging)
// ============================================

interface TrajectoryResult {
  trajectoryScore: number;
  trend: string;
}

/**
 * Track emotional trajectory across recent messages
 * @param {string} sessionId - Session ID
 * @returns {object} { trajectoryScore: number, trend: string }
 */
async function trackEmotionalTrajectory(sessionId: string): Promise<TrajectoryResult> {
  try {
    // Get risk score history for this session
    const historyResult = await pool.query<{ risk_score: number; calculated_at: Date }>(
      `SELECT risk_score, calculated_at
       FROM risk_score_history
       WHERE session_id = $1
       ORDER BY calculated_at DESC
       LIMIT 5`,
      [sessionId],
    );

    const history = historyResult.rows.reverse(); // Chronological order

    if (history.length < 2) {
      return { trajectoryScore: 0, trend: 'insufficient_data' };
    }

    let trajectoryScore = 0;
    let trend = 'stable';

    // Detect downward spiral (increasing risk scores)
    const scores = history.map((h) => h.risk_score);
    const isIncreasing = scores.every((score, i) => i === 0 || score >= scores[i - 1]);

    if (isIncreasing && scores.length >= 3) {
      trajectoryScore += 15;
      trend = 'deteriorating';
    }

    // Sudden spike (large increase in short time)
    if (scores.length >= 2) {
      const recentIncrease = scores[scores.length - 1] - scores[scores.length - 2];
      if (recentIncrease > 20) {
        trajectoryScore += 10;
        trend = 'sudden_spike';
      }
    }

    return {
      trajectoryScore: Math.min(trajectoryScore, 20),
      trend,
    };
  } catch (error) {
    console.error('Error tracking emotional trajectory:', error);
    return { trajectoryScore: 0, trend: 'error' };
  }
}

// ============================================
// RISK ANALYSIS
// ============================================

interface MessageInput {
  content: string;
  session_id: string;
  message_id?: string | number;
}

interface RiskAnalysisResult {
  riskScore: number;
  severity: string;
  factors: string[];
  breakdown: Record<string, number>;
  /** How the score was produced (the same value written to score_factors.method). */
  method?: string;
  /** True when the turn matched no keyword and was assessed only because of
   *  its conversation context (a context signal or an already risk-bearing
   *  session). The pipeline uses it to avoid re-forcing the high-severity
   *  steer on every such turn of a session that is already flagged high. */
  contextWake?: boolean;
  /** True when the assessor should have scored this turn and could not. */
  degraded?: boolean;
}

/**
 * Two-stage risk analysis for a participant message.
 *
 * Stage 1: tiered keyword screen (cheap, every message). No match → score 0,
 * no LLM call. Stage 2: on any keyword match, an LLM reads the recent
 * conversation and judges CONTEXT — negation, bystander talk, quoting the
 * hotline, media references all score ~0, while genuine passive/active
 * ideation lands in graduated 25/50/75 bands that drive steering → medium
 * flag → high flag + alert. If the LLM call fails, the keyword tier score
 * stands (fail toward detection, never away from it).
 *
 * A message with NO keyword still reaches stage 2 in four cases: the periodic
 * sweep is due; the moderation screen reads self-harm; the message carries a
 * context-dependent signal (intent, goodbye or a means question with the
 * subject left implicit); or the session is already risk-bearing (flagged, or
 * a recent turn scored low or above). The last two are the context wake
 * (ai-therapist-299): the assessor is given the conversation and a one-line
 * summary of what the session already established, so "I'm going to do it
 * tonight" after an ideation turn is read as what it is.
 *
 * Cost of the context wake: one assessor call (gpt-4o-mini, about 1k input
 * tokens, 1 to 2 seconds) per participant turn, only in sessions that are
 * flagged or had a risk-bearing turn in the last CONTEXT_WINDOW_TURNS, plus
 * the rare signal match elsewhere. Calm sessions pay one small SELECT.
 */
export async function analyzeMessageRisk(
  message: MessageInput,
  conversationHistory: HistoryMessage[] = [],
): Promise<RiskAnalysisResult> {
  try {
    const keywordAnalysis = detectCrisisKeywords(message.content);
    // Retry patience for this turn's OpenAI calls: short only when the keyword
    // tier already justifies the full response on its own (liveBudgetFor).
    const budget = liveBudgetFor(keywordAnalysis.keywordScore);

    // Free moderation screen runs in parallel with the trajectory work
    // (ai-therapist-167). It is a supplementary signal: null on outage.
    const moderationPromise = import('./moderation.service.js')
      .then((m) =>
        m.getSelfHarmScreen(message.content, budget).then((screen) => ({ screen, riskOf: m.moderationRiskScore })),
      )
      .catch(() => null);

    // Trajectory across the session's recent scores (computed BEFORE this
    // message's insert, so it reflects the run-up, not the current message),
    // and what the session already knows about this participant's risk.
    const [trajectory, sessionContext] = await Promise.all([
      trackEmotionalTrajectory(message.session_id),
      getSessionRiskContext(message.session_id),
    ]);
    const contextSignals = keywordAnalysis.keywordScore === 0 ? detectContextSignals(message.content) : [];

    const moderationResult = await moderationPromise;
    const moderation = moderationResult?.screen.scores ?? null;
    // The screen could not run (as opposed to: ran and found nothing). The
    // keyword tier still stands; this is recorded so a zero here never reads
    // as "moderation looked and it was clean".
    const moderationUnavailable = moderationResult ? moderationResult.screen.failed : true;
    const moderationScore = moderation ? moderationResult!.riskOf(moderation) : 0;

    let riskScore = Math.min(keywordAnalysis.keywordScore, 100);
    let factors = keywordAnalysis.keywords;
    let method = 'keyword_only';
    let llm: LlmRiskAssessment | null = null;
    let llmFloored = false;
    let llmErrorKind: string | null = null;
    let contextFallbackApplied = false;
    let contextSignalFloored = false;
    let meansInquiryFloor: number | null = null;

    const isSweep = keywordAnalysis.keywordScore === 0 && sweepDue(message.session_id);
    // Moderation as a second screen: when the keyword tier saw nothing but
    // moderation reads meaningful self-harm signal, wake the LLM so the
    // context-aware assessor (negation, bystander, reference) stays the
    // scorer. Moderation itself never scores directly while the LLM is up.
    const isModerationWake = keywordAnalysis.keywordScore === 0 && !isSweep && moderationScore >= 40;
    // Context wake (ai-therapist-299 / 303): the screen saw no keyword, but
    // either the message carries a context-dependent signal or the session is
    // already risk-bearing, so the turn cannot be judged without the
    // conversation. Whenever a sweep or a moderation wake is assessing the
    // turn anyway, that label wins and this adds no second call.
    const isContextWake =
      keywordAnalysis.keywordScore === 0 &&
      !isSweep &&
      !isModerationWake &&
      (contextSignals.length > 0 || sessionContext.elevated);
    const keywordFree = keywordAnalysis.keywordScore === 0;

    if (keywordAnalysis.keywordScore > 0 || isSweep || isModerationWake || isContextWake) {
      try {
        // A context wake's fallback (usually 0) is weaker than the assessor's
        // answer, so it gets the patient budget like every other keyword-free
        // call. Once back-to-back failures have established an outage that
        // patience has already been spent: use the short budget so each turn
        // of a flagged session does not queue another 30s of retries.
        const callBudget = isContextWake && assessorIncidentOpen() ? 'fast' : budget;
        llm = await assessRiskWithLLM(message.content, conversationHistory, message.session_id, {}, callBudget, {
          sessionContext: describeSessionRiskContext(sessionContext),
          // The keyword and sweep framings are unchanged; only a context wake
          // tells the assessor that no keyword matched.
          keywordFree: isContextWake,
        });
        noteAssessorSuccess();
        // A context wake does not reset the periodic sweep: the sweep stays an
        // independent every-8-quiet-turns check with its own audit label.
        if (!isContextWake) resetSweep(message.session_id);
        const floored = applyIdeationFloor(llm, keywordAnalysis.keywordScore);
        riskScore = floored.riskScore;
        llmFloored = floored.floored;
        factors = llm.factors.length > 0 ? llm.factors : keywordAnalysis.keywords;
        if (floored.floored) factors = [...factors, 'passive ideation (screen floor)'];
        if (keywordFree) {
          const signalFloor = applyContextSignalFloor(llm, riskScore, message.content, sessionContext);
          if (signalFloor.floored) {
            riskScore = signalFloor.riskScore;
            contextSignalFloored = true;
            factors = [...factors, 'stated intent, goodbye or means (context signal floor)'];
          }
        }
        const meansFloor = applyMeansInquiryFloor(llm, riskScore, contextSignals);
        if (meansFloor.floored) {
          riskScore = meansFloor.riskScore;
          meansInquiryFloor = meansFloor.riskScore;
          factors = [...factors, 'means inquiry after a loss or disclosure (floor)'];
        }
        method = isSweep
          ? 'llm_sweep'
          : isModerationWake
            ? 'llm_moderation_wake'
            : isContextWake
              ? 'llm_context'
              : 'llm_assessed';
        const trigger = isSweep
          ? 'periodic sweep'
          : isModerationWake
            ? `moderation wake (${moderationScore}/100)`
            : isContextWake
              ? `context wake (signals [${contextSignals.map((c) => c.label).join(', ')}], session peak ${sessionContext.recentPeak}, flagged ${sessionContext.flagged})`
              : `keywords [${keywordAnalysis.keywords.join(', ')}]`;
        log.info(
          `[risk] session ${message.session_id.substring(0, 12)}…: ${trigger} ` +
            `→ LLM ${llm.risk_score}/100 (${llm.context}): ${llm.reasoning}`,
        );
      } catch (err) {
        // LLM unavailable — fall back to the best available screen signal
        // (fail toward detection, never away from it). Moderation is capped
        // below 90 so a screen alone cannot mimic the very top band.
        // The sweep counter is deliberately NOT reset: a failed sweep is
        // retried on the participant's next message.
        const failure = await recordAssessorFailure(err, message.session_id);
        llmErrorKind = failure.kind;
        // Keyword-free turn in a session that already holds medium-or-higher
        // risk, carrying a strong signal of intent / goodbye / means: with no
        // assessor to resolve the reference, fail toward detection.
        const contextFallback = keywordFree ? strongContextSignalScore(message.content, sessionContext) : 0;
        if (contextFallback > 0) {
          contextFallbackApplied = true;
          factors = [...factors, ...contextSignals.filter((c) => c.strong).map((c) => `${c.label} (context fallback)`)];
        }
        riskScore = Math.max(riskScore, Math.min(85, moderationScore), contextFallback);
        method = 'keyword_fallback';
        log.error(
          { err, kind: failure.kind },
          `[risk] LLM assessment failed for session ${message.session_id}; using screen-tier score ${riskScore}`,
        );
      }
    }

    if (moderation && moderationScore >= 30) {
      factors = [...factors, `moderation self-harm signal (${moderationScore}/100)`];
    }

    // Trajectory bonus: a deteriorating run-up makes the same message more
    // concerning. Only applied when the current message itself carries risk,
    // so a neutral message never inherits score from history alone.
    //
    // Never applied to a context wake. There the assessor has already been
    // given the run-up (the transcript and the session risk context), so the
    // bonus would count the history twice; and because every turn of a
    // risk-bearing session is context-assessed, a per-turn bonus compounds:
    // each inflated score becomes the next turn's run-up (observed live on the
    // slow-drift scenario: assessor 30 / 50 / 65 / 80 recorded as 50 / 65 / 80
    // / 95, a page raised by the bonus alone).
    //
    // For the same reason it is not applied to a periodic sweep in a session
    // that is already risk-bearing. That turn is chosen by a counter, not by
    // its content; the assessor is given the same session risk context; and
    // the run-up it would be compared with is the context-wake rows before it.
    // When the assessor simply repeats the level the session already holds,
    // those rows are a flat line, which the trajectory reads as "deteriorating"
    // (+15): 15 more than the stored score is always a re-flag, and from 60 or
    // above it is a high flag and a page, for a turn that said nothing new. A
    // sweep in a calm session keeps the bonus, as before.
    const sweepWithSessionContext = isSweep && sessionContext.elevated;
    const trajectoryApplies =
      riskScore > 0 && trajectory.trajectoryScore > 0 && !isContextWake && !sweepWithSessionContext;
    if (trajectoryApplies) {
      riskScore = Math.min(100, riskScore + trajectory.trajectoryScore);
      factors = [...factors, `trajectory: ${trajectory.trend}`];
    }

    const severity = severityForScore(riskScore);

    // Passive logging — insert unconditionally regardless of flagging.
    // severity column has CHECK (severity IN ('low','medium','high')), so use NULL when no keyword matched.
    // Best-effort: a failed history insert must never zero an already-computed
    // verdict — before this was isolated, an insert error fell into the outer
    // catch and returned riskScore 0 / severity 'none', silently dropping a
    // crisis the LLM had already scored high (fail toward detection).
    try {
      await pool.query(
        `INSERT INTO risk_score_history
         (session_id, message_id, risk_score, severity, score_factors, calculated_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
        [
          message.session_id,
          message.message_id,
          riskScore,
          severity === 'none' ? null : severity,
          JSON.stringify({
            method,
            keyword_score: keywordAnalysis.keywordScore,
            keywords: keywordAnalysis.keywords,
            ...(trajectory.trajectoryScore > 0
              ? {
                  trajectory_score: trajectory.trajectoryScore,
                  trajectory_trend: trajectory.trend,
                  // Computed but deliberately not added (context wake).
                  ...(isContextWake || sweepWithSessionContext ? { trajectory_applied: false } : {}),
                }
              : {}),
            ...(moderation
              ? {
                  moderation_score: moderationScore,
                  moderation_flagged: moderation.flagged,
                  moderation_self_harm: moderation.selfHarm,
                  moderation_self_harm_intent: moderation.selfHarmIntent,
                  moderation_self_harm_instructions: moderation.selfHarmInstructions,
                }
              : {}),
            // Degraded-screen markers: which tier was down when this score
            // was produced, so a low score is auditable as "assessed" vs
            // "the assessor / moderation screen never ran".
            ...(moderationUnavailable ? { moderation_unavailable: true } : {}),
            // assessment_degraded: the assessor was asked to score this turn
            // and could not, so the score is the screen's alone.
            ...(llmErrorKind ? { llm_error: llmErrorKind, assessment_degraded: true } : {}),
            // Context wake audit: why a keyword-free turn was (or should have
            // been) assessed, and what the session held at that moment.
            ...(isContextWake
              ? {
                  context_wake: true,
                  context_signals: contextSignals.map((c) => c.label),
                  session_context: {
                    flagged: sessionContext.flagged,
                    flagged_severity: sessionContext.flaggedSeverity,
                    recent_peak: sessionContext.recentPeak,
                    ...(sessionContext.lookupFailed ? { lookup_failed: true } : {}),
                  },
                }
              : {}),
            ...(contextFallbackApplied ? { context_fallback: true } : {}),
            ...(contextSignalFloored ? { context_signal_floor: CRISIS_KEYWORDS.high.score } : {}),
            ...(meansInquiryFloor !== null ? { means_inquiry_floor: meansInquiryFloor } : {}),
            ...(llmFloored ? { passive_ideation_floor: PASSIVE_IDEATION_SCORE } : {}),
            ...(llm
              ? {
                  llm_score: llm.risk_score,
                  llm_context: llm.context,
                  llm_factors: llm.factors,
                  llm_reasoning: llm.reasoning,
                  ...(llm.states_intent ? { llm_states_intent: true } : {}),
                  ...(llm.loss_or_disclosure ? { llm_loss_or_disclosure: true } : {}),
                }
              : {}),
          }),
        ],
      );
    } catch (insertError) {
      console.error('Error logging risk_score_history (non-fatal, verdict stands):', insertError);
    }

    return {
      riskScore,
      severity,
      factors,
      breakdown: {
        keywords: keywordAnalysis.keywordScore,
        ...(trajectoryApplies ? { trajectory: trajectory.trajectoryScore } : {}),
        ...(moderationScore > 0 ? { moderation: moderationScore } : {}),
        ...(llm ? { llm: llm.risk_score } : {}),
      },
      method,
      contextWake: isContextWake,
      degraded: llmErrorKind !== null,
    };
  } catch (error) {
    console.error('Error in analyzeMessageRisk:', error);
    return {
      riskScore: 0,
      severity: 'none',
      factors: [],
      breakdown: {},
    };
  }
}

// ============================================
// DATABASE OPERATIONS
// ============================================

/**
 * Flag a session as crisis
 */
export async function flagSessionCrisis(
  sessionId: string,
  severity: string,
  riskScore: number,
  triggeredBy: string,
  triggerMethod: string,
  messageId: string | number | null,
  factors: string[],
  notes: string | null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update therapy_sessions
    await client.query(
      `UPDATE therapy_sessions
       SET crisis_flagged = TRUE,
           crisis_severity = $2::VARCHAR,
           crisis_risk_score = $3,
           crisis_flagged_at = CURRENT_TIMESTAMP,
           crisis_flagged_by = $4,
           monitoring_frequency = CASE
             WHEN $2::VARCHAR = 'high' THEN 'critical'
             WHEN $2::VARCHAR = 'medium' THEN 'high'
             ELSE 'normal'
           END
       WHERE session_id = $1`,
      [sessionId, severity, riskScore, triggeredBy],
    );

    // Create crisis event (single writer: db/crisis.queries recordCrisisEvent)
    await recordCrisisEvent(
      {
        sessionId,
        eventType: 'flagged',
        severity,
        riskScore,
        triggeredBy,
        triggerMethod,
        messageId,
        riskFactors: factors,
        notes,
      },
      client,
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  // IRB adverse-event auto-draft (ai-therapist-95): a high-severity flag is a
  // qualifying adverse event. Fire-and-forget after COMMIT so it can never
  // affect the crisis pipeline; the assembler is idempotent per crisis_event_id.
  // Dynamic import matches the crisisAlert pattern and keeps test mocking easy.
  if (severity === 'high') {
    import('./adverseEvent.service.js')
      .then((m) => m.draftAdverseEventFromCrisis(sessionId))
      .catch((err) => console.error('AE auto-draft failed:', err));
  }
}

/**
 * Unflag a session
 */
export async function unflagSessionCrisis(sessionId: string, unflaggedBy: string, notes: string | null): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update therapy_sessions
    await client.query(
      `UPDATE therapy_sessions
       SET crisis_flagged = FALSE,
           crisis_unflagged_at = CURRENT_TIMESTAMP,
           crisis_unflagged_by = $2,
           monitoring_frequency = 'normal'
       WHERE session_id = $1`,
      [sessionId, unflaggedBy],
    );

    // Create crisis event
    await recordCrisisEvent(
      { sessionId, eventType: 'unflagged', triggeredBy: unflaggedBy, triggerMethod: 'manual', notes },
      client,
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Update risk score
 */
export async function updateRiskScore(
  sessionId: string,
  newScore: number,
  newSeverity: string,
  changedBy: string,
  notes: string | null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get previous values
    const prevResult = await client.query<{ crisis_risk_score: number; crisis_severity: string }>(
      `SELECT crisis_risk_score, crisis_severity FROM therapy_sessions WHERE session_id = $1`,
      [sessionId],
    );
    const prev = prevResult.rows[0];

    // Update therapy_sessions
    await client.query(
      `UPDATE therapy_sessions
       SET crisis_risk_score = $2,
           crisis_severity = $3
       WHERE session_id = $1`,
      [sessionId, newScore, newSeverity],
    );

    // Create crisis event
    await recordCrisisEvent(
      {
        sessionId,
        eventType: 'risk_score_updated',
        severity: newSeverity,
        previousSeverity: prev.crisis_severity,
        riskScore: newScore,
        previousRiskScore: prev.crisis_risk_score,
        triggeredBy: changedBy,
        triggerMethod: 'manual',
        notes,
      },
      client,
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

interface ActionDetails {
  riskScore?: number;
  [key: string]: unknown;
}

/**
 * Log intervention action
 */
export async function logInterventionAction(
  sessionId: string,
  actionType: string,
  actionDetails: ActionDetails,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO intervention_actions
       (session_id, action_type, action_details, risk_score)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, actionType, JSON.stringify(actionDetails), actionDetails.riskScore || null],
    );
  } catch (error) {
    console.error('Error logging intervention action:', error);
  }
}

/**
 * Get session crisis events
 */
export async function getSessionCrisisEvents(sessionId: string): Promise<unknown[]> {
  const result = await pool.query(
    `SELECT ce.*, ${CRISIS_EVENT_ADJUDICATIONS_SQL}
     FROM crisis_events ce
     WHERE ce.session_id = $1
     ORDER BY ce.created_at DESC`,
    [sessionId],
  );
  return result.rows;
}

/**
 * Get active crisis sessions
 */
export async function getActiveCrisisSessions(orgId?: number | null): Promise<unknown[]> {
  // orgId scopes the read to one organization (org-bound researchers, C13);
  // null returns byte-identical rows to the pre-scoping query (care-team
  // callers, who are further caseload-filtered by the route). An anonymous
  // session (user_id NULL, so no owner org) is irb-study custody: visible to
  // that org only, the same rule as the by-id gates (ai-therapist-276).
  const result = await pool.query(
    `SELECT
       ts.session_id,
       ts.user_id,
       ts.crisis_severity,
       ts.crisis_risk_score,
       ts.crisis_flagged_at,
       ts.crisis_flagged_by,
       u.username
     FROM therapy_sessions ts
     LEFT JOIN users u ON ts.user_id = u.userid
     WHERE ts.crisis_flagged = TRUE
       AND ($1::int IS NULL OR u.organization_id = $1
         OR (ts.user_id IS NULL AND $1 = ${IRB_STUDY_ORG_ID_SQL}))
     ORDER BY ts.crisis_risk_score DESC, ts.crisis_flagged_at DESC`,
    [orgId ?? null],
  );
  return result.rows;
}

/**
 * Get session risk history
 */
export async function getSessionRiskHistory(sessionId: string): Promise<unknown[]> {
  const result = await pool.query(
    `SELECT * FROM risk_score_history
     WHERE session_id = $1
     ORDER BY calculated_at ASC`,
    [sessionId],
  );
  return result.rows;
}
