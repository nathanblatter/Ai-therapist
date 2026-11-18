// Wording used when a GPT-Live voice session is cut by the vendor (content
// filter, or the session ceiling during a crisis) and the participant is
// brought back on a recovery session (ai-therapist-293).
//
// Shared by the browser (which sends the speak-first nudge and speaks/shows the
// interim line), the server (the recovery session prompt names the same line)
// and the red-team harness (which must say exactly what the browser says), so
// the three cannot drift.
//
// Two rules hold for everything in this file:
//
//  1. Honest about what happened. The call was cut off by an automated system
//     on the voice service. It was not a dropped connection and not a technical
//     problem on the participant's side, and nothing here may say so: the study
//     answers "no" to deception (docs/irb-phase2-questions-for-nathan.md,
//     Q-SYS2).
//  2. The crisis line is said aloud early, in plain words. The vendor's filter
//     stops generated speech that names self-harm (measured 2026-11-18: a cut
//     landed on a delegated reply asking about "thoughts about hurting yourself
//     or ending your life"), so these lines name the number and nothing else:
//     no restating of the disclosure, no naming of what the line is for.

/** The participant-facing crisis contact fields these lines need. */
export interface RecoveryCrisisContact {
  phone?: string | null;
  text?: string | null;
  enabled?: boolean;
}

export const DEFAULT_RECOVERY_CRISIS_PHONE = '988';
export const DEFAULT_RECOVERY_CRISIS_TEXT = 'HOME to 741741';

/**
 * "call or text 988 at any time, or text HOME to 741741". The national
 * defaults stand in for a disabled or blank contact: a recovery line must
 * never be built without a number in it.
 */
export function recoveryCrisisLinePhrase(contact?: RecoveryCrisisContact | null): string {
  const enabled = contact?.enabled !== false;
  const phone = (enabled && contact?.phone?.trim()) || DEFAULT_RECOVERY_CRISIS_PHONE;
  const text = (enabled && contact?.text?.trim()) || DEFAULT_RECOVERY_CRISIS_TEXT;
  return `call or text ${phone} at any time, or text ${text}`;
}

/**
 * The trusted instruction sent the moment a recovery session reports
 * `session.started`. GPT-Live never speaks unprompted, so this is what makes
 * the assistant come back talking; it carries none of the previous
 * conversation, because restating the disclosure is the most likely way to be
 * cut again.
 */
export function buildRecoverySpeakFirstNudge(contact?: RecoveryCrisisContact | null): string {
  return (
    'The call with this participant was cut off and has just been restored. Speak first, immediately, before the ' +
    'participant says anything. Say this, in the language of this conversation and keeping every part of it: ' +
    `"I'm back. The call got cut off. That was not your fault, and nothing you said was wrong. I'm still here with you. ` +
    `And you can ${recoveryCrisisLinePhrase(contact)}." ` +
    'Do not call it a dropped connection or a technical problem, and do not repeat or ask about what was said before. ' +
    'Then stop and listen.'
  );
}

/**
 * What the browser says aloud (speech synthesis) and shows the instant the
 * call is cut, while the recovery session is still connecting. Short on
 * purpose: it is stopped as soon as the new call is ready to carry audio, and
 * the first sentence has to stand on its own.
 */
export const RECOVERY_INTERIM_SPOKEN_LINE = 'The call was cut off. That was not your fault. Reconnecting now.';
