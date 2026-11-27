// Staff notices for a voice session that has gone quiet (ai-therapist-313,
// 315, 293). The server already detects these, re-prompts the model and
// broadcasts to admins; until now nothing in the admin app listened, so the
// only trace was a system row in the session's messages.
//
// Two kinds:
//   - a prompt was sent and the session may recover on its own (transient:
//     the banner clears itself);
//   - the prompts did not work, or the opening was never spoken (persistent:
//     the participant is hearing silence or reading a fallback; the banner
//     stays until staff dismiss it).

export const VOICE_SILENCE_EVENTS = [
  'live:opening-silent',
  'live:opening-unspoken',
  'live:steer-silent',
  'live:steer-unresolved',
  'live:recovery-silent',
  'live:quiet-check-in',
] as const;

export type VoiceSilenceEvent = (typeof VOICE_SILENCE_EVENTS)[number];

export interface VoiceNotice {
  sessionId: string;
  event: VoiceSilenceEvent;
  message: string;
  /** Stays until dismissed; never replaced by a transient notice. */
  persistent: boolean;
}

/** How long a transient notice stays up. */
export const VOICE_NOTICE_TRANSIENT_MS = 20_000;

function seconds(ms: unknown): string {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? `${Math.round(ms / 1000)} s` : 'a while';
}

function count(n: unknown): number | null {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
}

/** The notice for one broadcast, or null when the payload names no session. */
export function voiceSilenceNotice(event: VoiceSilenceEvent, data: unknown): VoiceNotice | null {
  const d = (data ?? {}) as Record<string, unknown>;
  const sessionId = typeof d.sessionId === 'string' ? d.sessionId : '';
  if (!sessionId) return null;
  const after = seconds(d.afterMs);
  const attempt = count(d.attempt);
  const attemptText = attempt ? ` (attempt ${attempt})` : '';
  switch (event) {
    case 'live:opening-silent':
      return {
        sessionId,
        event,
        persistent: false,
        message:
          d.sent === false
            ? `Voice session has not spoken its opening after ${after}, and the opening could not be re-sent.`
            : `Voice session has not spoken its opening after ${after}. The opening was re-sent.`,
      };
    case 'live:opening-unspoken':
      return {
        sessionId,
        event,
        persistent: true,
        message: `Voice opening was not spoken within ${after}. Its text was shown on the participant's screen instead.`,
      };
    case 'live:steer-silent':
      return {
        sessionId,
        event,
        persistent: false,
        message: `Voice assistant went quiet for ${after} after a safety steer. It was prompted to speak${attemptText}.`,
      };
    case 'live:steer-unresolved': {
      const prompts = count(d.prompts);
      const sent = prompts === null ? '' : ` (${prompts} ${prompts === 1 ? 'prompt' : 'prompts'} to speak sent)`;
      return {
        sessionId,
        event,
        persistent: true,
        message: `Voice assistant has said nothing for ${after} after a safety steer${sent}. The participant is hearing silence.`,
      };
    }
    case 'live:recovery-silent':
      return {
        sessionId,
        event,
        persistent: false,
        message: `Crisis recovery voice session has not spoken after ${after}. The speak-first instruction was re-sent${attemptText}.`,
      };
    case 'live:quiet-check-in':
      return {
        sessionId,
        event,
        persistent: false,
        message:
          d.sent === false
            ? `Participant has been quiet for ${after} after a safety question, and the check-in could not be sent.`
            : `Participant has been quiet for ${after} after a safety question. The voice assistant was asked to check in.`,
      };
  }
}

/** Which notice the banner shows after a new one arrives: a persistent notice
 *  is only ever replaced by another persistent one, so a later "prompt sent"
 *  for some other session cannot hide "participant is hearing silence". */
export function nextVoiceNotice(current: VoiceNotice | null, incoming: VoiceNotice | null): VoiceNotice | null {
  if (!incoming) return current;
  if (current?.persistent && !incoming.persistent) return current;
  return incoming;
}
