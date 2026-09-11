// GPT-Live session configuration (gpt-live-1).
//
// GPT-Live splits one Realtime prompt into two. The LIVE model owns speaking
// behaviour only — tone, pace, backchannels, interruptions, and when to hand
// work to the backend. The BACKEND (Responses delegation) owns the clinical
// content: the full therapy system prompt, the modality appendix, the
// participant's check-in and memory, and the tool schemas.
//
// This split is not cosmetic. The live model has a small context window and the
// prompting guide is explicit that copying a long Realtime prompt wholesale into
// `session.instructions` degrades it. Keeping the clinical prompt in the backend
// also means the therapy content keeps running on a model we pin ourselves
// (system_config.live_backend_model) independently of the voice model.

import type { ToolDefinition } from '../services/toolRegistry.service.js';

/** Model id prefix that routes a session to the GPT-Live backend. */
const LIVE_MODEL_PREFIX = 'gpt-live';

/**
 * Whether a configured ai_model names a GPT-Live voice model. This is the ONLY
 * switch between the Realtime and Live paths — set system_config.ai_model to
 * 'gpt-live-1' to roll forward, back to a gpt-realtime-* id to roll back.
 *
 * Deliberately excludes `gpt-live-transcribe`, which is a transcription model
 * for the Realtime/chained pipeline, not a full-duplex voice model.
 */
export function isLiveModel(model: string | null | undefined): boolean {
  if (!model) return false;
  return model.startsWith(LIVE_MODEL_PREFIX) && !model.startsWith('gpt-live-transcribe');
}

export interface LiveVoice {
  /** API name passed as audio.output.voice. */
  value: string;
  label: string;
  /** Short participant-facing blurb for the voice picker. */
  description: string;
  language: 'English' | 'Portuguese';
  /**
   * Speaking style, not a guarantee of accent fidelity — the docs are explicit
   * that "regional influence describes a voice's speaking style".
   */
  accent: string;
  presentation: 'Feminine' | 'Masculine';
  /**
   * 'natural' voices are derived from a human recording; 'generated' ones are
   * synthesised. Worth recording for the study: voice naturalness plausibly
   * affects therapeutic alliance, so it is a variable an analyst may want.
   */
  source: 'natural' | 'generated';
  /** true for the twelve voices the GPT-Live docs list explicitly. */
  liveNative: boolean;
}

/**
 * The twelve voices introduced with GPT-Live, verbatim from the session guide's
 * voice table. Ordered by language then accent so the picker groups sensibly.
 */
export const LIVE_NATIVE_VOICES: LiveVoice[] = [
  { value: 'gleam',    label: 'Gleam',    description: 'Bright and clear',        language: 'English',    accent: 'North American', presentation: 'Feminine',  source: 'natural',   liveNative: true },
  { value: 'meridian', label: 'Meridian', description: 'Even and grounded',       language: 'English',    accent: 'North American', presentation: 'Masculine', source: 'natural',   liveNative: true },
  { value: 'delta',    label: 'Delta',    description: 'Warm Southern lilt',      language: 'English',    accent: 'Southern U.S.',  presentation: 'Feminine',  source: 'generated', liveNative: true },
  { value: 'cinder',   label: 'Cinder',   description: 'Low and unhurried',       language: 'English',    accent: 'Southern U.S.',  presentation: 'Masculine', source: 'generated', liveNative: true },
  { value: 'vesper',   label: 'Vesper',   description: 'Measured and British',    language: 'English',    accent: 'British',        presentation: 'Masculine', source: 'natural',   liveNative: true },
  { value: 'willow',   label: 'Willow',   description: 'Soft and Irish',          language: 'English',    accent: 'Irish',          presentation: 'Feminine',  source: 'natural',   liveNative: true },
  { value: 'stone',    label: 'Stone',    description: 'Steady and Irish',        language: 'English',    accent: 'Irish',          presentation: 'Masculine', source: 'natural',   liveNative: true },
  { value: 'quartz',   label: 'Quartz',   description: 'Crisp and Australian',    language: 'English',    accent: 'Australian',     presentation: 'Feminine',  source: 'generated', liveNative: true },
  { value: 'ripple',   label: 'Ripple',   description: 'Relaxed and Australian',  language: 'English',    accent: 'Australian',     presentation: 'Masculine', source: 'natural',   liveNative: true },
  { value: 'beacon',   label: 'Beacon',   description: 'Open and Filipino',       language: 'English',    accent: 'Filipino',       presentation: 'Masculine', source: 'generated', liveNative: true },
  { value: 'bossa',    label: 'Bossa',    description: 'Brazilian Portuguese',    language: 'Portuguese', accent: 'Brazilian',      presentation: 'Feminine',  source: 'natural',   liveNative: true },
  { value: 'tempo',    label: 'Tempo',    description: 'Brazilian Portuguese',    language: 'Portuguese', accent: 'Brazilian',      presentation: 'Masculine', source: 'natural',   liveNative: true },
];

/**
 * Voices carried over from the Realtime voice set.
 *
 * The session guide calls its twelve "additional voice options" and names
 * `marin` — a Realtime voice — as the GPT-Live default, so the original set is
 * still accepted. They are kept separate from the native list because that is
 * an inference from two documented facts rather than an explicit compatibility
 * statement, and because it matters for the study: participants who already
 * chose one of these keep their voice across the migration instead of being
 * silently reassigned mid-enrollment.
 */
export const LIVE_LEGACY_VOICES: LiveVoice[] = [
  { value: 'marin',   label: 'Marin',   description: 'Clear and professional', language: 'English', accent: 'North American', presentation: 'Feminine',  source: 'natural',   liveNative: false },
  { value: 'cedar',   label: 'Cedar',   description: 'Warm and natural',       language: 'English', accent: 'North American', presentation: 'Masculine', source: 'natural',   liveNative: false },
  { value: 'alloy',   label: 'Alloy',   description: 'Neutral and balanced',   language: 'English', accent: 'North American', presentation: 'Feminine',  source: 'generated', liveNative: false },
  { value: 'ash',     label: 'Ash',     description: 'Clear and articulate',   language: 'English', accent: 'North American', presentation: 'Masculine', source: 'generated', liveNative: false },
  { value: 'ballad',  label: 'Ballad',  description: 'Smooth and melodic',     language: 'English', accent: 'British',        presentation: 'Masculine', source: 'generated', liveNative: false },
  { value: 'coral',   label: 'Coral',   description: 'Gentle and friendly',    language: 'English', accent: 'North American', presentation: 'Feminine',  source: 'generated', liveNative: false },
  { value: 'echo',    label: 'Echo',    description: 'Warm and approachable',  language: 'English', accent: 'North American', presentation: 'Masculine', source: 'generated', liveNative: false },
  { value: 'sage',    label: 'Sage',    description: 'Calm and soothing',      language: 'English', accent: 'North American', presentation: 'Feminine',  source: 'generated', liveNative: false },
  { value: 'shimmer', label: 'Shimmer', description: 'Bright and energetic',   language: 'English', accent: 'North American', presentation: 'Feminine',  source: 'generated', liveNative: false },
  { value: 'verse',   label: 'Verse',   description: 'Dynamic and expressive', language: 'English', accent: 'North American', presentation: 'Masculine', source: 'generated', liveNative: false },
];

/** Every voice GPT-Live accepts, native first. */
export const LIVE_VOICES: LiveVoice[] = [...LIVE_NATIVE_VOICES, ...LIVE_LEGACY_VOICES];

const LIVE_VOICE_INDEX = new Map(LIVE_VOICES.map(v => [v.value, v]));

/** The documented GPT-Live default. */
export const LIVE_DEFAULT_VOICE = 'marin';

/** Metadata for a voice, or null when it is not a GPT-Live voice. */
export function getLiveVoice(value: string | null | undefined): LiveVoice | null {
  if (!value) return null;
  return LIVE_VOICE_INDEX.get(value) ?? null;
}

/**
 * Coerce a requested voice to one GPT-Live will accept.
 *
 * An unrecognised voice would otherwise be forwarded to OpenAI and 400 the
 * whole session creation, which the participant experiences as "the session
 * won't start" with no explanation. Falling back is the better failure.
 */
export function resolveLiveVoice(requested: string | null | undefined): string {
  if (requested && LIVE_VOICE_INDEX.has(requested)) return requested;
  if (requested) {
    console.warn(`[Live] Voice '${requested}' is not available on GPT-Live; falling back to '${LIVE_DEFAULT_VOICE}'.`);
  }
  return LIVE_DEFAULT_VOICE;
}

/**
 * Voices appropriate for a spoken language.
 *
 * Bossa and Tempo are Portuguese voices; offering them for an English session
 * (or the English voices for a Brazilian Portuguese one) produces a noticeably
 * wrong accent. Returns everything when the language has no dedicated voices,
 * since a mismatched-but-present voice beats an empty picker.
 */
export function liveVoicesForLanguage(languageCode: string | null | undefined): LiveVoice[] {
  const isPortuguese = typeof languageCode === 'string' && languageCode.startsWith('pt');
  const wanted = isPortuguese ? 'Portuguese' : 'English';
  const matches = LIVE_VOICES.filter(v => v.language === wanted);
  return matches.length > 0 ? matches : LIVE_VOICES;
}

/** Default backend reasoning model for Responses delegation. */
export const LIVE_DEFAULT_BACKEND_MODEL = 'gpt-5.6-terra';

/**
 * Conversation-layer instructions for the live voice model.
 *
 * Follows the structure the prompting guide prescribes: role and tone, then
 * backchannel policy, then interruption policy, then a delegation policy with
 * the three required labels. Everything clinical is deliberately absent — it
 * lives in the backend prompt below.
 *
 * The one substantive addition over the starter template is the safety line.
 * A crisis disclosure must never sit waiting on a backend round-trip, so the
 * live model is told to stay present and respond itself while it delegates,
 * rather than going quiet. The actual crisis handling still runs server-side
 * through runCrisisPipeline and arrives as session.instructions.append.
 */
export function buildLiveInstructions(opts: {
  languageName?: string | null;
  toolNames: string[];
}): string {
  const { languageName, toolNames } = opts;

  const languageLine = languageName
    ? `Speak ${languageName} unless the participant asks you to switch.\n`
    : '';

  // Describe backend CAPABILITIES, not tool call syntax — the guide is explicit
  // that these lines tell the live model what help is available, and are not
  // instructions for it to invoke anything itself.
  const capabilities: string[] = [
    '- Therapeutic response: reflective listening, and guidance grounded in the session\'s active approach.',
  ];
  if (toolNames.includes('find_worksheet')) {
    capabilities.push('- Worksheets and exercises: find and present a structured exercise that fits what the participant is working on.');
  }
  if (toolNames.some(n => n.startsWith('administer_scale') || n.includes('scale'))) {
    capabilities.push('- Brief measures: administer a short standardized questionnaire when it is clinically indicated.');
  }
  if (toolNames.includes('display_session_recap')) {
    capabilities.push('- Session recap: assemble a summary of what was covered.');
  }
  if (toolNames.includes('end_session')) {
    capabilities.push('- Ending the session: close the session when the participant is ready to finish.');
  }

  return `You are a warm, attentive voice companion in a research study on AI support for mental health.
Speak calmly and unhurriedly, in plain language. Be genuine and grounded, not chirpy or clinical.
Leave room for silence. If the participant is upset, acknowledge it plainly before anything else.
${languageLine}
Backchannel policy: Use moderate backchannels. Acknowledge naturally without competing with the participant.

Interruption policy: Stop speaking the moment the participant interrupts, and listen. Never talk over them.

Delegation policy:
Backend tools:
${capabilities.join('\n')}

Delegate to the backend when:
- The participant describes something they are working through and needs a substantive therapeutic response.
- The participant asks for an exercise, a worksheet, a summary, or to end the session.
- A correction changes work already in progress.

Do not delegate to the backend when:
- The participant greets you, makes small talk, or asks you to repeat something you just said.
- You need one brief clarifying question to understand what they mean.

Delegate before giving an answer that depends on backend work. Do not guess the result while waiting.
While the backend is working, stay present with the participant — keep listening and reflecting rather than going silent.

If the participant expresses thoughts of suicide, self-harm, or harming someone else, stay with them and respond
directly yourself. Do not wait for the backend before acknowledging what they said. Take it seriously, do not
minimize it, and do not change the subject.`;
}

/**
 * Backend (Responses delegation) instructions. This is where the existing
 * therapy system prompt goes, wrapped with the voice-transcript framing the
 * delegation guide recommends and a contract for what to return.
 *
 * `systemPrompt` is the fully assembled prompt the Realtime path would have
 * used — base prompt + modality + proactive-offering arm + language addition +
 * tool guidance + memory block + check-in block — so both channels run
 * clinically identical content.
 */
export function buildLiveBackendInstructions(systemPrompt: string): string {
  return `## Voice conversation context
You are the reasoning backend for a live spoken therapy conversation. A separate voice model is
talking with the participant and hands you requests that need substantive work.

Transcripts arrive from speech recognition. They contain mistakes, unfinished phrases, filler, and
later corrections. Use the most recent context and prefer the participant's own corrections over
earlier text. If a detail that matters clinically is unclear, say so and name the detail to ask
about rather than guessing at it.

${systemPrompt}

## Return the result
Return what the voice model needs to continue the conversation, and nothing more. Write for someone
who will speak your words aloud: plain sentences, no Markdown, no headings, no bullet lists, no
stage directions. Keep it to a few sentences unless the participant asked for something longer.

Never claim an action has happened before the tool result confirms it. If a tool fails, say what
failed and what the participant can do next.`;
}

/**
 * Conversation instructions for a session resumed after OpenAI's content filter
 * terminated the previous one.
 *
 * Observed 2026-09-11: a participant said "I wanna kill myself", the assistant
 * began "Hey, I'm really glad you told me", and the platform cut the session
 * mid-sentence. The right response is to come straight back and stay with them —
 * not to hang up, and not to silently change the subject.
 *
 * This prompt is deliberately NARROWER than the normal one. The filter fires on
 * generated content, so the way to avoid being cut off a second time is to keep
 * the assistant short, warm, and oriented on one concrete action — calling or
 * texting 988 — rather than exploring the disclosure in detail. That is also
 * what the safety protocol wants at this risk level, so the constraint and the
 * clinical goal point the same way.
 *
 * Crucially it does NOT restate what the participant said. Echoing the
 * disclosure back into a new session is the most likely way to trip the same
 * filter again.
 */
export function buildLiveRecoveryInstructions(opts: { languageName?: string | null; crisisLine: string }): string {
  const languageLine = opts.languageName ? `Speak ${opts.languageName}.\n` : '';
  return `You are a warm, steady voice companion. You were just talking with this person and the
connection dropped for a moment. You are back now.
${languageLine}
What is happening: they are going through something serious and may be having thoughts of suicide or
self-harm. Your only job right now is to stay with them and help them reach real human help.

How to speak:
- Short replies. One or two sentences, then stop and listen.
- Warm and calm. Never clinical, never alarmed, never scripted.
- Reconnect first: acknowledge briefly that you got cut off and that you are still here.
- Do not ask them to repeat what they already told you. You remember that it was serious.

What to do, every few turns and whenever there is an opening:
- Encourage them to call or text ${opts.crisisLine} right now, and offer to stay with them while they do it.
- Ask if there is someone who could be with them in person tonight.
- If they say they are in immediate danger, tell them plainly to call 911 or go to the nearest
  emergency room.

What NOT to do:
- Do not discuss methods, means, plans, or specifics of self-harm in any way.
- Do not ask for graphic detail about what they are thinking of doing.
- Do not lecture, moralize, or tell them how they should feel.
- Do not promise confidentiality or make clinical claims.
- Do not go silent. If you are unsure what to say, say that you are still here.

Delegation policy: do not delegate. Answer directly and immediately. Nothing matters more right now
than staying present in this conversation.`;
}

export interface LiveSessionConfigInput {
  model: string;
  voice: string | null | undefined;
  languageName: string | null;
  /** Fully assembled clinical prompt (same string the Realtime path builds). */
  systemPrompt: string;
  /** Enabled tool definitions from the registry. */
  toolDefs: ToolDefinition[];
  backendModel: string;
  /** Prior conversation to seed, oldest first. Trimmed to the API's limits. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /**
   * Let OpenAI store this session's recording, which is what makes it forkable.
   *
   * MUST stay false for real participant sessions: storage means vendor-side
   * retention of session audio, which participant consent does not cover. It is
   * enabled only for non-study sessions (demo, sandbox, simulated) so the
   * counterfactual fork harness has something to branch from. The caller is
   * responsible for passing the session's is_demo determination; the
   * counterfactual service re-checks it independently before forking.
   */
  storable?: boolean;
  /**
   * Resume after OpenAI's content filter terminated the previous session.
   *
   * Swaps in the narrower crisis-recovery conversation prompt and disables
   * delegation: at this moment the assistant must answer immediately and stay
   * present, not hand off to a backend and go quiet. Deliberately carries NO
   * conversation history — replaying the disclosure that tripped the filter is
   * the most likely way to be terminated again.
   */
  recovery?: { crisisLine: string };
}

/**
 * Project registry tool definitions into the Responses function schema that
 * `delegation.responses.tools` expects.
 *
 * Note the shape difference from the Realtime projection in toolRegistry: the
 * Responses API nests nothing, but it does require `strict` to be explicitly
 * present alongside `parameters`. Registry-only metadata (e.g. `channel`) must
 * never be forwarded — an unknown parameter 400s the whole session creation,
 * which is the ai-therapist-124 failure mode repeating in a new place.
 */
export function toLiveDelegationTools(defs: ToolDefinition[]): Array<Record<string, unknown>> {
  return defs.map(d => ({
    type: 'function',
    name: d.name,
    description: d.description,
    parameters: d.parameters,
    strict: false,
  }));
}

// Startup history limits from the session guide.
const MAX_HISTORY_MESSAGES = 128;
const MAX_HISTORY_CHARS = 24_000; // ~8k tokens at the usual 3 chars/token heuristic

/**
 * Build the `session` object for POST /v1/live/sessions.
 *
 * Deliberately omits `audio.format`: WebRTC negotiates its own format through
 * SDP and rejects the field. Also omits any transcription config — GPT-Live
 * transcribes both sides itself and emits session.*_transcript.delta, so there
 * is no audio.input.transcription block to configure.
 */
export function buildLiveSessionConfig(input: LiveSessionConfigInput): Record<string, unknown> {
  const { model, voice, languageName, systemPrompt, toolDefs, backendModel, history, storable, recovery } = input;

  const session: Record<string, unknown> = {
    model,
    instructions: recovery
      ? buildLiveRecoveryInstructions({ languageName, crisisLine: recovery.crisisLine })
      : buildLiveInstructions({
          languageName,
          toolNames: toolDefs.map(t => t.name),
        }),
    audio: {
      output: { voice: resolveLiveVoice(voice) },
    },
    // Recovery runs in CLIENT delegation mode with no backend wired up, which
    // in practice means the voice model answers entirely on its own. That is
    // the point: a Responses round trip introduces a pause, and going quiet on
    // someone who just disclosed suicidal intent is the exact failure we are
    // recovering from. It also removes the tools, which have no place here.
    delegation: recovery ? { type: 'client' } : {
      type: 'responses',
      responses: {
        model: backendModel,
        instructions: buildLiveBackendInstructions(systemPrompt),
        tools: toLiveDelegationTools(toolDefs),
        tool_choice: 'auto',
        // Sequential tool calls. Several of our tools mutate session state
        // (end_session, scale administration) and the delegation guide
        // recommends starting here; parallel calls would let the backend
        // request an end_session alongside work that assumes the session is
        // still open.
        parallel_tool_calls: false,
      },
    },
    // Storage means OpenAI retains this session's audio for 30 days, and is
    // what makes a session forkable. Participant consent does not cover
    // vendor-side retention, so this is false for every real session and true
    // ONLY for non-study ones (demo, sandbox, simulated), which is what gives
    // the counterfactual fork harness something to branch from.
    store: storable === true,
  };

  // OPEN ITEM — frontend data-channel permissions.
  //
  // Because the browser owns the WebRTC data channel, it can send client events
  // directly to the session, including `session.instructions.append` — which is
  // the trusted-application-instruction channel. A participant with devtools
  // could therefore steer their own therapist. Under the Realtime API the
  // equivalent hole existed (`conversation.item.create` with role system), so
  // this is not a regression, but instructions.append is the stronger lever.
  //
  // The docs reference "frontend client permissions" and "frontend data-channel
  // permissions" as a real WebRTC session concept — the fork section states
  // that WebRTC forks preserve them and WebSocket forks discard them — but no
  // guide documents the field name or its shape. Guessing an unknown key here
  // would be rejected as an unknown configuration field and 400 the entire
  // handshake, taking voice sessions down.
  //
  // Until that field is documented, the mitigation is architectural rather than
  // configured: every safety-relevant instruction (crisis steering, minor
  // safeguard, phase guidance, wind-down) is authored and delivered SERVER-side
  // over the sideband, so a tampered client cannot suppress them — only add
  // noise alongside them. Revisit and lock the channel down as soon as the
  // permissions schema is published.

  // Recovery sessions carry NO history, unconditionally — even if a caller
  // passes some. Replaying the disclosure that tripped the content filter into
  // the replacement session is the most likely way to be terminated again,
  // which would mean hanging up on someone in crisis twice. Enforced here
  // rather than trusted to every call site.
  return finalizeSession(session, recovery ? undefined : history);
}

/** Attach optional startup history to a built session config. */
function finalizeSession(
  session: Record<string, unknown>,
  history: LiveSessionConfigInput['history'],
): Record<string, unknown> {

  if (history && history.length > 0) {
    const trimmed: Array<Record<string, unknown>> = [];
    let chars = 0;
    // Walk newest-first so trimming drops the OLDEST turns, then restore order.
    for (let i = history.length - 1; i >= 0 && trimmed.length < MAX_HISTORY_MESSAGES; i--) {
      const msg = history[i];
      if (!msg.content) continue;
      chars += msg.content.length;
      if (chars > MAX_HISTORY_CHARS) break;
      trimmed.unshift({
        type: 'message',
        role: msg.role,
        content: [
          msg.role === 'assistant'
            ? { type: 'output_text', text: msg.content }
            : { type: 'input_text', text: msg.content },
        ],
      });
    }
    if (trimmed.length > 0) session.input = trimmed;
  }

  return session;
}
