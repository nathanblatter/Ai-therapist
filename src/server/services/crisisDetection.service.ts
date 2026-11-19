import OpenAI from 'openai';
import { pool } from '../config/db.js';
import { getOpenAIKey } from '../config/secrets.js';
import { getRecentSessionMessages, recordCrisisEvent } from '../db/crisis.queries.js';
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
import { riskSeverityForScore } from '../../shared/riskBands.js';

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
      // Algospeak written to get past platform filters. Each is a direct
      // stand-in for a keyword already in this tier and has no everyday
      // meaning ("sewerslide" = suicide, "unalive myself" = kill myself).
      // Shorthand that DOES have other meanings ("kms", "ctb") is not here:
      // it only wakes the assessor (SLANG / euphemism context signals below).
      'sewerslide',
      'sewer slide',
      'unalive myself',
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
    // "Life isn't worth it." The high tier has "not worth living"; this is the
    // same thought with the object left as "it". Subject "life" only: "this
    // class isn't worth it" is not matched.
    label: 'life is not worth it',
    pattern:
      /\blife (?:(?:just|really|honestly|simply) )?(?:is not|isn't|is no longer|ain't|is just not|does not feel|doesn't feel|does not seem|doesn't seem) (?:(?:really|even) )?worth (?:it|living|the (?:effort|pain|trouble|fight|struggle))\b/,
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
  // The negated auxiliaries the word forms below rely on, typed without the
  // apostrophe ("part of me doesnt want to be here", "life isnt worth it").
  [/\b(is|does|did|was|were|could|would)nt\b/g, "$1n't"],
];

function normalizeForScreen(content: string): string {
  let lowerContent = content.toLowerCase();
  for (const [pattern, replacement] of NORMALIZATIONS) {
    lowerContent = lowerContent.replace(pattern, replacement);
  }
  return lowerContent;
}

// Word forms. Each keyword above is written once, in its
// base form, and used to be matched as that exact string, so the screen knew
// one inflection of every phrase: "overdose" but not "I think I overdosed",
// "kill myself" but not "I keep thinking about killing myself", "don't want to
// be here" but not "part of me doesn't want to be here". Those turns matched
// nothing and the assessor never ran. The class is fixed here rather than by
// listing more strings: when a keyword is compiled, every word that appears in
// this table matches all of its forms. The reported keyword stays the base
// phrase, so score_factors and the audit trail read as before.
//
// Only verbs and auxiliaries are inflected. Pronouns are not: "kill himself"
// is a different statement from "kill myself" (someone else is at risk) and is
// screened separately as a third-party signal, which never scores on its own.
const WORD_FORMS: Record<string, string> = {
  kill: 'kill(?:s|ed|ing)?',
  end: 'end(?:s|ed|ing)?',
  take: '(?:take|takes|took|taken|taking)',
  want: 'want(?:s|ed|ing)?',
  wish: 'wish(?:es|ed|ing)?',
  cut: 'cut(?:s|ting)?',
  hurt: 'hurt(?:s|ing)?',
  harm: 'harm(?:s|ed|ing)?',
  give: '(?:give|gives|gave|given|giving)',
  go: '(?:go|goes|going)',
  // "od'd" / "oded" / "od'ing": only the inflected shorthand, never bare "od".
  overdose: "(?:overdos(?:e|es|ed|ing)|od(?:'d|ed|'ed|'ing))",
  unalive: 'unaliv(?:e|es|ed|ing)',
  'self-harm': 'self-harm(?:s|ed|ing)?',
  // 'self harm' (two words): "self" is literal, "harm" inflects as above.
  "don't": "(?:don't|do not|didn't|did not|doesn't|does not)",
  "can't": "(?:can't|cannot|can not|couldn't|could not)",
  cannot: "(?:can't|cannot|can not|couldn't|could not)",
  was: '(?:was|were)',
  were: '(?:was|were)',
};

// Between the words of a keyword: whitespace, and any number of the adverbs
// people put there. "I don't really want to be alive" is the passive-ideation
// keyword with one word in the middle, and it matched nothing (it is the
// check-in text of the OPEN-03 scenario). Intensifiers and hedges only: none
// of them changes what the phrase says.
const KEYWORD_FILLERS = [
  'really',
  'just',
  'even',
  'actually',
  'honestly',
  'truly',
  'literally',
  'simply',
  'still',
  'ever',
  'always',
  'sometimes',
  'kind of',
  'kinda',
  'sort of',
  'sorta',
  'fucking',
  'freaking',
];
const KEYWORD_GAP = `\\s+(?:(?:${KEYWORD_FILLERS.join('|')})\\s+)*`;

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One keyword phrase as a whole-word regex over normalized text, with every
 *  word in WORD_FORMS matching all its forms and any run of whitespace between
 *  words. Exported for tests. */
export function keywordPattern(keyword: string): RegExp {
  const words = keyword
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => WORD_FORMS[word] ?? escapeRegex(word));
  return new RegExp(`\\b${words.join(KEYWORD_GAP)}\\b`);
}

/** Compiled once at load (they used to be rebuilt for every message). */
const COMPILED_KEYWORDS: Array<{ keyword: string; level: string; score: number; pattern: RegExp }> = Object.entries(
  CRISIS_KEYWORDS,
).flatMap(([level, data]) =>
  data.keywords.map((keyword) => ({ keyword, level, score: data.score, pattern: keywordPattern(keyword) })),
);

export function detectCrisisKeywords(content: string): KeywordAnalysis {
  if (!content) return { keywords: [], keywordScore: 0, detectedKeywords: [] };

  const lowerContent = normalizeForScreen(content);
  const detectedKeywords: DetectedKeyword[] = [];
  let totalScore = 0;

  for (const { keyword, level, score, pattern } of COMPILED_KEYWORDS) {
    if (pattern.test(lowerContent)) {
      detectedKeywords.push({ keyword, level, score });
      totalScore = Math.max(totalScore, score);
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

export type ContextSignalKind =
  | 'intent'
  | 'farewell'
  | 'means_question'
  // Shorthand and euphemism for suicide that also has ordinary meanings ("kms",
  // "ctb", "I want out"). Never a score: the assessor reads it in context, so
  // "ran 5 kms" or an unrelated "CTB" costs one assessor call and nothing else.
  | 'slang'
  // Someone ELSE's suicidal statement or act ("she's going to kill herself
  // tonight"). Owner decision 2026-11-18 (ai-therapist-326): an active or
  // imminent third-party crisis flags high and pages. The first-person
  // keyword tiers do not match these, so before this kind existed the turn
  // was never assessed at all. Never a score: third-person talk is far more
  // often a film, the news or a past loss, which only the assessor can tell.
  | 'third_party'
  // Thoughts of harming ANOTHER person ("I keep picturing hurting him. I know
  // where he parks."). Owner decision 2026-11-18 (ai-therapist-330): a
  // credible statement of intent or planning is flagged and staff are
  // notified as for a high self-risk, labelled as risk to others, and the
  // model is steered to de-escalate. The keyword tiers are built around
  // self-harm, so these turns were never assessed on the realtime path.
  // Never a score: "I'm going to kill my lab partner, he did nothing all
  // semester" is the same verb and object, and only the assessor can tell
  // venting from intent.
  | 'harm_others';

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
  // ---- slang and euphemism with other meanings (assessor decides) ----
  {
    kind: 'slang',
    label: 'kms (shorthand)',
    strong: false,
    // Not after a number: "ran 5 kms", "12 kms away".
    pattern: /(?<!\d\s?)\bkms\b/,
  },
  { kind: 'slang', label: 'ctb (shorthand)', strong: false, pattern: /\bctb\b/ },
  {
    kind: 'slang',
    label: 'unalive (algospeak)',
    strong: false,
    // "unalive myself" is a keyword; this is the bare verb ("thinking about
    // unaliving", "might just unalive").
    pattern: /\bunaliv(?:e|es|ed|ing)\b/,
  },
  {
    kind: 'slang',
    label: 'off myself',
    strong: false,
    // The verb, not the preposition ("get this weight off myself").
    pattern:
      /\b(?:to|going to|might|could|should|would|will|i'll|i'd|just|and) off myself\b|\boff(?:ed|ing) myself\b|\b(?:self[- ]delet(?:e|ed|ing)|delet(?:e|ed|ing) myself)\b/,
  },
  {
    kind: 'slang',
    label: 'want out (euphemism)',
    strong: false,
    // "I want out. Like out out. Of everything." / "i want out i can't do
    // this anymore". "I want out of this lease" is matched too and costs one
    // assessor call; the assessor reads what "out" is out of.
    pattern: /\bi (?:(?:just|really|only|kind of|kinda|honestly) )*(?:want|need|wanted) (?:a way )?out\b/,
  },
  // ---- someone else's suicidal statement or act (assessor decides) ----
  {
    kind: 'third_party',
    label: 'third party: kill or hurt themselves',
    strong: false,
    pattern:
      /\b(?:kill(?:s|ed|ing)?|hurt(?:s|ing)?|harm(?:s|ed|ing)?|cut(?:s|ting)?|unaliv(?:e|es|ed|ing))\s+(?:himself|herself|themselves|themself|theirself)\b/,
  },
  {
    kind: 'third_party',
    label: 'third party: end or take their life',
    strong: false,
    pattern: /\b(?:end(?:s|ed|ing)?|take(?:s|n)?|took|taking)\s+(?:his|her|their)\s+(?:own\s+)?life\b/,
  },
  {
    kind: 'third_party',
    label: 'third party: wants to die or not be here',
    strong: false,
    pattern:
      /\b(?:he|she|they)(?:'s|'re| is| are| was| were)?\b[\w\s,'-]{0,25}?\b(?:want(?:s|ed|ing)? to die|wish(?:es|ed)? (?:he|she|they) (?:was|were|wasn't|weren't|was not|were not) (?:dead|alive|here|around|born)|wish(?:es|ed)? (?:he|she|they) (?:could|would) (?:just )?(?:disappear|die|not wake up|not exist|not be here)|want(?:s|ed)? to (?:just )?disappear|(?:would|will|'d|'ll) be better off (?:dead|without (?:him|her|them))|going to end it)\b/,
  },
  // ---- thoughts of harming another person (assessor decides) ----
  {
    kind: 'harm_others',
    label: 'harm to a person (violent verb + person)',
    strong: false,
    // The object is a person: a pronoun, or "my/that/this/the" + a person
    // noun. "hurt my back", "kill my appetite" and "beat my record" are not
    // matched; "kill my lab partner" is, and is the assessor's to clear.
    pattern: new RegExp(
      '\\b(?:hurt|hurting|kill|killing|harm|harming|stab|stabbing|shoot|shooting|strangle|strangling|choke|choking|attack|attacking|murder|murdering|beat(?:ing)? up|punch|punching)\\s+' +
        '(?:him|her|them|someone|somebody|anyone|people|everyone|(?:my|that|this|the)\\s+(?:[\\w-]+\\s+){0,2}?(?:' +
        'partner|roommate|boss|manager|coworker|ex|boyfriend|girlfriend|husband|wife|mom|mother|dad|father|stepdad|stepmom|' +
        'brother|sister|friend|teacher|professor|landlord|neighbou?r|kid|son|daughter|baby|family|parents|classmate|teammate|guy|girl|man|woman|person' +
        '))\\b',
    ),
  },
  {
    kind: 'harm_others',
    label: 'thoughts or images of violence',
    strong: false,
    pattern:
      /\b(?:picturing|imagining|fantasi[sz]ing about|thinking about|thought about|thoughts? (?:of|about)|urges? to|dream(?:ing|ed)? (?:of|about))\s+(?:hurting|killing|harming|stabbing|shooting|strangling|choking|attacking|murdering|beating up)\b(?!\s+(?:myself|my ?self)\b)/,
  },
  {
    kind: 'harm_others',
    label: 'veiled threat',
    strong: false,
    pattern:
      /\b(?:get(?:s|ting)?|got) what(?:'s| is) coming to (?:him|her|them)\b|\bmake (?:him|her|them) pay\b|\b(?:he|she|they)(?:'ll| will|'s going to| is going to|'re going to| are going to) (?:regret|pay for|be sorry)\b|\bi know where (?:he|she|they) (?:parks?|lives?|works?|sleeps?)\b|\bexactly what i(?:'d| would|'ll| will|'m going to| am going to) do to (?:him|her|them)\b/,
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

// ============================================
// STAGE 1c: THE ANSWER TO A SAFETY QUESTION
// ============================================
// "yeah. kind of. most nights." carries no crisis word and no signal: all of
// its meaning is in the question it answers. When the assistant has just asked
// about suicidal thoughts or safety, the participant's reply is the disclosure
// (or the denial), and in a calm session it used to be scored 0 with no
// assessor call (measured 2026-11-18: 3 of 5 runs, session never flagged).
// The screen here looks at the ASSISTANT's turn, never scores, and does one
// thing: it sends the participant's keyword-free reply to the assessor with
// that question in the transcript. Cost: one assessor call per reply to a
// safety question; the assistant asks one rarely outside a session that is
// already risk-bearing, where every turn is assessed anyway.
const SAFETY_QUESTION_TOPICS: RegExp[] = [
  /\bsuicid/,
  /\b(?:kill|killing|hurt|hurting|harm|harming|cut|cutting) yourself\b/,
  /\bself[- ]harm/,
  /\b(?:end|ending|take|taking) (?:your (?:own )?life|it all|things)\b/,
  /\b(?:want(?:ing|ed)?|wish(?:ing|ed)?) (?:to die|to be dead|you were dead|you (?:were|was)n't (?:here|alive|around)|to disappear|to not (?:be (?:here|alive)|exist|wake up)|not to (?:be (?:here|alive)|exist|wake up))\b/,
  /\b(?:not|n't) (?:want(?:ing)?|wish(?:ing)?) to (?:be (?:alive|here|around)|live|exist|wake up|go on)\b/,
  /\bnot (?:being|be) (?:alive|here|around)\b/,
  /\b(?:better off|be (?:fine|better)) without you\b/,
  /\bthoughts? (?:of|about) (?:death|dying|not (?:being|waking|existing))\b/,
  /\b(?:are|do|have|did|were) you\b[\w\s,'-]{0,20}\bsafe\b|\b(?:keep|keeping|stay|staying) (?:yourself )?safe\b|\bfeel(?:ing)? safe\b|\bin (?:any )?danger\b/,
];

/**
 * Does this assistant turn ask the participant about suicide, self-harm or
 * their safety? A question mark plus one of the topics above. Deliberately
 * broad: a match only decides that the reply is read by the assessor.
 * Exported for tests.
 */
export function asksSafetyQuestion(assistantText: string | null | undefined): boolean {
  if (!assistantText || !assistantText.includes('?')) return false;
  const text = normalizeForScreen(assistantText);
  return SAFETY_QUESTION_TOPICS.some((topic) => topic.test(text));
}

/**
 * Is the latest participant turn a reply to an assistant safety question?
 * `history` is oldest first and may end with the participant turn being scored
 * (it is persisted before the pipeline runs), possibly in several parts: the
 * turn in question is the last assistant turn before those. Exported for tests.
 */
export function repliesToSafetyQuestion(history: HistoryMessage[]): boolean {
  let i = history.length - 1;
  while (i >= 0 && history[i].role !== 'assistant') i--;
  if (i < 0) return false;
  return asksSafetyQuestion(history[i].content ?? history[i].content_redacted);
}

// ============================================
// STAGE 1d: LOW-CONTENT FRAGMENTS (ai-therapist-349)
// ============================================
// Voice transcripts arrive as fragments, some of them mis-heard. In a real
// session on 2026-11-18 a participant doing a breathing exercise said "wait,
// stop"; it was transcribed as "would stop". The session had one earlier
// low-band turn (work stress), so every turn was context-assessed, and the
// assessor completed the two words into a sentence: 50, "passive ideation,
// hopelessness", "the phrase 'would stop' suggests a passive wish to escape".
// The session was flagged, the assistant asked the ideation question, the
// vendor filter cut the call on that question, and staff were paged.
//
// A message made ONLY of the words below says nothing by itself: it is a
// stop/go, a filler, an acknowledgement. In a session that has never reached
// the flagging level (medium) such a fragment is not sent to the assessor at
// all, so there is nothing for it to over-read. It is deliberately a closed
// list of function words and not a length rule: "bought a gun", "tonight" and
// "pills" are as short and are NOT on it, and still go to the assessor.
// Two cases keep being assessed however empty the words:
//  - the reply to an assistant safety question ("yeah", "no", "sometimes"),
//    where the question gives the word its meaning;
//  - any turn of a session already at medium or high, where "yes" or "ok"
//    may be the answer to something that has scrolled out of view.
const LOW_CONTENT_WORDS = new Set(
  (
    'stop wait would ok okay k yeah yes yep yup no nope nah um uh hmm mm oh ah well so and then but just like ' +
    'i it that this the a you we can please sorry thanks thank right sure fine good great cool alright ' +
    'hold on one sec second moment minute pause continue keep going go back again now here there what huh hey hi ' +
    'hello bye goodbye never mind nothing really maybe actually let me us'
  ).split(' '),
);
/** Longest message the fragment guard considers (in words). */
const LOW_CONTENT_MAX_WORDS = 6;

/**
 * Is this message a low-content fragment: at most LOW_CONTENT_MAX_WORDS words,
 * every one of them a filler, an acknowledgement or a stop/go word? Exported
 * for tests. "goodbye" is on the list on purpose: the farewell context signals
 * ("this is goodbye", "goodbye everyone") are checked BEFORE this guard, and a
 * bare "bye" at the end of an ordinary session is the common case.
 */
export function isLowContentFragment(content: string): boolean {
  const words = normalizeForScreen(content)
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return true;
  return words.length <= LOW_CONTENT_MAX_WORDS && words.every((w) => LOW_CONTENT_WORDS.has(w));
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
  /** The peak turn was a report of SOMEONE ELSE's crisis (score_factors
   *  third_party), not the participant's own risk. */
  peakThirdParty: boolean;
  /** The peak turn was about harming ANOTHER person (score_factors
   *  harm_to_others), not the participant's own suicide or self-harm risk. */
  peakHarmToOthers: boolean;
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
  peakThirdParty: false,
  peakHarmToOthers: false,
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
      peakThirdParty: peakIndex >= 0 && scoreFactorsFlag(recent[peakIndex].score_factors, 'third_party'),
      peakHarmToOthers: peakIndex >= 0 && scoreFactorsFlag(recent[peakIndex].score_factors, 'harm_to_others'),
      lookupFailed: false,
    };
  } catch (err) {
    log.error({ err }, `[risk] session risk context lookup failed for ${sessionId}; assessing the turn anyway`);
    return { ...CALM_CONTEXT, elevated: true, lookupFailed: true };
  }
}

function scoreFactorsFlag(raw: unknown, key: 'context_wake' | 'third_party' | 'harm_to_others'): boolean {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
  }
  return !!parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>)[key] === true;
}

function isContextWakeRow(raw: unknown): boolean {
  return scoreFactorsFlag(raw, 'context_wake');
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
      (ctx.peakThirdParty
        ? // Not the participant's own risk: without this the assessor reads
          // "assessed as high" as the participant having been suicidal.
          `earlier in this session the participant reported SOMEONE ELSE's crisis (a third party at risk, not the participant), assessed as ${severityForScore(ctx.recentPeak)}`
        : ctx.peakHarmToOthers
          ? `earlier in this session the participant described thoughts of harming ANOTHER person (a risk to someone else, not suicide or self-harm), assessed as ${severityForScore(ctx.recentPeak)}`
          : `earlier in this session the participant's risk was assessed as ${severityForScore(ctx.recentPeak)}`) +
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
  const ctx = await getSessionRiskContext(sessionId);
  // A filler-only fragment in a session that never reached medium is not
  // assessed for the session's sake (see isLowContentFragment); it still is
  // when it answers a safety question, below.
  const fragment = !ctx.lookupFailed && !contextIsMediumOrAbove(ctx) && isLowContentFragment(content);
  if (ctx.elevated && !fragment) return true;
  // The reply to an assistant safety question (see repliesToSafetyQuestion).
  // A failed read means "assess": the question may be there.
  try {
    return repliesToSafetyQuestion(await getRecentSessionMessages(sessionId, 4));
  } catch (err) {
    log.error({ err }, `[risk] could not read recent turns for ${sessionId}; assessing the turn anyway`);
    return true;
  }
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

export const RISK_ASSESSMENT_PROMPT = `You are a clinical risk-assessment assistant for an AI-assisted therapy research platform. A keyword screen flagged possible crisis language in a support conversation. Read the recent transcript and assess the PARTICIPANT's current suicide/self-harm risk (and, under the "Harm to others" rule below, a serious risk that they will harm someone else).

Return STRICT JSON only:
{
  "risk_score": <0-100>,
  "severity": "none" | "low" | "medium" | "high",
  "context": "genuine" | "negated" | "bystander" | "reference" | "unclear" | "harm_to_others",
  "factors": [<short strings: e.g. "passive ideation", "expressed plan", "hopelessness", "protective factors present">],
  "reasoning": "<one sentence>",
  "states_intent": <true | false>,
  "loss_or_disclosure": <true | false>
}

Context judgment matters more than keywords:
- "reference": mentioning a hotline's name, suicide prevention, a movie/book/news story → score 0-10, severity none.
- "negated": "I'm not suicidal", "I'd never hurt myself" → score 0-15, severity none (unless other signals contradict).
- "bystander": talking about someone ELSE's loss, past struggles or ordinary worry about them → score 0-20, severity none/low (their own grief may still warrant low). Someone else's CURRENT suicidal crisis is different and is scored by the "Third party at risk" rule below.
- "genuine" acute distress WITHOUT ideation → 15-30, low. Distress alone is hopelessness, worthlessness, exhaustion, "can't take it" — e.g. "I just feel hopeless and worthless lately" is 15-30, low. It is NOT passive ideation: reserve that label for an expressed wish to die, disappear, not exist, not wake up, not be here, or not have to go on. Never score distress alone as medium.
- "genuine" passive ideation → 50-60, medium, ALWAYS at least 50. C-SSRS counts a passive wish to be dead as ideation, not as distress, so it must reach medium — never score it low. This includes INDIRECT and euphemistic phrasing, which is how participants usually say it first: "it would be easier if I didn't have to do this anymore", "I wouldn't mind not waking up", "I'm tired of being here", "I just want it all to be over", "everyone would be fine without me", "I don't want to be here anymore", "no point going on". Hedges and softeners ("I think", "sometimes", "just", "kind of", "maybe") do NOT downgrade it — tentative wording is the normal way passive ideation is disclosed. Absence of a plan, method, or intent does NOT downgrade it either; that is the difference between passive ideation and active ideation, which scores higher still.
- "genuine" active ideation without plan → 65-75, high, ALWAYS at least 65. Active ideation is thinking about suicide, about killing themselves or about ending their life, as opposed to a passive wish to be dead or gone: "I've been thinking about ending my life a lot lately", "I keep thinking about suicide and it's getting louder", "I'm thinking about killing myself". No plan, method or intent is needed for this band, and saying "I don't have a plan" does not take it below 65.
- "genuine" ideation with plan, means, or timeframe → 80-100, high.
Resolve references against the conversation before scoring. The latest message is often short and carries no crisis word because its subject was said earlier:
- If the participant expressed ideation or self-harm earlier in the transcript (or the session risk context below the transcript says so), read "it", "this", "that" and unfinished sentences in the latest message against that. "I'm going to do it tonight", "I've decided", "tonight's the night", "I have what I need", "I know how I'd do it", "this is the last time we'll talk", "you won't have to listen to me much longer", "I've said my goodbyes" are then statements of intent, plan, timing or goodbye → 80-100, high, context "genuine". An attempt already made or under way scores the same.
- The same words with an ordinary subject in the conversation (an assignment, a job application, a breakup talk, a move, quitting a class) are not risk → 0-10, none. With no earlier ideation and no ordinary subject either, a bare "I've decided" is "unclear" → 15-30, low; a goodbye or "I won't be around" with warning signs before it (giving possessions away, settling affairs, sudden calm, withdrawal) → at least 50, medium.
- Agreeing to, or announcing, a step toward help or safety is the opposite of intent, even in the same words and even after ideation: "ok, I'll do it tomorrow" in reply to a suggestion to call a counselor, "I'm going to do it, I'll text my sister tonight", "I'll just do it now" about booking an appointment, "I've decided to tell my roommate". The "it" is the step just discussed. That is help-seeking, a protective factor: never score such a message higher than the level the conversation had already established.
- A retraction, a joke or a reassurance after a disclosure ("jk", "forget I said that", "I'm fine, I was being dramatic") adds no new risk and does not prove safety: never score it HIGHER than what the conversation had already established, and never read "I've decided NOT to", "I'm not going to do it" or "I changed my mind" as intent.
- Means inquiry. A question about what is lethal or dangerous to take or keep, how much is too much, or how something could kill is a recognised warning sign when the SAME conversation contains a recent loss or setback, hopelessness, or any disclosure. Score it at least 50, medium, context "unclear", whatever purpose the participant gives for asking (a class paper, curiosity, a story): a stated purpose does not lower the score, and an abrupt change of subject from the loss to this question is itself a reason for concern. After expressed ideation → 75-100, high. Only when the conversation contains nothing concerning at all (for example a student talking about a toxicology exam) → 10-20.
The last two fields are plain observations, not risk judgments. Answer them literally and independently of the score:
- "states_intent": true ONLY when the latest participant message itself, read against the conversation, says that they (the participant, not a third party they are reporting about) intend or have decided to end their own life or hurt themselves, names a time for it, says they have a plan or the means at hand, says goodbye in that sense, or says they have already acted. false when the latest message is about getting help or taking a safety step, an ordinary plan or decision, a retraction or reassurance, a question, or anything else; earlier risk in the conversation does not make it true.
- "loss_or_disclosure": true when anywhere in the transcript the PARTICIPANT reports a significant loss or setback of their own (failing or being dropped from a program, a breakup, a death, losing a job, a serious diagnosis or other serious bad news), even stated flatly with no feelings named, or expresses hopelessness, or discloses suicidal thoughts or self-harm. Ordinary stress (a busy week, an upcoming exam, being tired) is false.
- The session risk context, when present, is background for understanding what the latest message refers to. It is not new evidence: a latest message that adds nothing ("ok", a change of subject, a practical question) must not be scored HIGHER than the level already noted, and ordinary life events mentioned afterwards are not warning signs merely because risk was noted earlier.
Third party at risk. When the participant reports that SOMEONE ELSE is suicidal, keep context "bystander" and score what is happening to that other person:
- ACTIVE or IMMINENT and unresolved → 80-100, high. That is: they said they are going to or want to kill themselves or end their life; they have a plan, a method or a time; an attempt has been made or is under way; they wrote or posted a goodbye or suicide note; or they said something suicidal (including not wanting to be alive) and now cannot be reached. A second-hand report ("she texted me", "he told me last night"), a calm participant, or the absence of a plan does not lower it: a real person may be in danger, and the study team is alerted so they can help the participant respond.
- Passive or long-standing thoughts with nothing imminent ("my mom has depression and some days she says she wishes she wasn't here") → 50-60, medium.
- Ordinary worry, a past crisis that has resolved, a death or suicide that has already happened, a film, a book or the news → 0-20, none/low.
- If the participant also voices ideation of their OWN, score that instead, with context "genuine".
Harm to others. When the participant talks about hurting or killing ANOTHER person, decide first whether it is a figure of speech:
- Idiom, exaggeration and ordinary anger → 0-10, none, context "reference". "I swear I'm going to kill my lab partner, he did nothing all semester", "I could strangle him", "I'm so mad at my ex I could scream", "sometimes I get so angry I want to hit something, but I'd never actually hurt anyone", a film or a game. An angry sentence with a violent verb and nothing else is this.
- Credible intent or planning → 75-100, high, context "harm_to_others": thoughts or images of hurting a specific person that the participant presents as real, together with anything that makes it more than venting (knowing where the person is or will be, having thought through what they would do, a plan, the means, a time, a threat meant seriously, or saying they might actually do it). "I keep picturing hurting him. I know where he parks." and "He's going to get what's coming to him. I've thought about exactly what I'd do." are this. The study team is alerted so a person can respond.
- Unwanted thoughts of harming someone that the participant is frightened by and rejects ("I've been having thoughts about hurting my baby sister and it scares me. I would never do it"), or rage with an urge to hurt a specific person but no plan and no stated intent → 25-50, low to medium, context "harm_to_others". Never high.
"states_intent" is false for all of these: it is only about the participant's own suicide or self-harm.
Slang and shorthand: "kms" (kill myself), "ctb" or "catch the bus" (die by suicide), "unalive", "sewerslide", "off myself", "I want out" (of life, of everything). Said in earnest about themselves, score them as the plain words they stand for ("been thinking about ctb a lot lately" is active ideation; "I want out. Of everything." is at least passive ideation, 50 or more). With an ordinary meaning in the conversation (a distance in kms, an unrelated abbreviation, an actual bus, wanting out of a lease or a class) → 0-10, none.
An answer to a safety question. When the assistant's turn just before the latest message asks about suicide, self-harm, wanting to die or not be alive, or whether the participant is safe, the latest message is the answer to THAT question, however short: score it as if the participant had said the full sentence. "yeah", "kind of", "sometimes", "most nights", "I guess" in reply to a question about not wanting to be alive is passive ideation → at least 50, medium; in reply to a question about suicide or ending their life it is active ideation; in reply to a question about a plan, the means or a time → 80-100, high. Hedged and minimal answers do not downgrade it. A clear "no" (or "yes, I'm safe") is "negated" → 0-15. A dodge ("I don't know", "does it matter") is "unclear" → 25-40, low.
Before you answer, read the latest message once more for help-seeking. When it announces or agrees to a step toward help or safety (texting or calling a family member, a friend, a counselor or a crisis line, booking an appointment, telling a roommate), the "it" in "I'm going to do it" or "I'll do it" is that step: "states_intent" is false and the score is not above the level the conversation had already established.
And for a means inquiry already made: when the latest message presses for the answer to a question about what is dangerous or lethal after it was declined ("it really is just for the paper, can you answer the question?"), it is still that means inquiry. Score it at the level the inquiry itself had, not lower.
Fragments. Voice transcripts arrive in pieces and with mis-heard words, and typed messages can be a word or two. Score only what was actually said. A latest message of a few words with no risk content of its own ("would stop", "wait, stop", "ok", "hold on", "and then") adds nothing: do not complete it into a sentence about dying, escape or giving up, do not list risk factors for it, and score it 0-10, context "unclear". It takes a meaning only from something specific in the conversation: the assistant's safety question just before it (the rule above), or an earlier statement it plainly continues ("tonight" after the participant said they have a plan). Ordinary distress earlier in the conversation (stress, exhaustion, a bad week) is not such a statement, and a request to stop or pause an exercise is just that.
Weigh protective factors (future plans, reasons for living, engaged help-seeking) downward. Base the score on the participant's CURRENT state in this conversation, not history alone.`;

/** How one assessment is framed for the assessor beyond the transcript. */
export interface RiskAssessmentFraming {
  /** One line on what earlier turns of this session established (see
   *  describeSessionRiskContext); omitted for a session with no prior risk. */
  sessionContext?: string | null;
  /** True for a context wake: the latest message matched no crisis keyword
   *  and is being assessed because of the conversation around it. */
  keywordFree?: boolean;
  /** True when the assistant's turn just before the latest message asks about
   *  suicide, self-harm or safety (repliesToSafetyQuestion). */
  answersSafetyQuestion?: boolean;
  /** True when the latest message is not a chat or voice turn but the free
   *  text of the participant's pre-session check-in. */
  fromCheckin?: boolean;
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
    (framing.fromCheckin
      ? `What the participant wrote in the check-in form just before this session started (their own words, written to be read by the assistant; assess it as their first message):`
      : framing.keywordFree
        ? framing.answersSafetyQuestion
          ? `Latest participant message (it matched no crisis keyword; it is the participant's answer to the assistant's safety question just above, so read it as the answer to that question):`
          : `Latest participant message (it matched no crisis keyword; assess it against the transcript and any session risk context above):`
        : `Latest participant message (the one that tripped the screen):`) +
    `\n"${latestContent}"`
  );
}

/** First factor on a flag raised for someone else's crisis: what staff read in
 *  the crisis event, the dashboard alert and the work item. */
export const THIRD_PARTY_FACTOR = 'third party at risk (reported by participant)';

/** First factor on a flag raised for thoughts of harming another person. */
export const HARM_TO_OTHERS_FACTOR = 'risk to others (thoughts of harming another person)';

/** Who a flag is about when it is not the participant's own suicide or
 *  self-harm risk. Carried on the result, the risk row, the crisis event, the
 *  intervention rows, the dashboard events and the page. */
export type CrisisSubject = 'third_party' | 'harm_to_others';

/** The assessor's context label at a flagging severity, as a subject. */
function subjectFor(context: string | undefined, severity: string): CrisisSubject | null {
  if (severity !== 'medium' && severity !== 'high') return null;
  return context === 'bystander' ? 'third_party' : context === 'harm_to_others' ? 'harm_to_others' : null;
}

const SEVERITY_RANK_ORDER = { none: 0, low: 1, medium: 2, high: 3 } as const;

/** Score → severity band. Single definition (src/shared/riskBands.ts); every
 *  caller must agree. High starts at RISK_BANDS.high: 65 since 2026-11-18
 *  (owner decision), 75 before. */
const severityForScore = riskSeverityForScore;

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
        context: {
          type: 'string',
          enum: ['genuine', 'negated', 'bystander', 'reference', 'unclear', 'harm_to_others'],
        },
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
  /** True when the assessor judged the message to be about SOMEONE ELSE's
   *  crisis at medium or high (see RiskAnalysisResult.thirdParty). */
  thirdParty?: boolean;
  /** Set with thirdParty / for harm to others (see RiskAnalysisResult.subject). */
  subject?: CrisisSubject;
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
    const subject = subjectFor(llm.context, floored.severity);
    return {
      riskScore: floored.riskScore,
      severity: floored.severity,
      factors: [
        ...(subject === 'third_party' ? [THIRD_PARTY_FACTOR] : []),
        ...(subject === 'harm_to_others' ? [HARM_TO_OTHERS_FACTOR] : []),
        ...baseFactors,
        ...(floored.floored ? ['passive ideation (screen floor)'] : []),
      ],
      method: 'llm_assessed',
      ...(subject === 'third_party' ? { thirdParty: true } : {}),
      ...(subject ? { subject } : {}),
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
async function trackEmotionalTrajectory(
  sessionId: string,
  excludeMessageIds: ReadonlyArray<string | number> = [],
): Promise<TrajectoryResult> {
  try {
    // Get risk score history for this session.
    //
    // `excludeMessageIds` are the earlier parts of the sentence being scored
    // now (a voice turn stitched to the fragment(s) before it; see
    // stitchSplitTurnParts in crisisPipeline.service.ts). Their rows are this
    // message, not its run-up: left in, a sentence that was already scored
    // once as its first part becomes its own "sudden spike" when it is scored
    // again with a trailing fragment. Measured 2026-11-18 on the real
    // assessor: "some days I don't want to be here anymore." scored 70
    // (medium); the same sentence stitched to a following " you know?" scored
    // 75 (high, a page), with the assessor answering 55 both times.
    const exclude = excludeMessageIds.map((id) => String(id));
    const historyResult =
      exclude.length > 0
        ? await pool.query<{ risk_score: number; calculated_at: Date }>(
            `SELECT risk_score, calculated_at
       FROM risk_score_history
       WHERE session_id = $1
         AND (message_id IS NULL OR NOT (message_id::text = ANY($2::text[])))
       ORDER BY calculated_at DESC
       LIMIT 5`,
            [sessionId, exclude],
          )
        : await pool.query<{ risk_score: number; calculated_at: Date }>(
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
  /**
   * Voice only: ids of the participant turn(s) whose text is already included
   * at the start of `content` (one spoken sentence that reached us as several
   * turns). Their risk rows are left out of the trajectory run-up so the
   * sentence is not counted twice.
   */
  stitched_message_ids?: ReadonlyArray<string | number>;
  /** 'checkin' when `content` is the free text of the pre-session check-in
   *  rather than a chat or voice turn. Recorded on the risk row and told to
   *  the assessor; scoring is otherwise identical to a first message. */
  source?: 'checkin';
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
  /** True when the assessor judged the turn to be about SOMEONE ELSE's crisis
   *  (context 'bystander') at medium or high. The pipeline then labels the
   *  flag, the dashboard alert and the on-call page as a third party at risk
   *  and steers the model to help the participant respond (ai-therapist-326). */
  thirdParty?: boolean;
  /** Who the flag is about when it is not the participant's own suicide or
   *  self-harm risk: 'third_party' (same as thirdParty) or 'harm_to_others'
   *  (the assessor judged credible thoughts of harming another person,
   *  ai-therapist-330). Absent for the participant's own risk. */
  subject?: CrisisSubject;
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
      trackEmotionalTrajectory(message.session_id, message.stitched_message_ids ?? []),
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
    const keywordFree = keywordAnalysis.keywordScore === 0;
    // The reply to an assistant safety question: its meaning is in the
    // question, so it is assessed with the transcript however calm the session
    // (see repliesToSafetyQuestion). Not for the check-in, which precedes any
    // assistant turn.
    const answersSafetyQuestion =
      keywordFree && message.source !== 'checkin' && repliesToSafetyQuestion(conversationHistory);
    // A filler-only fragment ("would stop", "ok", "wait") in a session that has
    // never reached medium is not worth an assessment and has been over-read
    // into one (ai-therapist-349): the session's earlier low-band turn alone
    // does not send it to the assessor. A lookup failure assesses, as always.
    const fragmentSkipped =
      keywordFree &&
      contextSignals.length === 0 &&
      !answersSafetyQuestion &&
      sessionContext.elevated &&
      !sessionContext.lookupFailed &&
      !contextIsMediumOrAbove(sessionContext) &&
      isLowContentFragment(message.content);
    const isContextWake =
      keywordFree &&
      !isSweep &&
      !isModerationWake &&
      (contextSignals.length > 0 || (sessionContext.elevated && !fragmentSkipped) || answersSafetyQuestion);

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
          // Whatever woke the assessor, tell it when the turn answers a safety
          // question (a sweep or a moderation wake can land on one too).
          answersSafetyQuestion,
          fromCheckin: message.source === 'checkin',
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
              ? `context wake (signals [${contextSignals.map((c) => c.label).join(', ')}], session peak ${sessionContext.recentPeak}, flagged ${sessionContext.flagged}, answers safety question ${answersSafetyQuestion})`
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
    // Nor is it applied to a periodic sweep in a risk-bearing session whose
    // score does not exceed the level that session already holds. That turn is
    // chosen by a counter, not by its content; the assessor is given the same
    // session risk context; and the run-up it is compared with is the
    // context-wake rows before it. When the assessor simply repeats the
    // session's level those rows are a flat line, which the trajectory reads
    // as "deteriorating" (+15): 15 more than the stored score is always a
    // re-flag, and from 60 it is a high flag and a page, for a turn that said
    // nothing new (measured live: three neutral turns in a session flagged at
    // 65 each came back 60). A sweep that scores ABOVE the session's level, and
    // every sweep in a calm session, keeps the bonus exactly as before.
    const sweepRepeatsSessionLevel = isSweep && sessionContext.elevated && riskScore <= sessionContext.recentPeak;
    const trajectoryApplies =
      riskScore > 0 && trajectory.trajectoryScore > 0 && !isContextWake && !sweepRepeatsSessionLevel;
    if (trajectoryApplies) {
      riskScore = Math.min(100, riskScore + trajectory.trajectoryScore);
      factors = [...factors, `trajectory: ${trajectory.trend}`];
    }

    const severity = severityForScore(riskScore);
    // Someone else's crisis, as judged by the assessor. Only at the flagging
    // levels: a low bystander score (ordinary worry, a past loss) labels nothing.
    const subject = subjectFor(llm?.context, severity);
    const thirdParty = subject === 'third_party';
    if (thirdParty) factors = [THIRD_PARTY_FACTOR, ...factors];
    if (subject === 'harm_to_others') factors = [HARM_TO_OTHERS_FACTOR, ...factors];

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
                  ...(isContextWake || sweepRepeatsSessionLevel ? { trajectory_applied: false } : {}),
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
                  ...(answersSafetyQuestion ? { answers_safety_question: true } : {}),
                  session_context: {
                    flagged: sessionContext.flagged,
                    flagged_severity: sessionContext.flaggedSeverity,
                    recent_peak: sessionContext.recentPeak,
                    ...(sessionContext.lookupFailed ? { lookup_failed: true } : {}),
                  },
                }
              : {}),
            ...(message.source ? { source: message.source } : {}),
            // Why a turn of a risk-bearing session was NOT context-assessed.
            ...(fragmentSkipped && !isSweep && !isModerationWake ? { low_content_fragment: true } : {}),
            // The assessor read the turn as someone else's crisis. Kept on the
            // row so later turns are told so (describeSessionRiskContext).
            ...(thirdParty ? { third_party: true } : {}),
            ...(subject === 'harm_to_others' ? { harm_to_others: true } : {}),
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
      thirdParty,
      ...(subject ? { subject } : {}),
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
