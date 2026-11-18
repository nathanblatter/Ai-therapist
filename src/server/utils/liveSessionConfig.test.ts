import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const logMock = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('./logger.js', () => ({ createLogger: () => logMock }));

import {
  isLiveModel,
  resolveLiveVoice,
  liveVoicesForLanguage,
  buildLiveSessionConfig,
  toLiveDelegationTools,
  getLiveVoice,
  LIVE_DEFAULT_VOICE,
  LIVE_DEFAULT_BACKEND_MODEL,
  LIVE_VOICES,
  resolveBackendReasoningEffort,
} from './liveSessionConfig.js';
import type { ToolDefinition } from '../services/toolRegistry.service.js';

const CLINICAL_PROMPT = 'CLINICAL_PROMPT_SENTINEL: you are a supportive therapist.';

const TOOL_DEFS: ToolDefinition[] = [
  {
    name: 'find_worksheet',
    description: 'Find a worksheet',
    parameters: { type: 'object', properties: { topic: { type: 'string' } }, required: [] },
  } as unknown as ToolDefinition,
];

function build(overrides: Partial<Parameters<typeof buildLiveSessionConfig>[0]> = {}) {
  return buildLiveSessionConfig({
    model: 'gpt-live-1',
    voice: 'marin',
    languageName: null,
    systemPrompt: CLINICAL_PROMPT,
    toolDefs: TOOL_DEFS,
    backendModel: LIVE_DEFAULT_BACKEND_MODEL,
    ...overrides,
  });
}

beforeEach(() => {
  logMock.warn.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isLiveModel', () => {
  it('is true for the GPT-Live voice model', () => {
    expect(isLiveModel('gpt-live-1')).toBe(true);
  });

  it('is FALSE for gpt-live-transcribe (a transcription model, not full duplex)', () => {
    expect(isLiveModel('gpt-live-transcribe')).toBe(false);
    expect(isLiveModel('gpt-live-transcribe-latest')).toBe(false);
  });

  it('is FALSE for Realtime model ids (that is the rollback path)', () => {
    expect(isLiveModel('gpt-realtime')).toBe(false);
    expect(isLiveModel('gpt-realtime-2025-08-28')).toBe(false);
  });

  it('is false for null / undefined / empty', () => {
    expect(isLiveModel(null)).toBe(false);
    expect(isLiveModel(undefined)).toBe(false);
    expect(isLiveModel('')).toBe(false);
  });
});

describe('resolveLiveVoice', () => {
  it('preserves a known native voice', () => {
    expect(resolveLiveVoice('meridian')).toBe('meridian');
  });

  it('preserves a known legacy (carried-over Realtime) voice', () => {
    expect(resolveLiveVoice('cedar')).toBe('cedar');
  });

  it('falls back to marin for an unknown voice rather than 400-ing session creation', () => {
    expect(resolveLiveVoice('nonexistent-voice')).toBe(LIVE_DEFAULT_VOICE);
    expect(LIVE_DEFAULT_VOICE).toBe('marin');
  });

  it('falls back for null / undefined without warning', () => {
    expect(resolveLiveVoice(null)).toBe('marin');
    expect(resolveLiveVoice(undefined)).toBe('marin');
    expect(logMock.warn).not.toHaveBeenCalled();
  });
});

describe('getLiveVoice', () => {
  it('returns metadata for a known voice and null otherwise', () => {
    expect(getLiveVoice('bossa')).toMatchObject({ language: 'Portuguese', liveNative: true });
    expect(getLiveVoice('marin')).toMatchObject({ language: 'English', liveNative: false });
    expect(getLiveVoice('not-a-voice')).toBeNull();
    expect(getLiveVoice(null)).toBeNull();
  });
});

describe('liveVoicesForLanguage', () => {
  it("returns only the Portuguese voices for 'pt-BR'", () => {
    const voices = liveVoicesForLanguage('pt-BR');
    expect(voices.map((v) => v.value).sort()).toEqual(['bossa', 'tempo']);
    expect(voices.every((v) => v.language === 'Portuguese')).toBe(true);
  });

  it('returns only English voices for English and for an unknown language code', () => {
    for (const code of ['en-US', 'de-DE', null, undefined]) {
      const voices = liveVoicesForLanguage(code);
      expect(voices.every((v) => v.language === 'English')).toBe(true);
      expect(voices.map((v) => v.value)).not.toContain('bossa');
    }
  });

  it('never returns an empty picker', () => {
    expect(liveVoicesForLanguage('pt').length).toBeGreaterThan(0);
    expect(LIVE_VOICES.length).toBeGreaterThan(0);
  });
});

describe('buildLiveSessionConfig', () => {
  it('puts the clinical prompt in delegation.responses.instructions, NOT top-level instructions', () => {
    const session = build();

    const delegation = session.delegation as { responses: { instructions: string; model: string } };
    expect(delegation.responses.instructions).toContain(CLINICAL_PROMPT);
    expect(delegation.responses.model).toBe(LIVE_DEFAULT_BACKEND_MODEL);

    // The live model's own instructions cover speaking behaviour only.
    expect(session.instructions as string).not.toContain(CLINICAL_PROMPT);
    expect(session.instructions as string).toMatch(/Delegation policy/);
  });

  it('omits audio.format (WebRTC negotiates its own) and configures only the voice', () => {
    const session = build({ voice: 'vesper' });
    const audio = session.audio as Record<string, unknown>;

    expect(audio).toEqual({ output: { voice: 'vesper' } });
    expect(audio).not.toHaveProperty('format');
    expect(audio.output).not.toHaveProperty('format');
    expect(audio).not.toHaveProperty('input');
  });

  it('coerces an unknown voice through resolveLiveVoice', () => {
    const session = build({ voice: 'not-a-voice' });
    expect((session.audio as { output: { voice: string } }).output.voice).toBe('marin');
  });

  it('never stores participant audio on the OpenAI side', () => {
    expect(build().store).toBe(false);
  });

  it('configures sequential delegated tool calls with tool_choice auto', () => {
    const delegation = build().delegation as {
      type: string;
      responses: { tool_choice: string; parallel_tool_calls: boolean; tools: Array<Record<string, unknown>> };
    };
    expect(delegation.type).toBe('responses');
    expect(delegation.responses.tool_choice).toBe('auto');
    expect(delegation.responses.parallel_tool_calls).toBe(false);
    expect(delegation.responses.tools).toEqual([
      {
        type: 'function',
        name: 'find_worksheet',
        description: 'Find a worksheet',
        parameters: TOOL_DEFS[0].parameters,
        strict: false,
      },
    ]);
  });

  it('omits session.input when there is no history', () => {
    expect(build()).not.toHaveProperty('input');
    expect(build({ history: [] })).not.toHaveProperty('input');
  });

  it('seeds history oldest-first with the right content types', () => {
    const session = build({
      history: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
    });
    expect(session.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] },
    ]);
  });

  it('trims the OLDEST history turns when the char budget is exceeded', () => {
    const history = Array.from({ length: 40 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `${i}:${'x'.repeat(1000)}`,
    }));
    const input = build({ history }).input as Array<{ content: Array<{ text: string }> }>;

    expect(input.length).toBeLessThan(history.length);
    // The most recent turn survives; the oldest is what got dropped.
    expect(input[input.length - 1].content[0].text.startsWith('39:')).toBe(true);
    expect(input[0].content[0].text.startsWith('0:')).toBe(false);
  });

  it('adds a language line to the live instructions when a language is set', () => {
    expect(build({ languageName: 'Brazilian Portuguese' }).instructions as string).toMatch(
      /Speak Brazilian Portuguese unless/,
    );
    expect(build({ languageName: null }).instructions as string).not.toMatch(
      /unless the participant asks you to switch/,
    );
  });
});

describe('buildLiveSessionConfig psychoeducation cue (ai-therapist-202)', () => {
  const withRag: ToolDefinition[] = [
    ...TOOL_DEFS,
    {
      name: 'retrieve_psychoeducation',
      description: 'Retrieve passages',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    } as unknown as ToolDefinition,
  ];

  it('voice-layer instructions are unchanged when the cue is off', () => {
    const off = build({ toolDefs: withRag }).instructions as string;
    expect(off).toBe(build({ toolDefs: withRag, psychoeducationCue: false }).instructions);
    expect(off).not.toMatch(/Psychoeducation/);
    expect(off).not.toMatch(/what a condition is/);
  });

  it('cue arm adds one capability line and one delegate line', () => {
    const on = build({ toolDefs: withRag, psychoeducationCue: true }).instructions as string;
    expect(on).toContain(
      '- Psychoeducation: look up vetted explanations of a condition, a feeling, or how a technique or therapy works.',
    );
    expect(on).toContain(
      '- The participant asks what a condition is, why they might feel a certain way, or how a technique or therapy works.\n- A correction changes work already in progress.',
    );
  });

  it('cue arm adds nothing when the tool is not enabled', () => {
    expect(build({ psychoeducationCue: true }).instructions).toBe(build().instructions);
  });
});

describe('buildLiveSessionConfig lead conversation (features.lead_conversation_enabled)', () => {
  const backendOf = (s: Record<string, unknown>) =>
    ((s.delegation as Record<string, unknown>).responses as Record<string, unknown>).instructions;

  it('flag off: voice layer and backend identical to omitting the option', () => {
    const off = build({ leadConversation: false });
    expect(off.instructions).toBe(build().instructions);
    expect(backendOf(off)).toBe(backendOf(build()));
    expect(off.instructions as string).not.toMatch(/Guide the conversation/);
    expect(off.instructions as string).not.toMatch(/stalled reply/);
  });

  it('flag on: adds one speaking line and one delegate line, nothing else', () => {
    const on = build({ leadConversation: true }).instructions as string;
    const off = build().instructions as string;
    expect(on).toContain(
      'acknowledge it plainly before anything else.\nGuide the conversation: after greetings, help the participant name what they want to focus on today, and keep it moving with one specific follow-up at a time rather than only acknowledging. If they are upset or raise anything about their safety, follow them instead.\n',
    );
    expect(on).toContain(
      '- The participant gives a short or stalled reply ("I don\'t know", "not much") and the conversation needs a next step.\n- A correction changes work already in progress.',
    );
    const removed = on
      .replace(/Guide the conversation:[^\n]*\n/, '')
      .replace(/- The participant gives a short or stalled reply[^\n]*\n/, '');
    expect(removed).toBe(off);
    // The suicide/self-harm instruction is still the last paragraph, untouched.
    expect(on.endsWith('minimize it, and do not change the subject.')).toBe(true);
  });

  it('recovery ignores the flag', () => {
    const recovery = { crisisLine: '988' };
    expect(build({ recovery, leadConversation: true }).instructions).toBe(build({ recovery }).instructions);
  });
});

describe('backend reasoning effort (system_config.live_backend_reasoning_effort)', () => {
  type Delegation = { responses: Record<string, unknown> };

  it('sends no reasoning block when unset, so merge-time sessions are unchanged', () => {
    const responses = (build().delegation as Delegation).responses;
    expect(responses).not.toHaveProperty('reasoning');
  });

  it('forwards a configured effort to the delegated backend', () => {
    const responses = (build({ backendModel: 'gpt-6.1-terra', backendReasoningEffort: 'low' }).delegation as Delegation)
      .responses;
    expect(responses.reasoning).toEqual({ effort: 'low' });
    expect(responses.model).toBe('gpt-6.1-terra');
  });

  it('never adds reasoning to a recovery session (client delegation)', () => {
    const config = build({ backendReasoningEffort: 'low', recovery: { crisisLine: '988' } });
    expect(config.delegation).toEqual({ type: 'client' });
  });

  it('resolves only recognised efforts, case-insensitively', () => {
    expect(resolveBackendReasoningEffort(undefined, 'gpt-6.1-terra')).toBeNull();
    expect(resolveBackendReasoningEffort('', 'gpt-6.1-terra')).toBeNull();
    expect(resolveBackendReasoningEffort('fast', 'gpt-6.1-terra')).toBeNull();
    expect(resolveBackendReasoningEffort({ effort: 'low' }, 'gpt-6.1-terra')).toBeNull();
    expect(resolveBackendReasoningEffort(' Low ', 'gpt-6.1-terra')).toBe('low');
  });

  it("keeps 'none' where the model supports it and raises it to 'low' where it does not", () => {
    expect(resolveBackendReasoningEffort('none', 'gpt-6.1-terra')).toBe('none');
    expect(resolveBackendReasoningEffort('none', 'gpt-5.6-terra')).toBe('none');
    // GPT-6 guide, Limitations: Astra and 6.1 Sol reject `none`.
    expect(resolveBackendReasoningEffort('none', 'gpt-6.1-sol')).toBe('low');
    expect(resolveBackendReasoningEffort('none', 'gpt-6-astra')).toBe('low');
  });

  it('sends nothing to a backend the registry marks as non-reasoning, and says so', () => {
    // A reasoning block on gpt-4.1 is rejected by GPT-Live asynchronously
    // (responses_validation_failed), i.e. every delegation of the session
    // fails while session start looks healthy.
    logMock.warn.mockClear();
    expect(resolveBackendReasoningEffort('low', 'gpt-4.1')).toBeNull();
    expect(resolveBackendReasoningEffort('low', 'gpt-4o-mini')).toBeNull();
    expect(logMock.warn).toHaveBeenCalled();
  });

  it('logs an unrecognised or mistyped effort instead of dropping it silently', () => {
    logMock.warn.mockClear();
    expect(resolveBackendReasoningEffort('lo', 'gpt-6.1-terra')).toBeNull();
    expect(resolveBackendReasoningEffort(1, 'gpt-6.1-terra')).toBeNull();
    expect(logMock.warn).toHaveBeenCalledTimes(2);
    logMock.warn.mockClear();
    expect(resolveBackendReasoningEffort(undefined, 'gpt-6.1-terra')).toBeNull();
    expect(resolveBackendReasoningEffort(null, 'gpt-6.1-terra')).toBeNull();
    expect(logMock.warn).not.toHaveBeenCalled();
  });
});

describe('toLiveDelegationTools', () => {
  it('never forwards registry-only metadata that would 400 session creation', () => {
    const defs = [
      {
        name: 'end_session',
        description: 'End it',
        parameters: { type: 'object', properties: {} },
        channel: 'realtime',
        handler: () => undefined,
      } as unknown as ToolDefinition,
    ];

    const [tool] = toLiveDelegationTools(defs);
    expect(Object.keys(tool).sort()).toEqual(['description', 'name', 'parameters', 'strict', 'type']);
  });
});
