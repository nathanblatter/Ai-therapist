// Wire protocol between the participant browser and OUR server for a Grok
// Voice session (docs/grok-voice.md). One WebSocket carries both directions:
//
//   binary frames  — raw PCM16 mono audio at GROK_SAMPLE_RATE. Browser -> server
//                    is the microphone; server -> browser is the assistant.
//   text frames    — JSON control messages typed below.
//
// The browser never talks to xAI directly and never sees the API key. It also
// has NO way to steer the model: there is deliberately no "inject" message in
// the client -> server direction, so a participant with devtools open cannot
// rewrite their own therapist's instructions. Every steer (crisis guidance,
// phase nudges, admin messages, the opening preamble) is authored server-side.
// That closes the open item the GPT-Live data channel leaves open, where the
// browser owns a channel that accepts session.instructions.append.

/** PCM16 sample rate on both legs. xAI accepts 8k–48k; 24k matches GPT-Live. */
export const GROK_SAMPLE_RATE = 24_000;

/** Path the browser opens, with the therapy session id appended. */
export const GROK_VOICE_WS_PATH = '/api/grok/voice/';

// ---- browser -> server -----------------------------------------------------

export type GrokClientMessage =
  /** Participant pressed end. The server closes upstream and stops billing. */
  | { type: 'end' }
  /** Microphone toggled. Informational: a muted client simply stops sending frames. */
  | { type: 'mic'; on: boolean };

// ---- server -> browser -----------------------------------------------------

export type GrokServerMessage =
  /** Upstream session configured; audio may now flow. */
  | { type: 'ready'; model: string }
  /**
   * A transcript update. `final: false` carries a delta (assistant speech
   * streams) or, for the participant, an in-progress cumulative text. `final:
   * true` carries the whole turn. `itemId` is stable within a turn.
   */
  | { type: 'transcript'; role: 'user' | 'assistant'; itemId: string; text: string; final: boolean }
  /** Server VAD detected the participant speaking: drop any queued playback. */
  | { type: 'speech_started' }
  /** The server cancelled the assistant's response (interrupt): drop playback. */
  | { type: 'clear_audio' }
  /** A model response finished (spoken or tool-only). */
  | { type: 'response_done' }
  /**
   * The model called a tool. The SERVER executes it; this is UI-only so the
   * browser can open the matching overlay (worksheet, scale, resources…).
   */
  | { type: 'tool_call'; callId: string; name: string; args: Record<string, unknown> }
  /** Upstream reported an error. Not necessarily terminal. */
  | { type: 'error'; message: string; code?: string | null }
  /** The session is over. The browser should run its normal end flow. */
  | { type: 'closed'; reason: string };
