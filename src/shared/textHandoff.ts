// Text hand-off: what happens when the voice vendor ends a GPT-Live session
// (ai-therapist-356, step 1).
//
// OpenAI's voice service ends a session itself when a participant states
// suicidal intent aloud, and that cannot be switched off. Until 2026-11-19 the
// app answered by reconnecting to the same voice service, which was cut again
// the moment the participant repeated themselves; typed chat was only reached
// after two failed reconnections. Now a cut goes straight to typed chat, which
// runs on a pipeline the vendor's voice filter does not end, and the first
// thing on screen is a message this file words.
//
// Shared by the server (which authors and persists the first message), the
// browser (which shows it, speaks the bridge and renders the quick replies)
// and the red-team harness (which asserts all three), so they cannot drift.
//
// Rules every line here keeps:
//
//  1. Honest about what happened (the study answers "no" to deception,
//     docs/irb-phase2-questions-for-nathan.md Q-SYS2). The voice service ended
//     the call. Nothing says a connection dropped, nothing says the call "got
//     cut off" as though by accident, nothing blames the participant's device.
//  2. No promise about people. Nothing says a person is coming, and nothing
//     says staff have been notified: whether an on-call page was sent,
//     delivered or folded into an earlier one is not known when these lines
//     are written (services/crisisPaging.service.ts), and a cut with no risk
//     signal does not page at all.
//  3. The crisis numbers never depend on these lines. The pinned card and the
//     recovery screen carry them from the page already loaded.

/** What the participant's risk in this incident was when the call ended.
 *  `unknown`: it could not be read, or their last words were still being
 *  assessed. Not knowing is not "no risk". */
export type HandoffSeverity = 'none' | 'medium' | 'high' | 'unknown';

/** Why the voice session ended: the vendor's content filter, or its session
 *  ceiling (60 minutes) on a session flagged high. */
export type HandoffReason = 'content' | 'expired';

/**
 * Which first screen the participant gets.
 *
 * The WORDING follows this call only: the voice session that was cut and the
 * sessions explicitly linked to it (its hand-off chats and the voice calls
 * started again from them; db/paging.queries getIncidentChainSessionIds).
 * The participant-wide look-back (any session in the last 2 hours) still
 * decides the chat's FLAG and the paging, but it never puts words in the
 * app's mouth: an ordinary call cut 90 minutes after an earlier high flag
 * must not be told "I heard you" about something not said in it (PR #77
 * review, reproduced live 2026-11-19).
 *
 * - `crisis`: the vendor's filter ended a call in which the participant's own
 *   risk was high (or could not be read). The first message asks about suicide
 *   directly and the screen offers one-tap answers.
 * - `ceiling`: the vendor's time limit ended a call that was flagged high.
 *   Same pinned card and same flagged session, but the wording names the time
 *   limit, and the suicide question is not put again by a canned line: an hour
 *   in, the assistant has already asked it and continues from the transcript.
 * - `checkin`: nothing risky in this call, but the participant was flagged
 *   high (or their risk could not be read) in another session of the
 *   look-back. An open check-in in the style of the time-limit message: no "I
 *   heard you", no canned suicide question, the pinned crisis card, and the
 *   chat flagged from the earlier incident so the model's first reply follows
 *   the safety guidance.
 * - `neutral`: the filter ended a call with no high risk signal (it also stops
 *   the assistant's own words, and ordinary phrases: "wait, stop" during a
 *   breathing exercise on 2026-11-18). The crisis card is still on screen; the
 *   suicide question is not asked by the app.
 */
export type HandoffKind = 'crisis' | 'ceiling' | 'checkin' | 'neutral';

const SEVERITY_RANK: Record<HandoffSeverity, number> = { none: 0, medium: 1, unknown: 2, high: 3 };

/** The higher of two severities ('unknown' ranks above medium, below high). */
export function maxHandoffSeverity(a: HandoffSeverity, b: HandoffSeverity): HandoffSeverity {
  return SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}

/**
 * @param severity the participant's peak risk in THIS call's chain of linked
 *   sessions: decides the wording.
 * @param participantSeverity their peak across all their sessions in the
 *   look-back (it includes the chain): only chooses the check-in over the
 *   neutral wording. Omitted: 'none'.
 */
export function handoffKind(
  reason: HandoffReason,
  severity: HandoffSeverity,
  participantSeverity: HandoffSeverity = 'none',
): HandoffKind {
  if (severity === 'high' || severity === 'unknown') return reason === 'expired' ? 'ceiling' : 'crisis';
  if (participantSeverity === 'high' || participantSeverity === 'unknown') {
    return reason === 'expired' ? 'ceiling' : 'checkin';
  }
  return 'neutral';
}

/** The severity the continuation chat session starts flagged at, or null for
 *  no flag. `unknown` starts high: every later turn is then assessed in
 *  context, and the stamp does not stop a real disclosure from flagging or
 *  paging (see markSessionCrisisContinuation). */
export function handoffStampSeverity(severity: HandoffSeverity): 'high' | 'medium' | null {
  if (severity === 'high' || severity === 'unknown') return 'high';
  if (severity === 'medium') return 'medium';
  return null;
}

/**
 * The first message of a crisis hand-off. The study owner reviewed this
 * wording on 2026-11-18; change it only with him.
 */
export const HANDOFF_CRISIS_FIRST_MESSAGE =
  "I'm still here, and I heard you. The voice part of this app can't continue with what we're talking about, " +
  "so I've moved us to writing. Nothing you said was wrong. Are you thinking about ending your life tonight?";

/** The first message when the vendor's session time limit ended a call that
 *  was flagged high. */
export const HANDOFF_CEILING_FIRST_MESSAGE =
  "I'm still here. The voice call reached the time limit of the voice service, so I've moved us to writing. " +
  'Nothing you said was wrong, and we can keep going right here. How are you doing right now?';

/** Nothing risky in this call, an earlier high flag in the look-back (kind
 *  `checkin`). Worded like the time-limit message: true about what happened,
 *  no claim to have heard anything, an open question. */
export const HANDOFF_CHECKIN_FIRST_MESSAGE =
  "I'm still here. The voice service ended the call, so I've moved us to writing. " +
  'Nothing you said was wrong, and we can keep going right here. How are you doing right now?';

/** No risk signal at all: writing or a new voice call, the participant's choice. */
export const HANDOFF_NEUTRAL_FIRST_MESSAGE =
  'The voice call ended unexpectedly. That came from the voice service, not from anything you did. ' +
  'We can keep going here in writing, or you can start a new voice call.';

/** A medium flag in the incident: the new voice call is not offered until the
 *  assistant's risk check has cleared, so the line does not offer it. Calm
 *  wording (medium is where the false positives are: "wait, stop" during a
 *  breathing exercise, transcribed "would stop", scored 50), ending on an
 *  open question so the screen invites a reply. No quick replies and no
 *  suicide question. Also the line for a no-risk cut where voice is off. */
export const HANDOFF_NEUTRAL_FIRST_MESSAGE_NO_VOICE =
  'The voice call ended unexpectedly. That came from the voice service, not from anything you did. ' +
  "I'm still here, and we can keep going right here in writing. How are you doing right now?";

/** One-tap answers to the question the crisis first message asks. Each is sent
 *  as an ordinary participant message with exactly this text. */
export const HANDOFF_QUICK_REPLIES = ['Yes', 'No', 'Not sure'] as const;

export function handoffFirstMessage(kind: HandoffKind, voiceReturnAllowed: boolean): string {
  if (kind === 'crisis') return HANDOFF_CRISIS_FIRST_MESSAGE;
  if (kind === 'ceiling') return HANDOFF_CEILING_FIRST_MESSAGE;
  if (kind === 'checkin') return HANDOFF_CHECKIN_FIRST_MESSAGE;
  return voiceReturnAllowed ? HANDOFF_NEUTRAL_FIRST_MESSAGE : HANDOFF_NEUTRAL_FIRST_MESSAGE_NO_VOICE;
}

export function handoffQuickReplies(kind: HandoffKind): string[] {
  return kind === 'crisis' ? [...HANDOFF_QUICK_REPLIES] : [];
}

// ---------------------------------------------------------------------------
// Spoken bridge
// ---------------------------------------------------------------------------

/** The crisis contact fields the spoken lines need. */
export interface HandoffCrisisContact {
  phone?: string | null;
  enabled?: boolean;
}

function crisisPhone(contact?: HandoffCrisisContact | null): string {
  return (contact?.enabled !== false && contact?.phone?.trim()) || '988';
}

/**
 * What the browser says aloud (speech synthesis) once the written conversation
 * is on screen, for a participant who was talking and is not looking at their
 * phone. It says where the conversation went and, after a crisis cut, the
 * number. It can be inaudible (iOS with Bluetooth audio, a muted phone), so
 * the screen never relies on it.
 */
export function handoffSpokenBridge(kind: HandoffKind, contact?: HandoffCrisisContact | null): string {
  if (kind === 'neutral') return 'The voice call has ended. We can keep going in writing, on your screen.';
  return (
    "I'm still here. I've moved us to writing, on your screen. " +
    `You can also call or text ${crisisPhone(contact)} at any time.`
  );
}

/** Said when the written conversation could not be opened: the numbers are on
 *  the screen whatever else failed. */
export function handoffFailedSpokenLine(contact?: HandoffCrisisContact | null): string {
  return (
    'The voice call has ended. The crisis line numbers are on your screen. ' +
    `You can call or text ${crisisPhone(contact)} at any time.`
  );
}

// ---------------------------------------------------------------------------
// Return to voice
// ---------------------------------------------------------------------------

/** Shown in the hand-off chat when the server says a voice call is not available yet. */
export const VOICE_RETURN_REFUSED_NOTICE =
  "A voice call isn't available again just yet. We can keep going right here in writing.";

/** Shown in the hand-off chat when the new voice call could not be started:
 *  the chat was not ended and the conversation continues there. */
export const VOICE_RETURN_FAILED_NOTICE =
  "The voice call couldn't be started. We can keep going right here in writing.";

/** risk_check_steps.risk_band values that count as a cleared check. */
const CLEAR_BANDS = new Set(['none', 'low']);

export interface VoiceReturnInput {
  /** Participant's peak risk in THIS call's chain when the call ended. */
  handoffSeverity: HandoffSeverity;
  /** Their peak across all their sessions in the look-back (for example an
   *  earlier high flag elsewhere). High or unknown: a standing no, like the
   *  call's own; medium: the check must clear first. Absent: none. */
  participantSeverity?: HandoffSeverity;
  /** Highest severity the risk assessor gave any participant turn in THIS
   *  chat session ('none' when nothing scored medium or high). */
  chatPeakSeverity: 'none' | 'medium' | 'high';
  /** The assistant's run_risk_check steps in THIS chat session, oldest first. */
  riskCheckSteps: ReadonlyArray<{ step: string; risk_band: string }>;
}

/**
 * May the participant be offered a new voice call from this chat session?
 *
 * Never while risk is high, and never on a guess:
 *
 *  - nothing in the incident and nothing in this chat scored medium or high:
 *    yes, from the first screen (the vendor ended a call that carried no risk
 *    signal);
 *  - any turn in this chat session scored high: no, for the rest of the
 *    session;
 *  - the incident itself was high, or its risk could not be read: no, for the
 *    rest of the session. The voice call this would start is an ordinary one:
 *    unflagged, with no transcript of what was said, on the service that has
 *    just ended a call over it. Checked live on 2026-11-19 (PR #77 review): a
 *    spoken "I want to kill myself" (90), then "No" and "I'm not going to do
 *    anything tonight", and the model logged ideation "low" two turns in, mid
 *    assessment, with the chat still flagged high; the button appeared;
 *  - another of the participant's sessions in the look-back was high, or that
 *    read failed (the check-in): no, for the rest of the session;
 *  - otherwise (a medium signal in the call or in this chat, or a medium flag
 *    in another of the participant's sessions in the look-back): only once
 *    the assistant's risk check has cleared, which means it logged the
 *    ideation question with run_risk_check in this chat session and the band
 *    it gave its most recent logged step is `none` or `low`.
 *
 * The server recomputes this when the new voice call is requested
 * (liveSession.routes.ts); the browser's copy only decides whether the button
 * is drawn.
 */
export function voiceReturnAllowed(input: VoiceReturnInput): boolean {
  if (input.chatPeakSeverity === 'high') return false;
  if (input.handoffSeverity === 'high' || input.handoffSeverity === 'unknown') return false;
  // A high (or unreadable) flag in another of their sessions in the look-back
  // (the check-in): the same standing no. Checked live on 2026-11-19: after
  // the check-in, the model logged ideation "none" with run_risk_check in the
  // same turn in which it first ASKED the question, so "the check has
  // cleared" was true before the participant had answered it.
  const participant = input.participantSeverity ?? 'none';
  if (participant === 'high' || participant === 'unknown') return false;
  const riskSignal =
    input.handoffSeverity !== 'none' ||
    input.chatPeakSeverity !== 'none' ||
    (input.participantSeverity ?? 'none') !== 'none';
  if (!riskSignal) return true;
  const steps = input.riskCheckSteps;
  if (!steps.some((s) => s.step === 'ideation')) return false;
  return CLEAR_BANDS.has(steps[steps.length - 1].risk_band);
}

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

/** `handoff` in the POST /api/chat/start response of a continuation. */
export interface HandoffStartPayload {
  kind: HandoffKind;
  /** Peak risk in this call's chain of linked sessions (decides the wording). */
  severity: HandoffSeverity;
  /** Peak across the participant's sessions in the look-back (decides the flag). */
  participantSeverity?: HandoffSeverity;
  reason: HandoffReason;
  /** One-tap answers to show under the first message; empty for none. */
  quickReplies: string[];
  voiceReturnAllowed: boolean;
  /** Line for the browser to speak aloud. */
  spokenBridge: string;
  /** Every session of this call's chain the chat was seeded from, oldest first. */
  seededFrom: string[];
}
