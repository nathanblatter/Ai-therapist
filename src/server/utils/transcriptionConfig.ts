// Realtime input-transcription config (ai-therapist-166). The gpt-transcribe
// generation accepts context that materially improves fidelity on exactly
// the words this study cannot afford to mishear: crisis vocabulary, campus
// resources, medication names. Legacy models (gpt-4o-*-transcribe, whisper)
// reject these fields, so the payload is model-aware; the whole 4o/whisper
// transcription family shuts down 2027-02-26.
//
// Defaults live here; system_config 'transcription_context' overrides them
// (admin-tunable without a deploy, same spirit as model pinning).

const NEW_TRANSCRIBE_MODELS = /^gpt-(live-)?transcribe/;

export const DEFAULT_TRANSCRIPTION_PROMPT =
  'A supportive mental-health conversation in a university research study between a participant ' +
  'and an AI assistant. Topics may include mood, anxiety, stress, therapy, medications, and campus resources.';

export const DEFAULT_TRANSCRIPTION_KEYWORDS = [
  'CAPS', '988', 'Crisis Text Line', 'self-harm', 'suicidal', 'ideation',
  'therapist', 'psychiatrist', 'counseling',
  'Lexapro', 'Zoloft', 'Prozac', 'Wellbutrin', 'sertraline', 'fluoxetine', 'escitalopram', 'bupropion',
  'PHQ-2', 'GAD-2', 'BYU',
];

export const DEFAULT_TRANSCRIPTION_LANGUAGES = ['en'];

const MAX_KEYWORDS = 50;
const MAX_KEYWORD_CHARS = 60;

/** Enforce the API's keyword constraints: no <, >, CR, LF; bounded count/length. */
export function sanitizeKeywords(keywords: unknown): string[] {
  if (!Array.isArray(keywords)) return [];
  const out: string[] = [];
  for (const raw of keywords) {
    if (typeof raw !== 'string') continue;
    const cleaned = raw.replace(/[<>\r\n]/g, '').trim().slice(0, MAX_KEYWORD_CHARS);
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

export interface TranscriptionContextConfig {
  prompt?: unknown;
  keywords?: unknown;
  languages?: unknown;
}

/** The session.audio.input.transcription payload for a given model. */
export function buildTranscriptionConfig(
  model: string,
  context?: TranscriptionContextConfig | null
): Record<string, unknown> {
  if (!NEW_TRANSCRIBE_MODELS.test(model)) {
    // Legacy models accept only { model } here (plus singular `language`,
    // which we have never sent) — extra fields 400 the session mint.
    return { model };
  }
  const prompt =
    typeof context?.prompt === 'string' && context.prompt.trim()
      ? context.prompt.trim().slice(0, 1000)
      : DEFAULT_TRANSCRIPTION_PROMPT;
  const keywords = sanitizeKeywords(
    Array.isArray(context?.keywords) && context.keywords.length > 0
      ? context.keywords
      : DEFAULT_TRANSCRIPTION_KEYWORDS
  );
  const languages =
    Array.isArray(context?.languages) && context.languages.every(l => typeof l === 'string') && context.languages.length > 0
      ? (context.languages as string[]).slice(0, 5)
      : DEFAULT_TRANSCRIPTION_LANGUAGES;

  return { model, prompt, keywords, languages };
}
