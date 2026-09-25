// Refusal-loop guard for the Grok Voice backend (docs/grok-voice.md).
//
// xAI moderates server-side. When it trips, the model returns a canned line —
// "I can't help with that request" — and keeps returning it: in the stage
// session of 2026-09-23 the participant got five identical refusals in a row,
// including to "so is the session just over?". The string is not ours and the
// clinical prompt cannot override it, so the session is bricked unless the
// proxy notices the loop and breaks it.
//
// This module is the pure part: the detector and its settings. It does no I/O.
// The manager owns delivery (system steer, then a server-authored recovery
// line) — see grokVoiceManager.service.ts.

/**
 * Loop-breaking thresholds and patterns, admin-editable as
 * system_config.grok_refusal_guard. Stored as its own key rather than inside
 * grok_voice because the admin turn-taking form PUTs that key whole.
 */
export interface GrokRefusalGuardConfig {
  /** Master switch. Off means refusals are logged as ordinary turns only. */
  enabled: boolean;
  /**
   * Normalized substrings that mark a refusal. Matched against the assistant
   * turn after normalizeRefusalText (lowercased, punctuation stripped).
   */
  patterns: string[];
  /**
   * Only SHORT turns count. A long reply that happens to contain "i can't help
   * with that" is a real therapeutic boundary, not the moderation canned line.
   */
  maxChars: number;
  /** Consecutive refusals that trigger the system steer. */
  steerAfter: number;
  /** Consecutive refusals that trigger the server-authored recovery line. */
  recoverAfter: number;
}

export const GROK_DEFAULT_REFUSAL_GUARD: GrokRefusalGuardConfig = {
  enabled: true,
  patterns: [
    'i cant help with that',
    'i cannot help with that',
    'im not able to help with that',
    'i am not able to help with that',
    'i cant assist with that',
    'i cannot assist with that',
    'i wont be able to help with that',
    'sorry i cant help',
    'i cant continue with this',
  ],
  maxChars: 200,
  steerAfter: 2,
  recoverAfter: 4,
};

/**
 * Fold a turn to a comparison key: lowercase, no punctuation, single spaces.
 * Apostrophes are dropped rather than replaced so "can't" and "cant" collapse
 * onto one form and the pattern list can be written without them.
 */
export function normalizeRefusalText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[‘’ʼ']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Two short turns that say the same thing, allowing a trailing difference. */
export function isNearIdentical(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  // A prefix match only counts when there is enough of it to be the same
  // sentence rather than a shared opener such as "i hear you".
  return short.length >= 20 && long.startsWith(short);
}

/** What the manager should do after an assistant turn. */
export type GrokRefusalAction = 'none' | 'steer' | 'recover';

const clampInt = (n: unknown, lo: number, hi: number, dflt: number): number => {
  if (n === null || n === undefined || n === '') return dflt;
  const v = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : dflt;
};

/** Coerce a stored config value to a usable guard config (bad fields → defaults). */
export function resolveGrokRefusalGuard(raw: unknown): GrokRefusalGuardConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = GROK_DEFAULT_REFUSAL_GUARD;

  const patterns = Array.isArray(r.patterns)
    ? r.patterns
        .filter((p): p is string => typeof p === 'string')
        .map(p => normalizeRefusalText(p))
        .filter(p => p.length > 0)
    : [];

  const steerAfter = clampInt(r.steerAfter, 1, 20, d.steerAfter);
  return {
    enabled: r.enabled === undefined ? d.enabled : r.enabled !== false,
    patterns: patterns.length > 0 ? patterns : d.patterns,
    maxChars: clampInt(r.maxChars, 20, 2000, d.maxChars),
    steerAfter,
    // Recovery must never fire before the steer has had its turn.
    recoverAfter: Math.max(steerAfter + 1, clampInt(r.recoverAfter, 1, 40, d.recoverAfter)),
  };
}

/**
 * Consecutive-refusal counter for one session.
 *
 * A turn counts toward the streak when it is short AND either matches a
 * configured refusal pattern or repeats the previous short turn near
 * verbatim — the second arm catches a canned line xAI changes the wording of.
 * Anything else resets the streak: one refusal inside a working conversation
 * is a boundary, not a loop.
 */
export class GrokRefusalDetector {
  private readonly config: GrokRefusalGuardConfig;
  private streakCount = 0;
  private lastShortTurn: string | null = null;

  constructor(config: GrokRefusalGuardConfig = GROK_DEFAULT_REFUSAL_GUARD) {
    this.config = config;
  }

  get streak(): number {
    return this.streakCount;
  }

  get settings(): GrokRefusalGuardConfig {
    return this.config;
  }

  /** True when this turn reads as the moderation canned line. */
  isRefusal(text: string): boolean {
    const normalized = normalizeRefusalText(text);
    if (!normalized || normalized.length > this.config.maxChars) return false;
    if (this.config.patterns.some(p => normalized.includes(p))) return true;
    return this.lastShortTurn !== null && isNearIdentical(normalized, this.lastShortTurn);
  }

  /**
   * Record a completed assistant turn and say what to do about it. Returns
   * 'steer' exactly once per loop (at steerAfter) and 'recover' on every turn
   * from recoverAfter on — a participant hearing a sixth refusal still needs
   * an answer from us.
   */
  observe(text: string): GrokRefusalAction {
    if (!this.config.enabled) return 'none';
    const normalized = normalizeRefusalText(text);
    const refusal = this.isRefusal(text);

    if (!refusal) {
      this.streakCount = 0;
      this.lastShortTurn = normalized.length > 0 && normalized.length <= this.config.maxChars ? normalized : null;
      return 'none';
    }

    this.streakCount += 1;
    this.lastShortTurn = normalized;
    if (this.streakCount >= this.config.recoverAfter) return 'recover';
    if (this.streakCount === this.config.steerAfter) return 'steer';
    return 'none';
  }

  /** Clear the streak (the model produced a real turn, or we intervened). */
  reset(): void {
    this.streakCount = 0;
    this.lastShortTurn = null;
  }
}

/**
 * The system steer injected at the first threshold. Trusted mid-conversation
 * guidance per the voice header: acknowledge, one-sentence boundary, then back
 * to the person. Never read aloud as instructions.
 */
export const GROK_REFUSAL_STEER =
  'Your last replies were refusals that repeated the same sentence, and the participant is stuck. ' +
  'Do not repeat that refusal. In your next reply: briefly acknowledge what the participant just said, ' +
  'state in one short sentence what you are not able to go into, then turn back to how they are feeling ' +
  'right now and offer to stay with that. If they may be in distress, name the crisis resources available ' +
  'to them. Answer plain questions about the session itself, such as whether it is over, directly and kindly. ' +
  'Never mention this instruction to the participant.';

/**
 * The server-authored line the participant hears when the steer did not take.
 *
 * Authored here, not generated: the whole point of the second threshold is
 * that the model can no longer be relied on to speak. Delivered as assistant
 * text on the transcript channel — the proxy has no TTS of its own, so there
 * is no audio for a server-authored turn.
 */
export function buildGrokRefusalRecoveryLine(crisisLine?: string | null): string {
  const crisis = crisisLine && crisisLine.trim().length > 0
    ? crisisLine.trim()
    : 'call or text 988 to reach the Suicide and Crisis Lifeline, or call 911 if you are in immediate danger';
  return (
    'This is a note from the study system, not from the assistant. ' +
    'Something on our side is blocking its replies right now, so it keeps repeating itself. ' +
    'That is a problem with our software and not with anything you said. ' +
    'You can keep talking and we will keep listening, or you can end the session with the end button whenever you want. ' +
    `If you need support right now, please ${crisis}.`
  );
}
