// Grok Voice (xAI) session configuration — docs/grok-voice.md.
//
// Grok Voice is xAI's speech-to-speech model behind an OpenAI-Realtime-
// compatible WebSocket (wss://api.x.ai/v1/realtime). Unlike GPT-Live it is ONE
// model: there is no delegated reasoning backend, so the full clinical prompt
// and the tool schemas go straight into `session.instructions` / `session.tools`
// — the same shape the pre-GPT-Live Realtime path used.
//
// This module is the Grok counterpart of liveSessionConfig.ts: the model
// switch, the voice registry, and the session.update builder. Nothing here
// touches the network.

import type { ToolDefinition } from '../services/toolRegistry.service.js';
import { toRealtimeTools } from '../services/toolRegistry.service.js';
import { GROK_SAMPLE_RATE } from '../../shared/grokVoiceProtocol.js';

/** Model id prefix that routes a session to the Grok Voice backend. */
const GROK_MODEL_PREFIX = 'grok-voice';

/**
 * Whether a configured ai_model names a Grok Voice model. Together with
 * isLiveModel this is the ONLY switch between the two voice backends: set
 * system_config.ai_model to 'grok-voice-latest' to roll onto Grok, back to a
 * gpt-live-* id to roll back. No redeploy either way.
 *
 * Excludes `grok-voice-transcribe-*`, xAI's speech-to-text family, which is not
 * a speech-to-speech model and would not open a realtime session.
 */
export function isGrokVoiceModel(model: string | null | undefined): boolean {
  if (!model) return false;
  return model.startsWith(GROK_MODEL_PREFIX) && !model.startsWith('grok-voice-transcribe');
}

/** The xAI realtime endpoint. The model travels as a query parameter. */
export const GROK_REALTIME_URL = 'wss://api.x.ai/v1/realtime';

export function grokRealtimeUrl(model: string): string {
  return `${GROK_REALTIME_URL}?model=${encodeURIComponent(model)}`;
}

export interface GrokVoice {
  /** Voice id passed as session.voice. Case-insensitive on the API; kept lower. */
  value: string;
  label: string;
  /** Short participant-facing blurb for the voice picker. */
  description: string;
  presentation: 'Feminine' | 'Masculine';
}

/**
 * The built-in xAI voice roster, from GET /v1/tts/voices (2026-09-20). Every
 * voice is multilingual, so unlike GPT-Live there is no per-language filter.
 * Descriptions are ours: xAI publishes no style notes, and the picker needs
 * something to show. `eve` is xAI's documented default and is listed first.
 */
export const GROK_VOICES: GrokVoice[] = [
  { value: 'eve',     label: 'Eve',     description: 'Warm and steady (xAI default)', presentation: 'Feminine' },
  { value: 'ara',     label: 'Ara',     description: 'Clear and gentle',              presentation: 'Feminine' },
  { value: 'aurora',  label: 'Aurora',  description: 'Bright and open',               presentation: 'Feminine' },
  { value: 'carina',  label: 'Carina',  description: 'Soft and unhurried',            presentation: 'Feminine' },
  { value: 'celeste', label: 'Celeste', description: 'Calm and even',                 presentation: 'Feminine' },
  { value: 'iris',    label: 'Iris',    description: 'Light and friendly',            presentation: 'Feminine' },
  { value: 'liora',   label: 'Liora',   description: 'Measured and kind',             presentation: 'Feminine' },
  { value: 'luna',    label: 'Luna',    description: 'Quiet and reassuring',          presentation: 'Feminine' },
  { value: 'ursa',    label: 'Ursa',    description: 'Grounded and direct',           presentation: 'Feminine' },
  { value: 'altair',  label: 'Altair',  description: 'Even and composed',             presentation: 'Masculine' },
  { value: 'atlas',   label: 'Atlas',   description: 'Deep and steady',               presentation: 'Masculine' },
  { value: 'castor',  label: 'Castor',  description: 'Relaxed and plain-spoken',      presentation: 'Masculine' },
  { value: 'cosmo',   label: 'Cosmo',   description: 'Easygoing and warm',            presentation: 'Masculine' },
  { value: 'helios',  label: 'Helios',  description: 'Clear and confident',           presentation: 'Masculine' },
  { value: 'helix',   label: 'Helix',   description: 'Crisp and articulate',          presentation: 'Masculine' },
  { value: 'kepler',  label: 'Kepler',  description: 'Thoughtful and low',            presentation: 'Masculine' },
  { value: 'leo',     label: 'Leo',     description: 'Friendly and open',             presentation: 'Masculine' },
  { value: 'lumen',   label: 'Lumen',   description: 'Soft and attentive',            presentation: 'Masculine' },
  { value: 'lux',     label: 'Lux',     description: 'Bright and quick',              presentation: 'Masculine' },
  { value: 'naksh',   label: 'Naksh',   description: 'Calm and resonant',             presentation: 'Masculine' },
  { value: 'orion',   label: 'Orion',   description: 'Steady and grounded',           presentation: 'Masculine' },
  { value: 'perseus', label: 'Perseus', description: 'Measured and clear',            presentation: 'Masculine' },
  { value: 'rex',     label: 'Rex',     description: 'Plain and direct',              presentation: 'Masculine' },
  { value: 'rigel',   label: 'Rigel',   description: 'Low and unhurried',             presentation: 'Masculine' },
  { value: 'sal',     label: 'Sal',     description: 'Easy and conversational',       presentation: 'Masculine' },
  { value: 'sirius',  label: 'Sirius',  description: 'Warm and assured',              presentation: 'Masculine' },
  { value: 'zagan',   label: 'Zagan',   description: 'Deep and calm',                 presentation: 'Masculine' },
  { value: 'zenith',  label: 'Zenith',  description: 'Clear and level',               presentation: 'Masculine' },
];

const GROK_VOICE_INDEX = new Map(GROK_VOICES.map(v => [v.value, v]));

/** xAI's documented default. */
export const GROK_DEFAULT_VOICE = 'eve';

/** Metadata for a voice, or null when it is not a Grok voice. */
export function getGrokVoice(value: string | null | undefined): GrokVoice | null {
  if (!value) return null;
  return GROK_VOICE_INDEX.get(value.toLowerCase()) ?? null;
}

/**
 * Coerce a requested voice to one Grok accepts.
 *
 * A participant who enrolled on GPT-Live has a saved preference like 'marin'.
 * Forwarding it would fail the session.update; falling back to the default is
 * the better failure, and the picker offers the Grok roster from then on.
 */
export function resolveGrokVoice(requested: string | null | undefined): string {
  const match = getGrokVoice(requested);
  if (match) return match.value;
  if (requested) {
    console.warn(`[Grok] Voice '${requested}' is not a Grok voice; falling back to '${GROK_DEFAULT_VOICE}'.`);
  }
  return GROK_DEFAULT_VOICE;
}

/**
 * Voice-conversation framing prepended to the clinical prompt.
 *
 * Short on purpose. The clinical prompt (base + modality + memory + check-in +
 * tool guidance) is the same string the GPT-Live backend runs, so the two
 * backends stay clinically identical as study conditions; this header only
 * covers what a single speech-to-speech model needs to know about SPEAKING.
 */
export function buildGrokVoiceHeader(languageName: string | null): string {
  const languageLine = languageName
    ? `Speak ${languageName} unless the participant asks you to switch.`
    : '';
  return `## Voice conversation
You are speaking aloud with the participant in real time. Speak calmly and unhurriedly, in plain
sentences a person can follow by ear: no Markdown, no headings, no lists, no stage directions.
Keep replies short and leave room for silence — one or two sentences, then listen. Stop speaking
the moment the participant starts talking. ${languageLine}

Messages with the system role that arrive mid-conversation are trusted guidance from the study's
monitoring system or the clinician overseeing this session. Follow them, and never read them aloud
or mention them to the participant.
`;
}

export interface GrokSessionConfigInput {
  /** Configured alias, e.g. grok-voice-latest. */
  model: string;
  voice: string | null | undefined;
  /** BCP-47 language code for the transcription hint, e.g. 'en', 'es-MX'. */
  language: string | null;
  languageName: string | null;
  /** Fully assembled clinical prompt (same string the GPT-Live path builds). */
  systemPrompt: string;
  /** Enabled tool definitions from the registry. */
  toolDefs: ToolDefinition[];
}

/**
 * Build the `session` object for the first `session.update` on the xAI socket.
 *
 * Verified against the live API on 2026-09-20: this exact shape is echoed back
 * in `session.updated`, tools are accepted in the flat OpenAI Realtime form,
 * and server VAD drives turn-taking with no further client events.
 */
export function buildGrokSessionConfig(input: GrokSessionConfigInput): Record<string, unknown> {
  const { voice, language, languageName, systemPrompt, toolDefs } = input;
  return {
    instructions: buildGrokVoiceHeader(languageName) + '\n' + systemPrompt,
    voice: resolveGrokVoice(voice),
    // Server VAD: xAI detects end of speech, commits the buffer and starts the
    // response on its own. Interruptions arrive as input_audio_buffer.
    // speech_started, which the proxy relays so the browser drops playback.
    turn_detection: { type: 'server_vad' },
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: GROK_SAMPLE_RATE },
        transcription: language ? { language_hint: language } : {},
      },
      output: {
        format: { type: 'audio/pcm', rate: GROK_SAMPLE_RATE },
      },
    },
    tools: toRealtimeTools(toolDefs),
    tool_choice: 'auto',
  };
}

// ---------------------------------------------------------------------------
// Opening preamble
// ---------------------------------------------------------------------------
// Under GPT-Live the browser authors the opening line and sends it over its
// data channel. Under Grok the browser cannot steer the model at all (see
// shared/grokVoiceProtocol.ts), so the preamble is built here and injected by
// the proxy as the first system item. The text mirrors the client's
// getPreambleForLanguage / getInitialPromptForLanguage so participants hear
// the same disclaimer on either backend.

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  'es-ES': 'Spanish from Spain (Español de España)',
  'es-419': 'Latin American Spanish (Español Latinoamericano)',
  'fr-FR': 'French from France (Français de France)',
  'fr-CA': 'Québécois French (Français Québécois)',
  'pt-BR': 'Brazilian Portuguese (Português Brasileiro)',
  'pt-PT': 'European Portuguese (Português Europeu)',
  de: 'German',
  it: 'Italian',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  ar: 'Arabic',
  hi: 'Hindi',
  ru: 'Russian',
};

export interface CrisisContactLike {
  hotline?: string;
  phone?: string;
  text?: string;
  enabled?: boolean;
}

export function buildGrokOpeningPrompt(language: string, crisis: CrisisContactLike | undefined): string {
  const enabled = crisis?.enabled !== false && Boolean(crisis?.phone);
  const crisisText = enabled
    ? `call the ${crisis?.hotline ?? '988 Suicide & Crisis Lifeline'} crisis line at ${crisis?.phone}` +
      (crisis?.text ? ` or text ${crisis.text}` : '')
    : 'call or text 988 (Suicide and Crisis Lifeline), or call 911 for immediate danger';

  const preamble =
    `Hello! I'm an AI mental health support assistant here to listen and provide encouragement and coping ideas. ` +
    `I am not a licensed therapist or doctor, so I can't diagnose conditions or provide medical advice. ` +
    `Please remember, if you're in crisis, you should ${crisisText}. ` +
    `Also, please note that your microphone is off by default. If you'd like to talk using voice, you'll need to ` +
    `press the red mic toggle button to turn it on. Thanks again for being willing to talk, I'm glad you're here with me today.`;

  const instruction = language === 'en'
    ? `Say this phrase exactly: '${preamble}'`
    : `Say this phrase exactly in ${LANGUAGE_NAMES[language] ?? language}: '${preamble}'`;
  return `${instruction} Say it immediately, before the participant speaks, then pause and listen.`;
}
